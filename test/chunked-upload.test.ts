import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildServer } from "../src/server.js";
import { config } from "../src/config.js";
import { removeDataDir, makeDataDir, restoreConfig, useApiKeys } from "./helpers.js";

let app: FastifyInstance;
let dir: string;
const headers = { "x-api-key": "test-key", "content-type": "application/json" };
async function start(size = 6, extra = {}) {
  return app.inject({ method: "POST", url: "/api/uploads", headers, payload: JSON.stringify({ filename: "video.mp4", size, ttl: 3600, ...extra }) });
}
async function chunk(id: string, offset: number, body = "abc", key = "test-key") {
  return app.inject({ method: "PUT", url: `/api/uploads/${id}?offset=${offset}`, headers: { "x-api-key": key, "content-type": "application/octet-stream" }, payload: body });
}
async function complete(id: string) {
  return app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers });
}
beforeEach(async () => {
  dir = await makeDataDir(); useApiKeys("test-key", "second-key");
  app = await buildServer(); await app.ready();
});
afterEach(async () => { await app.close(); await removeDataDir(dir); restoreConfig(); });

describe("chunked uploads", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/api/uploads", payload: '{}' });
    expect(res.statusCode).toBe(401);
  });
  it("stages chunks privately and publishes only an exact complete file", async () => {
    const init = await start(); expect(init.statusCode).toBe(201);
    const { upload_id: id, chunk_size } = init.json(); expect(chunk_size).toBe(8 * 1024 * 1024);
    expect((await chunk(id, 0)).json().offset).toBe(3);
    expect((await app.inject({ url: "/api/files", headers })).json().items).toHaveLength(0);
    expect((await complete(id)).statusCode).toBe(409);
    expect((await chunk(id, 3, "def")).json().offset).toBe(6);
    const done = await complete(id); expect(done.statusCode).toBe(200);
    const body = done.json(); expect(body.size_bytes).toBe(6); expect(body.filename).toBe("video.mp4");
    expect(await readFile(path.join(dir, body.id), "utf8")).toBe("abcdef");
    expect((await complete(id)).json()).toEqual(body);
    expect((await readdir(path.join(dir, ".uploads")))).toHaveLength(0);
  });
  it("retries identical chunks without appending twice and rejects conflicting data/offsets", async () => {
    const { upload_id: id } = (await start()).json();
    expect((await chunk(id, 3)).statusCode).toBe(409);
    expect((await chunk(id, 0)).statusCode).toBe(200);
    expect((await chunk(id, 0)).json().offset).toBe(3);
    expect((await chunk(id, 0, "xyz")).statusCode).toBe(409);
    expect((await chunk(id, 2)).statusCode).toBe(409);
    expect((await chunk(id, -1)).statusCode).toBe(400);
    expect((await chunk(id, 3, "defg")).statusCode).toBe(413);
    expect((await chunk(id, 3, "def")).statusCode).toBe(200);
  });
  it("isolates sessions between credentials", async () => {
    const { upload_id: id } = (await start()).json();
    expect((await chunk(id, 0, "abc", "second-key")).statusCode).toBe(404);
    expect((await chunk("unknown", 0)).statusCode).toBe(404);
  });
  it("validates size, filenames, ttl and JSON limits", async () => {
    for (const size of [-1, 0, 1.5, "6", Number.MAX_SAFE_INTEGER + 1]) expect((await start(size as number)).statusCode).toBe(400);
    expect((await start(6, { filename: "../video.mp4" })).statusCode).toBe(400);
    expect((await start(6, { ttl: -1 })).statusCode).toBe(400);
    config.maxJsonBodyBytes = 16;
    expect((await start()).statusCode).toBe(413);
  });
  it("bounds each chunk and permits recovery after an oversized request", async () => {
    const { upload_id: id } = (await start(9 * 1024 * 1024)).json();
    expect((await chunk(id, 0, "x".repeat(8 * 1024 * 1024 + 1))).statusCode).toBe(413);
    expect((await chunk(id, 0)).json().offset).toBe(3);
  });
  it("cancels incomplete uploads and cleans staged data", async () => {
    const { upload_id: id } = (await start()).json(); await chunk(id, 0);
    expect((await app.inject({ method: "DELETE", url: `/api/uploads/${id}`, headers })).statusCode).toBe(200);
    expect((await chunk(id, 3)).statusCode).toBe(404);
    expect(await readdir(path.join(dir, ".uploads"))).toHaveLength(0);
  });
  it("publishes into the requested folder and rejects unknown folders", async () => {
    const folder = (await app.inject({ method: "POST", url: "/api/folders", headers, payload: '{"name":"videos"}' })).json();
    const { upload_id: id } = (await start(3, { folder_id: folder.id })).json();
    await chunk(id, 0);
    const done = (await complete(id)).json();
    const listed = (await app.inject({ url: `/api/files?folder_id=${folder.id}`, headers })).json().items;
    expect(listed.map((f: { id: string }) => f.id)).toEqual([done.id]);
    expect((await start(3, { folder_id: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });
});
