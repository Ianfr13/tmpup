import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FolderError,
  createFolder,
  createFolderFromZip,
  deleteFolder,
  getFolderInfo,
  parseZipEntries,
  setFileFolder,
  uploadZipToFolder,
  zipFolder,
} from "../src/folders.js";
import { config } from "../src/config.js";
import { FileMetadata, fileMetaDict, getFilePaths } from "../src/storage.js";
import { makeDataDir, removeDataDir, restoreConfig } from "./helpers.js";

let dataDir = "";

function zipOf(files: Record<string, string>): Uint8Array {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(files)) {
    encoded[name] = new TextEncoder().encode(text);
  }
  return zipSync(encoded);
}

async function writeFileInFolder(folderId: string, filename: string, body: string): Promise<string> {
  const fileId = randomUUID();
  const { filePath, metadataPath } = getFilePaths(fileId);
  await fsp.writeFile(filePath, body);
  await new FileMetadata(
    fileId,
    filename,
    0,
    Date.now() / 1000,
    0,
    0,
    null,
    null,
    Buffer.byteLength(body),
    folderId,
  ).save(metadataPath);
  return fileId;
}

beforeEach(async () => {
  dataDir = await makeDataDir();
});

afterEach(async () => {
  await removeDataDir(dataDir);
  restoreConfig();
});

describe("folders", () => {
  it("creates a folder and lists it as empty", async () => {
    const folder = await createFolder("campanha-maio");
    expect(folder.name).toBe("campanha-maio");
    expect(folder.file_count).toBe(0);
    expect(folder.download_url).toContain(`/api/folders/${folder.id}/download`);
    const info = await getFolderInfo(folder.id);
    expect(info?.id).toBe(folder.id);
  });

  it("rejects duplicate names case-insensitively and invalid names", async () => {
    await createFolder("Ads");
    await expect(createFolder("ads")).rejects.toMatchObject({ statusCode: 409 });
    await expect(createFolder("../x")).rejects.toBeInstanceOf(FolderError);
    await expect(createFolder("a/b")).rejects.toBeInstanceOf(FolderError);
    await expect(createFolder("")).rejects.toBeInstanceOf(FolderError);
  });

  it("extracts a zip into independent files and zips them back", async () => {
    const { folder, files } = await createFolderFromZip("pack", zipOf({ "a.txt": "aaa", "b.txt": "bbb" }));
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.filename).sort()).toEqual(["a.txt", "b.txt"]);
    expect(files.every((f) => f.folder_id === folder.id)).toBe(true);
    expect((await getFolderInfo(folder.id))?.file_count).toBe(2);

    const zipped = await zipFolder(folder.id);
    expect(zipped.fileCount).toBe(2);
    expect(zipped.filename).toBe("pack.zip");
    const unpacked = unzipSync(zipped.bytes);
    expect(new TextDecoder().decode(unpacked["a.txt"])).toBe("aaa");
    expect(new TextDecoder().decode(unpacked["b.txt"])).toBe("bbb");
  });

  it("rejects zip-slip and absolute paths before writing", async () => {
    expect(() => parseZipEntries(zipOf({ "../secret.txt": "x" }))).toThrow(/Invalid path in zip/);
    expect(() => parseZipEntries(zipOf({ "/etc/passwd": "x" }))).toThrow(/Invalid path in zip/);
    const names = await fsp.readdir(dataDir);
    expect(names).toEqual([]);
  });

  it("flattens nested zip paths and aborts on basename collision", async () => {
    expect(() => parseZipEntries(zipOf({ "dir/a.txt": "one", "other/a.txt": "two" }))).toThrow(
      /Duplicate filename in folder/,
    );
    const entries = parseZipEntries(zipOf({ "dir/only.txt": "ok" }));
    expect(entries[0]?.filename).toBe("only.txt");
  });

  it("does not write anything when a zip collides with an existing file", async () => {
    const folder = await createFolder("keep");
    await writeFileInFolder(folder.id, "a.txt", "old");
    await expect(uploadZipToFolder(folder.id, zipOf({ "a.txt": "new", "b.txt": "bb" }))).rejects.toThrow(
      /Duplicate filename in folder/,
    );
    const info = await getFolderInfo(folder.id);
    expect(info?.file_count).toBe(1);
    const names = await fsp.readdir(dataDir);
    expect(names.filter((n) => !n.endsWith(".meta.json") && !n.endsWith(".folder.json"))).toHaveLength(1);
  });

  it("delete folder removes members and leaves root files", async () => {
    const folder = await createFolder("gone");
    const insideId = await writeFileInFolder(folder.id, "in.txt", "in");
    const rootId = randomUUID();
    const root = getFilePaths(rootId);
    await fsp.writeFile(root.filePath, "root");
    await new FileMetadata(rootId, "root.txt", 0, Date.now() / 1000, 0, 0, null, null, 4).save(root.metadataPath);

    const result = await deleteFolder(folder.id);
    expect(result.deleted).toBe(true);
    expect(result.files_deleted).toBe(1);
    expect(await getFolderInfo(folder.id)).toBeNull();
    expect(await fileMetaDict(FileMetadata.fromDict({
      file_id: rootId,
      filename: "root.txt",
      ttl: 0,
      created_at: Date.now() / 1000,
    }))).toMatchObject({ filename: "root.txt", folder_id: null });
    await expect(fsp.access(getFilePaths(insideId).filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.access(root.filePath)).resolves.toBeUndefined();
  });

  it("moves a file into a folder and back to root", async () => {
    const folder = await createFolder("box");
    const fileId = randomUUID();
    const paths = getFilePaths(fileId);
    await fsp.writeFile(paths.filePath, "x");
    await new FileMetadata(fileId, "x.txt", 0, Date.now() / 1000, 0, 0, null, null, 1).save(paths.metadataPath);

    const moved = await setFileFolder(fileId, folder.id);
    expect(moved?.folder_id).toBe(folder.id);
    const back = await setFileFolder(fileId, null);
    expect(back?.folder_id).toBeNull();
  });

  it("refuses to zip an empty folder", async () => {
    const folder = await createFolder("empty");
    await expect(zipFolder(folder.id)).rejects.toMatchObject({ statusCode: 400, message: "Folder is empty" });
  });

  it("rejects zip whose uncompressed size exceeds the upload limit", () => {
    const previous = config.maxMcpUploadSize;
    config.maxMcpUploadSize = 4;
    try {
      expect(() => parseZipEntries(zipOf({ "a.txt": "hello" }))).toThrow(/uncompressed size/);
    } finally {
      config.maxMcpUploadSize = previous;
    }
  });

  it("exposes folder_id on the public file dict", async () => {
    const meta = new FileMetadata("id1", "a.txt", 0, Date.now() / 1000);
    const dict = await fileMetaDict(meta);
    expect(dict.folder_id).toBeNull();
  });
});
