import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FolderError,
  createFolder,
  createFolderFromZip,
  deleteFolder,
  getFolderInfo,
  listFolders,
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

async function writeFileInFolder(
  folderId: string,
  filename: string,
  body: string,
  createdAt = Date.now() / 1000,
  ttl = 0,
): Promise<string> {
  const fileId = randomUUID();
  const { filePath, metadataPath } = getFilePaths(fileId);
  await fsp.writeFile(filePath, body);
  await new FileMetadata(
    fileId,
    filename,
    ttl,
    createdAt,
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

  it("tracks updated_at as greatest created_at of active members or folder created_at when none", async () => {
    const folder = await createFolder("activity");
    expect(folder.updated_at).toBe(folder.created_at);

    const now = Math.floor(Date.now() / 1000);
    const t1 = now - 100;
    const t2 = now - 80;
    const tExpired = now - 50;

    await writeFileInFolder(folder.id, "f1.txt", "one", t1);
    const info1 = await getFolderInfo(folder.id);
    expect(info1?.updated_at).toBe(t1);

    await writeFileInFolder(folder.id, "f2.txt", "two", t2);
    const info2 = await getFolderInfo(folder.id);
    expect(info2?.updated_at).toBe(t2);

    // Expired file with higher created_at than t2: should be ignored
    await writeFileInFolder(folder.id, "expired.txt", "exp", tExpired, 10);
    const info3 = await getFolderInfo(folder.id);
    expect(info3?.updated_at).toBe(t2);
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

  it("scans file metadata once per listFolders call rather than once per folder", async () => {
    const f1 = await createFolder("folder-1");
    const f2 = await createFolder("folder-2");
    const f3 = await createFolder("folder-3");

    await writeFileInFolder(f1.id, "file1.txt", "aaa");
    await writeFileInFolder(f2.id, "file2.txt", "bbbb");
    await writeFileInFolder(f3.id, "file3.txt", "ccccc");

    const spy = vi.spyOn(FileMetadata, "fromFile");
    try {
      const page = await listFolders();
      expect(page.items).toHaveLength(3);
      // 3 file sidecars in total: single scan reads each sidecar once, not 3 folders x 3 files = 9
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns root stats for active files with no folder, consistent across pages and ignoring expired", async () => {
    const f1 = await createFolder("f1");
    const f2 = await createFolder("f2");

    // File in folder: should NOT count towards root
    await writeFileInFolder(f1.id, "nested.txt", "1234567890");

    const now = Math.floor(Date.now() / 1000);

    // Active files in root
    const root1 = randomUUID();
    const p1 = getFilePaths(root1);
    await fsp.writeFile(p1.filePath, "hello");
    await new FileMetadata(root1, "hello.txt", 0, now, 0, 0, null, null, 5).save(p1.metadataPath);

    const root2 = randomUUID();
    const p2 = getFilePaths(root2);
    await fsp.writeFile(p2.filePath, "world!");
    await new FileMetadata(root2, "world.txt", 0, now, 0, 0, null, null, 6).save(p2.metadataPath);

    // Expired file in root: should NOT count towards root
    const rootExp = randomUUID();
    const pExp = getFilePaths(rootExp);
    await fsp.writeFile(pExp.filePath, "expired");
    await new FileMetadata(rootExp, "exp.txt", 10, now - 100, 0, 0, null, null, 7).save(pExp.metadataPath);

    config.pageSize = 1;

    const page1 = await listFolders(1);
    expect(page1.root).toEqual({
      file_count: 2,
      total_size_bytes: 11,
    });
    expect(page1.items).toHaveLength(1);
    expect(page1.total_pages).toBe(2);

    const page2 = await listFolders(2);
    expect(page2.root).toEqual({
      file_count: 2,
      total_size_bytes: 11,
    });
    expect(page2.items).toHaveLength(1);
  });

  it("computes root and folder total_size_bytes for legacy sidecars without size_bytes via stat fallback", async () => {
    const now = Date.now() / 1000;
    const writeLegacy = async (id: string, name: string, body?: string, folderId?: string) => {
      const p = getFilePaths(id);
      if (body !== undefined) await fsp.writeFile(p.filePath, body);
      await fsp.writeFile(
        p.metadataPath,
        JSON.stringify({ file_id: id, filename: name, ttl: 0, created_at: now, folder_id: folderId }),
      );
      return p;
    };

    const modernId = randomUUID();
    const modernP = getFilePaths(modernId);
    await fsp.writeFile(modernP.filePath, "modern");
    await new FileMetadata(modernId, "modern.txt", 0, now, 0, 0, null, null, 6).save(modernP.metadataPath);

    const rootId = randomUUID();
    const rootP = await writeLegacy(rootId, "root.txt", "legacy-root");
    const folder = await createFolder("legacy-folder");
    const memberId = randomUUID();
    const memberP = await writeLegacy(memberId, "member.txt", "legacy-member", folder.id);
    const missingId = randomUUID();
    const missingP = await writeLegacy(missingId, "missing.txt");

    const statCalls: string[] = [];
    const origStat = fsp.stat;
    const statSpy = vi.spyOn(fsp, "stat").mockImplementation(async (target, ...args) => {
      statCalls.push(String(target));
      return origStat(target, ...args);
    });

    const logged: Array<Record<string, unknown>> = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      try {
        logged.push(JSON.parse(String(msg)));
      } catch {}
    });

    try {
      const listing = await listFolders();
      expect(listing.root.total_size_bytes).toBe(6 + 11);
      expect(listing.root.file_count).toBe(3);
      expect(listing.items[0]?.total_size_bytes).toBe(13);
      expect(statCalls).toEqual(expect.arrayContaining([rootP.filePath, memberP.filePath, missingP.filePath]));
      expect(statCalls).not.toContain(modernP.filePath);

      const statFailed = logged.filter((e) => e.event === "file_stat_failed");
      expect(statFailed).toEqual([
        expect.objectContaining({ svc: "tmpup", event: "file_stat_failed", file_id: missingId, err: expect.any(String) }),
      ]);

      const folderInfo = await getFolderInfo(folder.id);
      expect(folderInfo?.total_size_bytes).toBe(13);
    } finally {
      statSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
