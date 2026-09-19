import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authHeader, buildAuthenticatedServer, makeDataDir, removeDataDir, restoreConfig } from "./helpers.js";

let dataDir = "";
let app: Awaited<ReturnType<typeof buildAuthenticatedServer>>;

function zipOf(files: Record<string, string>): Buffer {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(files)) {
    encoded[name] = new TextEncoder().encode(text);
  }
  return Buffer.from(zipSync(encoded));
}

beforeEach(async () => {
  dataDir = await makeDataDir();
  app = await buildAuthenticatedServer();
});

afterEach(async () => {
  await app.close();
  await removeDataDir(dataDir);
  restoreConfig();
});

describe("folder REST routes", () => {
  it("creates, lists, uploads zip, filters files, downloads, and deletes", async () => {
    let res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: JSON.stringify({ name: "campanha" }),
    });
    expect(res.statusCode).toBe(200);
    const folder = res.json() as { id: string; name: string };
    expect(folder.name).toBe("campanha");

    res = await app.inject({
      method: "POST",
      url: `/api/folders/${folder.id}/upload`,
      headers: { ...authHeader(), "x-ttl": "0" },
      payload: zipOf({ "a.txt": "hello", "b.txt": "world" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toHaveLength(2);

    res = await app.inject({
      method: "GET",
      url: `/api/files?folder_id=${folder.id}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);

    res = await app.inject({
      method: "GET",
      url: "/api/files?folder_id=root",
      headers: authHeader(),
    });
    expect(res.json().items).toHaveLength(0);

    res = await app.inject({
      method: "GET",
      url: `/api/folders/${folder.id}/download`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/zip");
    const unpacked = unzipSync(res.rawPayload);
    expect(new TextDecoder().decode(unpacked["a.txt"])).toBe("hello");

    res = await app.inject({
      method: "DELETE",
      url: `/api/folders/${folder.id}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().files_deleted).toBe(2);

    res = await app.inject({
      method: "GET",
      url: `/api/folders/${folder.id}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("uploads a file into a folder via X-Folder-Id and moves it back", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: JSON.stringify({ name: "box" }),
    });
    const folderId = created.json().id as string;

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: {
        ...authHeader(),
        "x-filename": "note.txt",
        "x-ttl": "0",
        "x-folder-id": folderId,
      },
      payload: Buffer.from("hi"),
    });
    expect(uploaded.statusCode).toBe(200);
    const fileId = uploaded.json().id as string;

    const listed = await app.inject({
      method: "GET",
      url: `/api/files?folder_id=${folderId}`,
      headers: authHeader(),
    });
    expect(listed.json().items.some((f: { id: string }) => f.id === fileId)).toBe(true);

    const moved = await app.inject({
      method: "PATCH",
      url: `/api/files/${fileId}`,
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: JSON.stringify({ folder_id: null }),
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().folder_id).toBeNull();
  });

  it("returns 409 on duplicate folder name", async () => {
    const headers = { ...authHeader(), "content-type": "application/json" };
    await app.inject({ method: "POST", url: "/api/folders", headers, payload: JSON.stringify({ name: "dup" }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers,
      payload: JSON.stringify({ name: "DUP" }),
    });
    expect(res.statusCode).toBe(409);
  });

  it("serves HTML viewers for video and pdf and redirects other types", async () => {
    const video = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { ...authHeader(), "x-filename": "clip.mp4", "x-ttl": "0" },
      payload: Buffer.from("fake-mp4"),
    });
    const videoId = video.json().id as string;
    const videoView = await app.inject({
      method: "GET",
      url: `/v/${videoId}/clip.mp4`,
      headers: authHeader(),
    });
    expect(videoView.statusCode).toBe(200);
    expect(videoView.body).toContain("<video");

    const pdf = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { ...authHeader(), "x-filename": "doc.pdf", "x-ttl": "0" },
      payload: Buffer.from("%PDF-fake"),
    });
    const pdfId = pdf.json().id as string;
    const pdfView = await app.inject({
      method: "GET",
      url: `/v/${pdfId}/doc.pdf`,
      headers: authHeader(),
    });
    expect(pdfView.statusCode).toBe(200);
    expect(pdfView.body).toContain("viewer-pdf");

    const txt = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { ...authHeader(), "x-filename": "notes.txt", "x-ttl": "0" },
      payload: Buffer.from("hi"),
    });
    const txtId = txt.json().id as string;
    const txtView = await app.inject({
      method: "GET",
      url: `/v/${txtId}/notes.txt`,
      headers: authHeader(),
    });
    expect(txtView.statusCode).toBe(307);
  });
});
