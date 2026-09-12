/**
 * Route-level tests, ported 1:1 from test_app.py (REST endpoints, transfer
 * routes, thumbnails, listing/pagination, MCP setup and page shell).
 *
 * Harness mapping (see docs/PORT-SPEC.md):
 *   - autouse isolate_data_dir fixture -> makeDataDir() in beforeEach
 *   - auth_client fixture (monkeypatched API_KEYS) -> buildAuthenticatedServer()
 *     plus the x-api-key header from authHeader()
 *   - fastapi.HTTPException -> HttpError from src/errors.ts
 *   - TestClient -> app.inject() (inject never follows redirects)
 *
 * Adaptations (Python/library specific, documented instead of weakened):
 *   - _file_meta_dict is async in the port (fs/promises), so fileMetaDict is
 *     awaited; the Python helper was synchronous.
 *   - PIL image fixtures are produced with sharp.
 *   - test_thumbnail_second_attempt_uses_fail_cache: PIL cannot decode SVG, so
 *     Python used a valid SVG to force a generation failure. sharp does decode
 *     SVG, so the fixture is undecodable image bytes with an image filename;
 *     the failure path (and therefore the .thumb.fail cache) is identical.
 *   - test_thumbnail_generation_failure_logs_real_error_details: the real error
 *     text comes from the image library, so sharp's "Input file contains
 *     unsupported image format" replaces PIL's "cannot identify image file".
 *     The assertion still requires the real error detail instead of the old
 *     fixed "unsupported_format" string.
 *   - test_routes_are_async_def / test_download_and_view_file_helpers_are_sync:
 *     Python offloaded blocking IO to a threadpool and asserted the helpers were
 *     synchronous. The Node equivalent is an async request path backed by
 *     node:fs/promises, so the helpers must return promises and the request-path
 *     sources must contain no synchronous fs calls.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { HttpError } from "../src/errors.js";
import {
  deleteFile as deleteFileTool,
  extendTtl as extendTtlTool,
  getFileInfo as getFileInfoTool,
  listFiles,
  uploadFile,
} from "../src/mcp.js";
import { downloadFile, thumbnailFile, viewFile } from "../src/routes/transfer.js";
import * as storage from "../src/storage.js";
import {
  FileMetadata,
  deleteFileById,
  deleteThumbnail,
  extendFileTtl,
  fileMetaDict,
  getFileInfo,
  getFilePaths,
} from "../src/storage.js";
import { pythonQuote } from "../src/url.js";
import {
  TEST_API_KEY,
  authHeader,
  buildAuthenticatedServer,
  buildTestServer,
  makeDataDir,
  removeDataDir,
  restoreConfig,
  useApiKeys,
} from "./helpers.js";

let dataDir = "";
let captured: string[] = [];
const extraDirs: string[] = [];
const apps: FastifyInstance[] = [];

/** Python's time.time(). */
function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Every JSON event logged since the last read (logEvent prints one JSON line). */
function logEvents(): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of captured) {
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Non-JSON console output is not a logEvent record.
    }
  }
  return events;
}

/** tmp_path equivalent (tracked for cleanup). */
async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), "tmpup-routes-"));
  extraDirs.push(dir);
  return dir;
}

interface RgbBackground {
  r: number;
  g: number;
  b: number;
  alpha?: number;
}

/** PIL Image.new(...).save(path, format="PNG") equivalent. */
async function createPng(
  filePath: string,
  width: number,
  height: number,
  background: RgbBackground,
  channels: 3 | 4 = 3,
): Promise<void> {
  await sharp({ create: { width, height, channels, background } }).png().toFile(filePath);
}

/** PIL Image.new(...).save(path, format="JPEG") equivalent. */
async function createJpeg(filePath: string, width: number, height: number, background: RgbBackground): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background } })
    .jpeg({ quality: 90 })
    .toFile(filePath);
}

/** FastAPI TestClient(app, headers={"X-API-Key": key}) for the auth_client fixture. */
async function authServer(key: string = TEST_API_KEY): Promise<FastifyInstance> {
  const app = await buildAuthenticatedServer(key);
  apps.push(app);
  return app;
}

/** TestClient(app) with no credentials (Python relied on API_KEYS being empty). */
async function anonServer(...keys: string[]): Promise<FastifyInstance> {
  useApiKeys(...keys);
  const app = await buildTestServer();
  apps.push(app);
  return app;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** pytest.raises(HTTPException) asserting status_code. */
async function expectHttpError(promise: Promise<unknown>, statusCode: number): Promise<void> {
  const error = await captureError(promise);
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).statusCode).toBe(statusCode);
}

interface StoreOptions {
  fileId?: string;
  filename: string;
  ttl: number;
  createdAt?: number;
  content?: Buffer;
  sizeBytes?: number;
  views?: number;
  downloads?: number;
  lastViewedAt?: number | null;
  lastDownloadedAt?: number | null;
}

/** Create a UUID-keyed file + sidecar the way the Python fixtures do. */
async function storeUuidFile(options: StoreOptions): Promise<{
  fileId: string;
  filePath: string;
  metadataPath: string;
}> {
  const fileId = options.fileId ?? randomUUID();
  const { filePath, metadataPath } = getFilePaths(fileId);
  await fsp.writeFile(filePath, options.content ?? Buffer.alloc(options.sizeBytes ?? 0));
  const metadata = new FileMetadata(
    fileId,
    options.filename,
    options.ttl,
    options.createdAt ?? nowSeconds(),
    options.views ?? 0,
    options.downloads ?? 0,
    options.lastViewedAt ?? null,
    options.lastDownloadedAt ?? null,
    options.sizeBytes ?? (options.content ? options.content.length : 0),
  );
  await metadata.save(metadataPath);
  return { fileId, filePath, metadataPath };
}

/**
 * Sidecar (and payload) for the fixture ids that are not UUIDs: Python wrote
 * isolate_data_dir / f"{fid}.meta.json" directly, bypassing get_file_paths.
 */
async function storeRawFile(
  fileId: string,
  filename: string,
  ttl: number,
  createdAt: number,
  sizeBytes: number,
  content?: Buffer,
): Promise<void> {
  await fsp.writeFile(path.join(dataDir, fileId), content ?? Buffer.alloc(sizeBytes, "x"));
  const metadata = new FileMetadata(fileId, filename, ttl, createdAt, 0, 0, null, null, sizeBytes);
  await metadata.save(path.join(dataDir, fileId + ".meta.json"));
}

async function reloadMeta(metadataPath: string): Promise<FileMetadata> {
  const metadata = await FileMetadata.fromFile(metadataPath);
  expect(metadata).not.toBeNull();
  return metadata as FileMetadata;
}

beforeEach(async () => {
  captured = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  });
  dataDir = await makeDataDir();
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  vi.restoreAllMocks();
  restoreConfig();
  for (const dir of extraDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  if (dataDir) {
    await removeDataDir(dataDir);
    dataDir = "";
  }
});

describe("REST endpoints", () => {
  it("test_extend_file_ttl_expired_file (route-level part)", async () => {
    const app = await authServer();
    const expiredId = randomUUID();
    // Expired file: ttl=10, created 100 seconds ago.
    const { metadataPath } = await storeUuidFile({
      fileId: expiredId,
      filename: "expired.txt",
      ttl: 10,
      createdAt: nowSeconds() - 100,
      content: Buffer.from("expired-content"),
    });

    // 3. REST endpoint returns 404 (the extend_file_ttl / extend_ttl helper
    // assertions live in test/storage.test.ts and test/mcp.test.ts).
    const resPatch = await app.inject({
      method: "PATCH",
      url: "/api/files/" + expiredId + "/ttl",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { ttl: 3600 },
    });
    expect(resPatch.statusCode).toBe(404);

    // Verify metadata on disk was not updated.
    const reloaded = await reloadMeta(metadataPath);
    expect(reloaded.ttl).toBe(10);
    expect(reloaded.isExpired).toBe(true);
  });

  it("test_rest_get_file_info", async () => {
    const app = await authServer();

    let res = await app.inject({ method: "GET", url: "/api/files/missing-123", headers: authHeader() });
    expect(res.statusCode).toBe(404);

    const fileAbc = randomUUID();
    await storeUuidFile({ fileId: fileAbc, filename: "image.png", ttl: 3600, content: Buffer.from("content") });

    res = await app.inject({ method: "GET", url: "/api/files/" + fileAbc, headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.id).toBe(fileAbc);
    expect(data.filename).toBe("image.png");
    expect(data.is_image).toBe(true);
  });

  it("test_rest_delete_file", async () => {
    const app = await authServer();

    let res = await app.inject({ method: "DELETE", url: "/api/files/missing-del", headers: authHeader() });
    expect(res.statusCode).toBe(404);

    const fileDel = randomUUID();
    const { filePath, metadataPath } = await storeUuidFile({
      fileId: fileDel,
      filename: "temp.txt",
      ttl: 3600,
      content: Buffer.from("delme"),
    });

    res = await app.inject({ method: "DELETE", url: "/api/files/" + fileDel, headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(metadataPath)).toBe(false);
  });

  it("test_rest_patch_file_ttl", async () => {
    const app = await authServer();

    // 404 for non-existent file.
    let res = await app.inject({
      method: "PATCH",
      url: "/api/files/missing-patch/ttl",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { ttl: 3600 },
    });
    expect(res.statusCode).toBe(404);

    const filePatch = randomUUID();
    await storeUuidFile({
      fileId: filePatch,
      filename: "patch.txt",
      ttl: 3600,
      createdAt: nowSeconds() - 50,
      content: Buffer.from("data"),
    });

    // 400 for invalid JSON body.
    res = await app.inject({
      method: "PATCH",
      url: "/api/files/" + filePatch + "/ttl",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: Buffer.from("not a valid json"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("Invalid JSON body");

    // 400 for missing ttl field.
    res = await app.inject({
      method: "PATCH",
      url: "/api/files/" + filePatch + "/ttl",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { not_ttl: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("'ttl' field is required");

    // 400 for invalid ttl.
    res = await app.inject({
      method: "PATCH",
      url: "/api/files/" + filePatch + "/ttl",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { ttl: -10 },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "PATCH",
      url: "/api/files/" + filePatch + "/ttl",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { ttl: "invalid" },
    });
    expect(res.statusCode).toBe(400);

    // 200 for valid ttl.
    res = await app.inject({
      method: "PATCH",
      url: "/api/files/" + filePatch + "/ttl",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { ttl: 7200 },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.id).toBe(filePatch);
    expect(data.expires_in).toBeGreaterThan(7000);
  });

  it("test_mcp_auth_protection", async () => {
    // Test without credentials -> 401
    const app = await anonServer();
    const res = await app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthorized",
      detail: "Provide session cookie or X-API-Key header",
    });

    // Test with valid X-API-Key (with startup/shutdown lifecycle)
    const authApp = await anonServer("valid-mcp-key");
    const res2 = await authApp.inject({
      method: "GET",
      url: "/mcp",
      headers: authHeader("valid-mcp-key"),
    });
    expect(res2.statusCode).not.toBe(401);
    expect(res2.statusCode).toBeLessThan(500);
  });

  it("test_invalid_file_id_and_path_traversal", async () => {
    // Canary file outside DATA_DIR to ensure path traversal attempts never touch external files.
    const canaryDir = await makeTempDir();
    const outsideDir = path.join(canaryDir, "outside");
    await fsp.mkdir(outsideDir);
    const canaryFile = path.join(outsideDir, "passwd");
    const canaryContent = Buffer.from("root:x:0:0:root:/root:/bin/bash");
    await fsp.writeFile(canaryFile, canaryContent);
    const canaryMtime = (await fsp.stat(canaryFile)).mtimeMs;

    const app = await authServer();
    const badIds = ["nao-e-uuid", "12345"];

    for (const badId of badIds) {
      // 1. get_file_paths raises ValueError
      expect(() => getFilePaths(badId)).toThrow(Error);

      // 2. Helpers return None or False
      expect(await getFileInfo(badId)).toBeNull();
      expect(await extendFileTtl(badId, 3600)).toBeNull();
      expect(await deleteFileById(badId)).toBe(false);

      // 3. MCP tools raise ValueError or return {"deleted": False}
      await expect(getFileInfoTool(badId)).rejects.toThrow(Error);
      await expect(extendTtlTool(badId, 3600)).rejects.toThrow(Error);
      expect(await deleteFileTool(badId)).toEqual({ deleted: false });

      // 4. REST routes return 404
      const getRes = await app.inject({ method: "GET", url: "/api/files/" + badId, headers: authHeader() });
      expect(getRes.statusCode).toBe(404);
      const delRes = await app.inject({ method: "DELETE", url: "/api/files/" + badId, headers: authHeader() });
      expect(delRes.statusCode).toBe(404);
      const patchRes = await app.inject({
        method: "PATCH",
        url: "/api/files/" + badId + "/ttl",
        headers: { ...authHeader(), "content-type": "application/json" },
        payload: { ttl: 3600 },
      });
      expect(patchRes.statusCode).toBe(404);
      const dlRes = await app.inject({ method: "GET", url: "/d/" + badId + "/test.txt", headers: authHeader() });
      expect(dlRes.statusCode).toBe(404);
      const viewRes = await app.inject({ method: "GET", url: "/v/" + badId + "/test.png", headers: authHeader() });
      expect(viewRes.statusCode).toBe(404);
    }

    // Verify canary file outside DATA_DIR was never accessed/modified/deleted.
    expect(fs.existsSync(canaryFile)).toBe(true);
    expect(await fsp.readFile(canaryFile)).toEqual(canaryContent);
    expect((await fsp.stat(canaryFile)).mtimeMs).toBe(canaryMtime);
  });

  it("test_existing_routes_regression", async () => {
    const app = await authServer();

    // 1. Root /
    let res = await app.inject({ method: "GET", url: "/", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("TmpUp");

    // 2. Health
    res = await app.inject({ method: "GET", url: "/health", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    // 3. Login
    res = await app.inject({ method: "GET", url: "/auth/login", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Entrar com Google");

    // 4. Logout
    res = await app.inject({ method: "GET", url: "/auth/logout", headers: authHeader() });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/auth/login");

    // 5. Google auth redirect
    res = await app.inject({ method: "GET", url: "/auth/google", headers: authHeader() });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("accounts.google.com");

    // 6. POST /api/upload
    const uploadHeaders = { ...authHeader(), "content-type": "application/octet-stream" };
    // missing filename
    res = await app.inject({ method: "POST", url: "/api/upload", headers: uploadHeaders, payload: Buffer.from("data") });
    expect(res.statusCode).toBe(400);

    // invalid TTL
    res = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { ...uploadHeaders, "x-filename": "test.txt", "x-ttl": "abc" },
      payload: Buffer.from("data"),
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { ...uploadHeaders, "x-filename": "test.txt", "x-ttl": "-5" },
      payload: Buffer.from("data"),
    });
    expect(res.statusCode).toBe(400);

    // successful upload
    res = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { ...uploadHeaders, "x-filename": "test.txt", "x-ttl": "3600" },
      payload: Buffer.from("hello upload"),
    });
    expect(res.statusCode).toBe(200);
    const uploadData = res.json();
    expect(uploadData).toHaveProperty("id");
    const fileId = uploadData.id as string;
    expect(uploadData.expires_in).toBe(3600);

    // 7. GET /api/files
    res = await app.inject({ method: "GET", url: "/api/files", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const files = res.json().items as Array<Record<string, any>>;
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((file) => file.id === fileId)).toBe(true);

    // 8. GET /d/{file_id}/{filename} (download)
    res = await app.inject({ method: "GET", url: "/d/" + fileId + "/test.txt", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(Buffer.from("hello upload"))).toBe(true);

    // 9. GET /v/{file_id}/{filename} for non-image redirects to /d/
    res = await app.inject({ method: "GET", url: "/v/" + fileId + "/test.txt", headers: authHeader() });
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe("/d/" + fileId + "/test.txt");

    // 10. Image upload and viewer
    res = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { ...uploadHeaders, "x-filename": "photo.png", "x-ttl": "0" },
      payload: Buffer.from("fake-png-bytes"),
    });
    expect(res.statusCode).toBe(200);
    const imgId = res.json().id as string;

    res = await app.inject({ method: "GET", url: "/v/" + imgId + "/photo.png", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<img class="viewer-img"');

    // 11. Admin set-all-infinite
    res = await app.inject({ method: "POST", url: "/admin/set-all-infinite", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("updated");
  });

  it("test_rest_endpoints_return_new_metadata_fields", async () => {
    const app = await authServer();
    const fileId = randomUUID();
    const content = Buffer.from("sample content for testing");
    await fsp.writeFile(path.join(dataDir, fileId), content);
    const created = nowSeconds();
    const metadata = new FileMetadata(fileId, "notes.txt", 3600, created, 3, 7, created - 40, created - 20, 0);
    await metadata.save(path.join(dataDir, fileId + ".meta.json"));

    const expectedFields = [
      "id",
      "filename",
      "url",
      "view_url",
      "is_image",
      "expires_in",
      "created_at",
      "size_bytes",
      "views",
      "downloads",
      "last_viewed_at",
      "last_downloaded_at",
    ];

    // 1. GET /api/files/{id}
    let res = await app.inject({ method: "GET", url: "/api/files/" + fileId, headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    for (const field of expectedFields) {
      expect(data).toHaveProperty(field);
    }
    expect(data.id).toBe(fileId);
    expect(data.filename).toBe("notes.txt");
    expect(data.size_bytes).toBe(content.length);
    expect(data.views).toBe(3);
    expect(data.downloads).toBe(7);
    expect(data.last_viewed_at).toBe(created - 40);
    expect(data.last_downloaded_at).toBe(created - 20);

    // 2. GET /api/files
    res = await app.inject({ method: "GET", url: "/api/files", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, any>>;
    const item = items.find((file) => file.id === fileId) as Record<string, any>;
    for (const field of expectedFields) {
      expect(item).toHaveProperty(field);
    }
    expect(item.size_bytes).toBe(content.length);
    expect(item.views).toBe(3);
    expect(item.downloads).toBe(7);
    expect(item.last_viewed_at).toBe(created - 40);
    expect(item.last_downloaded_at).toBe(created - 20);
  });
});

/** PNG signature bytes used by the Python fixtures. */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("transfer routes and security", () => {
  it("test_download_file_tracks_views_and_downloads", async () => {
    const app = await authServer();

    // 1. Inline file (image/png)
    const imgId = randomUUID();
    const { metadataPath: imgMetaPath } = await storeUuidFile({
      fileId: imgId,
      filename: "test.png",
      ttl: 3600,
      content: Buffer.concat([PNG_HEADER, Buffer.from("fake-png")]),
    });

    const tBeforeView = nowSeconds();
    const res1 = await app.inject({ method: "GET", url: "/d/" + imgId + "/test.png", headers: authHeader() });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["content-disposition"]).toBe("inline");

    const reloadedImg = await reloadMeta(imgMetaPath);
    expect(reloadedImg.views).toBe(1);
    expect(reloadedImg.downloads).toBe(0);
    expect(reloadedImg.lastViewedAt).not.toBeNull();
    expect(reloadedImg.lastViewedAt as number).toBeGreaterThanOrEqual(tBeforeView);
    expect(reloadedImg.lastDownloadedAt).toBeNull();

    // Call again to verify idempotent counting (each call increments once)
    const res2 = await app.inject({ method: "GET", url: "/d/" + imgId + "/test.png", headers: authHeader() });
    expect(res2.statusCode).toBe(200);
    const reloadedImg2 = await reloadMeta(imgMetaPath);
    expect(reloadedImg2.views).toBe(2);
    expect(reloadedImg2.downloads).toBe(0);

    // 2. Attachment file (application/octet-stream or application/zip)
    const binId = randomUUID();
    const { metadataPath: binMetaPath } = await storeUuidFile({
      fileId: binId,
      filename: "archive.zip",
      ttl: 3600,
      content: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fake-zip")]),
    });

    const tBeforeDl = nowSeconds();
    const resDl1 = await app.inject({ method: "GET", url: "/d/" + binId + "/archive.zip", headers: authHeader() });
    expect(resDl1.statusCode).toBe(200);
    expect(String(resDl1.headers["content-disposition"] ?? "").startsWith("attachment")).toBe(true);

    const reloadedBin = await reloadMeta(binMetaPath);
    expect(reloadedBin.downloads).toBe(1);
    expect(reloadedBin.views).toBe(0);
    expect(reloadedBin.lastDownloadedAt).not.toBeNull();
    expect(reloadedBin.lastDownloadedAt as number).toBeGreaterThanOrEqual(tBeforeDl);
    expect(reloadedBin.lastViewedAt).toBeNull();

    // Call again: increments downloads to 2
    const resDl2 = await app.inject({ method: "GET", url: "/d/" + binId + "/archive.zip", headers: authHeader() });
    expect(resDl2.statusCode).toBe(200);
    const reloadedBin2 = await reloadMeta(binMetaPath);
    expect(reloadedBin2.downloads).toBe(2);
    expect(reloadedBin2.views).toBe(0);
  });

  it("test_viewer_page_redesign", async () => {
    const app = await authServer();
    const imgId = randomUUID();
    await storeUuidFile({
      fileId: imgId,
      filename: "test_pic.png",
      ttl: 3600,
      content: Buffer.concat([PNG_HEADER, Buffer.from("content")]),
    });

    const res = await app.inject({ method: "GET", url: "/v/" + imgId + "/test_pic.png", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('<div class="viewer-metrics" id="viewerMetrics"></div>');
    expect(html).toContain('id="deleteBtn"');
    expect(html).toContain('id="deletedCard"');
    expect(html).toContain('const fileId = "' + imgId + '";');
    expect(html).toContain('const imageUrlAbs = "' + config.baseUrl + "/d/" + imgId + '/test_pic.png";');
  });

  it("test_main_page_redesign", async () => {
    const app = await authServer();
    const res = await app.inject({ method: "GET", url: "/", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('id="summaryBar"');
    expect(html).toContain('id="searchInput"');
    expect(html).toContain('id="chipRow"');
    expect(html).toContain('id="sortSelect"');
    expect(html).toContain('id="bulkBar"');
    expect(html).toContain('id="bulkRenewBtn"');
    expect(html).toContain('id="bulkDeleteBtn"');
    expect(html).toContain('id="bulkCancelBtn"');
    expect(html).toContain('data-action="renew-toggle"');
    expect(html).toContain('data-action="renew-apply"');
    expect(html).toContain('data-action="delete"');
    expect(html).toContain('data-action="select"');
    expect(html).toContain("print-colado");
  });

  it("test_security_xss_and_metadata_filename_in_viewer_and_download", async () => {
    const app = await authServer();
    const imgId = randomUUID();
    const maliciousFilename = "evil</script><script>alert(1)</script>.png";
    await storeUuidFile({
      fileId: imgId,
      filename: maliciousFilename,
      ttl: 3600,
      content: Buffer.concat([PNG_HEADER, Buffer.from("fake-png")]),
    });

    // 1. Access with a completely different URL path
    let res = await app.inject({ method: "GET", url: "/v/" + imgId + "/qualquer-coisa.png", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const html = res.body;

    // Must display the real metadata.filename, NOT 'qualquer-coisa.png'
    expect(html).not.toContain("qualquer-coisa.png");
    // Must have escaped HTML filename, not raw unescaped tags
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;.png");
    expect(html).not.toContain("<script>alert(1)</script>");

    // Inside script blocks, there must be NO raw '</script>'
    expect(html).not.toContain("</script><script>");
    expect(html.includes("<\\/") || html.includes("\\/")).toBe(true);

    // 2. Reflected XSS attempt via URL path on valid file
    const validId = randomUUID();
    await storeUuidFile({
      fileId: validId,
      filename: "safe_image.png",
      ttl: 3600,
      content: Buffer.concat([PNG_HEADER, Buffer.from("fake-png")]),
    });

    const attackUrlName = "x%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.png";
    res = await app.inject({ method: "GET", url: "/v/" + validId + "/" + attackUrlName, headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("safe_image.png");
    expect(res.body).not.toContain("onerror=alert(1)");
    expect(res.body).not.toContain("<img src=x");

    // 3. Content-Disposition in /d/ must use metadata.filename, not URL segment
    res = await app.inject({ method: "GET", url: "/d/" + validId + "/injected_name.bin?dl=1", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const cd = String(res.headers["content-disposition"] ?? "");
    expect(cd).toContain("safe_image.png");
    expect(cd).not.toContain("injected_name.bin");
  });

  it("test_download_dl_param_forces_attachment_and_increments_downloads", async () => {
    const app = await authServer();
    const imgId = randomUUID();
    const { metadataPath } = await storeUuidFile({
      fileId: imgId,
      filename: "photo.png",
      ttl: 3600,
      content: Buffer.concat([PNG_HEADER, Buffer.from("fake-png")]),
    });

    // 1. Normal GET without dl: inline, views=1, downloads=0
    const resView = await app.inject({ method: "GET", url: "/d/" + imgId + "/photo.png", headers: authHeader() });
    expect(resView.statusCode).toBe(200);
    expect(resView.headers["content-disposition"]).toBe("inline");
    let reloaded = await reloadMeta(metadataPath);
    expect(reloaded.views).toBe(1);
    expect(reloaded.downloads).toBe(0);

    // 2. GET with ?dl=1: attachment, views=1, downloads=1
    const resDl = await app.inject({ method: "GET", url: "/d/" + imgId + "/photo.png?dl=1", headers: authHeader() });
    expect(resDl.statusCode).toBe(200);
    const cd = String(resDl.headers["content-disposition"] ?? "");
    expect(cd.startsWith("attachment")).toBe(true);
    expect(cd).toContain("photo.png");
    reloaded = await reloadMeta(metadataPath);
    expect(reloaded.views).toBe(1);
    expect(reloaded.downloads).toBe(1);
  });

  it("test_upload_and_viewer_security_xss_e2e", async () => {
    const app = await authServer();
    const maliciousFilename = "evil</script><script>alert(1)</script>.png";
    const encodedName = pythonQuote(maliciousFilename);
    const payload = Buffer.concat([PNG_HEADER, Buffer.from("malicious-test-content")]);

    const uploadRes = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: {
        ...authHeader(),
        "x-filename": encodedName,
        "x-ttl": "3600",
        "content-type": "application/octet-stream",
      },
      payload,
    });
    expect(uploadRes.statusCode).toBe(200);
    const fileId = uploadRes.json().id as string;

    // Verify size_bytes persisted
    const savedMeta = await reloadMeta(path.join(dataDir, fileId + ".meta.json"));
    expect(savedMeta.sizeBytes).toBe(payload.length);

    // 1. GET /v/{file_id}/qualquer-coisa.png
    const viewerRes = await app.inject({
      method: "GET",
      url: "/v/" + fileId + "/qualquer-coisa.png",
      headers: authHeader(),
    });
    expect(viewerRes.statusCode).toBe(200);
    const html = viewerRes.body;

    // Path from URL must be ignored for display
    expect(html).not.toContain("qualquer-coisa.png");
    // Real name must be escaped in HTML context
    expect(html).toContain("evil&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;.png");
    expect(html).not.toContain("<script>alert(1)</script>");

    // Inside <script> block, </script> must be escaped as <\/script>
    // (Python: re.findall(r"<script>(.*?)</script>", html, DOTALL) -> exactly 1 block)
    const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1] as string,
    );
    expect(scriptBlocks).toHaveLength(1);
    const scriptContent = scriptBlocks[0] as string;
    expect(scriptContent).not.toContain("</script>");
    expect(scriptContent).toContain("<\\/");

    // 2. Content-Disposition in /d/ must use metadata.filename
    const dRes = await app.inject({
      method: "GET",
      url: "/d/" + fileId + "/arbitrary_name.png?dl=1",
      headers: authHeader(),
    });
    expect(dRes.statusCode).toBe(200);
    const cd = String(dRes.headers["content-disposition"] ?? "");
    expect(cd).toContain("evil");
    expect(cd).not.toContain("arbitrary_name.png");
  });

  it("test_metadata_size_bytes_persistence_and_stat_fallback", async () => {
    const app = await authServer();

    // 1. Upload via stream persists size_bytes
    const payload = Buffer.from("hello world 12345");
    const upRes = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: {
        ...authHeader(),
        "x-filename": "stream_file.txt",
        "x-ttl": "3600",
        "content-type": "application/octet-stream",
      },
      payload,
    });
    expect(upRes.statusCode).toBe(200);
    const fid = upRes.json().id as string;

    const metaStream = await reloadMeta(path.join(dataDir, fid + ".meta.json"));
    expect(metaStream.sizeBytes).toBe(payload.length);

    // 2. MCP upload_file persists size_bytes
    const mcpRes = await uploadFile("mcp_test.txt", Buffer.from("mcp content bytes").toString("base64"), 3600);
    const mcpFid = mcpRes.id;
    const metaMcp = await reloadMeta(path.join(dataDir, mcpFid + ".meta.json"));
    expect(metaMcp.sizeBytes).toBe(Buffer.from("mcp content bytes").length);

    // 3. fileMetaDict uses metadata.size_bytes when > 0 without needing stat()
    const fakeId = randomUUID();
    const fakeMeta = new FileMetadata(fakeId, "fake.txt", 3600, nowSeconds(), 0, 0, null, null, 999999);
    // Note: no file written to disk for fake_id!
    const info = await fileMetaDict(fakeMeta);
    expect(info.size_bytes).toBe(999999);

    // 4. fileMetaDict falls back to stat() when size_bytes is 0 (legacy metadata)
    const legacyId = randomUUID();
    await fsp.writeFile(path.join(dataDir, legacyId), Buffer.from("legacy bytes on disk"));
    const legacyMeta = new FileMetadata(legacyId, "legacy.txt", 3600, nowSeconds(), 0, 0, null, null, 0);
    const infoLegacy = await fileMetaDict(legacyMeta);
    expect(infoLegacy.size_bytes).toBe(Buffer.from("legacy bytes on disk").length);
  });

  it("test_frontend_review_fixes_elements_and_handlers", async () => {
    const app = await authServer();

    // Main page checks
    const mainRes = await app.inject({ method: "GET", url: "/", headers: authHeader() });
    expect(mainRes.statusCode).toBe(200);
    const mainHtml = mainRes.body;

    // AC 7: <label for='ttlSelect'>
    expect(mainHtml).toContain('<label for="ttlSelect">');

    // AC 8: loadFiles checks res.ok and Array.isArray(data.items)
    expect(mainHtml.includes("if(!res.ok)") || mainHtml.includes("if (!res.ok)")).toBe(true);
    expect(mainHtml).toContain("Array.isArray(data.items)");

    // AC 4: bulk actions check response.ok and count actual successes/failures
    expect(mainHtml).toContain("successCount");
    expect(mainHtml).toContain("${successCount} de ${ids.length} arquivo(s) excluidos");
    expect(mainHtml).toContain("${successCount} de ${ids.length} arquivo(s) renovados");

    // Viewer page checks
    const imgId = randomUUID();
    await storeUuidFile({
      fileId: imgId,
      filename: "view_test.png",
      ttl: 3600,
      content: Buffer.concat([PNG_HEADER, Buffer.from("content")]),
    });

    const viewerRes = await app.inject({ method: "GET", url: "/v/" + imgId + "/view_test.png", headers: authHeader() });
    expect(viewerRes.statusCode).toBe(200);
    const viewerHtml = viewerRes.body;

    // AC 3: Viewer download button has ?dl=1
    expect(viewerHtml).toContain('href="/d/' + imgId + '/view_test.png?dl=1"');
    expect(viewerHtml).toContain('download="view_test.png"');

    // AC 6: Viewer has error element and error feedback on delete failure
    expect(viewerHtml).toContain('id="viewerError"');
    expect(viewerHtml).toContain("Erro ao excluir arquivo");
  });
});

describe("thumbnails", () => {
  it("test_get_thumbnail_success_and_cached", async () => {
    const app = await anonServer();
    const fileId = randomUUID();
    const filename = "photo.png";
    const filePath = path.join(dataDir, fileId);
    const metaPath = path.join(dataDir, fileId + ".meta.json");

    await createPng(filePath, 600, 400, { r: 100, g: 150, b: 200 });
    const metadata = new FileMetadata(
      fileId,
      filename,
      3600,
      nowSeconds(),
      0,
      0,
      null,
      null,
      fs.statSync(filePath).size,
    );
    await metadata.save(metaPath);

    // First request: generates thumbnail
    const res1 = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["content-type"]).toBe("image/jpeg");
    const cacheControl = String(res1.headers["cache-control"] ?? "");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("max-age=31536000");
    expect(cacheControl).toContain("immutable");

    const thumbPath = path.join(dataDir, fileId + ".thumb.jpg");
    expect(fs.existsSync(thumbPath)).toBe(true);
    const mtimeBefore = (await fsp.stat(thumbPath)).mtimeMs;

    // Small delay to ensure mtime would differ if the file were rewritten.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Second request: reuses cached thumbnail without regenerating
    const res2 = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["content-type"]).toBe("image/jpeg");
    const mtimeAfter = (await fsp.stat(thumbPath)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("test_get_thumbnail_does_not_increment_views_or_downloads", async () => {
    const app = await anonServer();
    const fileId = randomUUID();
    const filename = "picture.jpg";
    const filePath = path.join(dataDir, fileId);
    const metaPath = path.join(dataDir, fileId + ".meta.json");

    await createJpeg(filePath, 300, 300, { r: 50, g: 100, b: 150 });
    const metadata = new FileMetadata(fileId, filename, 3600, nowSeconds(), 0, 0);
    await metadata.save(metaPath);

    const res = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res.statusCode).toBe(200);

    const savedMeta = await reloadMeta(metaPath);
    expect(savedMeta.views).toBe(0);
    expect(savedMeta.downloads).toBe(0);
  });

  it("test_get_thumbnail_non_image_returns_404", async () => {
    const app = await anonServer();
    const fileId = randomUUID();
    const filename = "document.pdf";
    const filePath = path.join(dataDir, fileId);
    const metaPath = path.join(dataDir, fileId + ".meta.json");

    await fsp.writeFile(filePath, Buffer.from("%PDF-1.4 test content"));
    const metadata = new FileMetadata(fileId, filename, 3600, nowSeconds());
    await metadata.save(metaPath);

    const res = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res.statusCode).toBe(404);
  });

  it("test_get_thumbnail_invalid_id_or_path_traversal", async () => {
    // Direct helper check for invalid id and path traversal
    await expectHttpError(thumbnailFile("not-a-uuid", "photo.png"), 404);
    await expectHttpError(thumbnailFile("../../etc/passwd", "photo.png"), 404);

    const app = await anonServer();
    // Non-existent UUID returns 404
    const res = await app.inject({ method: "GET", url: "/t/" + randomUUID() + "/image.png" });
    expect(res.statusCode).toBe(404);

    // Invalid ID via client returns 404
    const resBad = await app.inject({ method: "GET", url: "/t/invalid-id/image.png" });
    expect(resBad.statusCode).toBe(404);
  });

  it("test_get_thumbnail_expired_returns_404", async () => {
    const app = await anonServer();
    const fileId = randomUUID();
    const filename = "expired.png";
    const filePath = path.join(dataDir, fileId);
    const metaPath = path.join(dataDir, fileId + ".meta.json");

    await createPng(filePath, 100, 100, { r: 10, g: 20, b: 30 });
    // expired 60s ago
    const metadata = new FileMetadata(fileId, filename, 60, nowSeconds() - 120);
    await metadata.save(metaPath);

    const res = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res.statusCode).toBe(404);
  });

  it("test_get_thumbnail_fallback_when_generation_fails", async () => {
    const app = await anonServer();
    const fileId = randomUUID();
    const filename = "corrupted.png";
    const filePath = path.join(dataDir, fileId);
    const metaPath = path.join(dataDir, fileId + ".meta.json");

    const originalBytes = Buffer.from("corrupted image bytes that the image library cannot decode");
    await fsp.writeFile(filePath, originalBytes);
    const metadata = new FileMetadata(fileId, filename, 3600, nowSeconds());
    await metadata.save(metaPath);

    const res = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(originalBytes)).toBe(true);
  });

  it("test_thumbnail_canonical_uuid_form", async () => {
    const rawUuid = randomUUID();
    const canonicalId = rawUuid.toLowerCase();
    const upperId = rawUuid.toUpperCase();
    const filename = "test.png";

    const filePath = path.join(dataDir, canonicalId);
    const metaPath = path.join(dataDir, canonicalId + ".meta.json");
    const canonicalThumb = path.join(dataDir, canonicalId + ".thumb.jpg");
    const upperThumb = path.join(dataDir, upperId + ".thumb.jpg");

    await createPng(filePath, 200, 200, { r: 255, g: 255, b: 0 });
    const metadata = new FileMetadata(canonicalId, filename, 3600, nowSeconds());
    await metadata.save(metaPath);

    const app = await anonServer();

    // Request thumbnail using UPPERCASE file_id
    const res = await app.inject({ method: "GET", url: "/t/" + upperId + "/" + filename });
    expect(res.statusCode).toBe(200);

    // Thumbnail must be generated using CANONICAL ID, not uppercase ID
    expect(fs.existsSync(canonicalThumb)).toBe(true);
    expect(fs.existsSync(upperThumb)).toBe(false);

    // Deleting using UPPERCASE ID must delete the canonical thumbnail
    const deleted = await deleteFileById(upperId);
    expect(deleted).toBe(true);
    expect(fs.existsSync(canonicalThumb)).toBe(false);
  });

  it("test_thumbnail_generation_failure_logs_event", async () => {
    const app = await anonServer();
    const fileId = randomUUID();
    const filename = "bad.png";
    const filePath = path.join(dataDir, fileId);
    const metaPath = path.join(dataDir, fileId + ".meta.json");

    await fsp.writeFile(filePath, Buffer.from("corrupted image content"));
    const metadata = new FileMetadata(fileId, filename, 3600, nowSeconds());
    await metadata.save(metaPath);

    const res = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res.statusCode).toBe(200);

    // Verify logEvent was called with 'thumbnail_generation_failed'
    const failEvents = logEvents().filter((event) => event.event === "thumbnail_generation_failed");
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0]!.file_id).toBe(fileId);
    expect("reason" in (failEvents[0] as object)).toBe(true);
  });

  it("test_lazy_expiry_in_download_and_view_cleans_thumbnail", async () => {
    const app = await anonServer();

    for (const routePrefix of ["/d", "/v"]) {
      const fileId = randomUUID();
      const filename = "photo.png";
      const filePath = path.join(dataDir, fileId);
      const metaPath = path.join(dataDir, fileId + ".meta.json");
      const thumbPath = path.join(dataDir, fileId + ".thumb.jpg");

      // Create original image and pre-generate thumbnail
      await createPng(filePath, 100, 100, { r: 255, g: 0, b: 0 });
      await fsp.writeFile(thumbPath, Buffer.from("dummy thumbnail bytes"));

      // Expired metadata
      const metadata = new FileMetadata(fileId, filename, 60, nowSeconds() - 120);
      await metadata.save(metaPath);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(metaPath)).toBe(true);
      expect(fs.existsSync(thumbPath)).toBe(true);

      // Trigger lazy expiry
      const res = await app.inject({ method: "GET", url: routePrefix + "/" + fileId + "/" + filename });
      expect(res.statusCode).toBe(404);

      // Original, metadata AND thumbnail must all be cleaned up
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(metaPath)).toBe(false);
      expect(fs.existsSync(thumbPath)).toBe(false);
    }
  });

  it("test_thumbnail_second_attempt_uses_fail_cache", async () => {
    const app = await anonServer();
    const fileId = randomUUID();
    const filename = "vector.svg";
    const filePath = path.join(dataDir, fileId);
    const metaPath = path.join(dataDir, fileId + ".meta.json");
    const failMarker = path.join(dataDir, fileId + ".thumb.fail");
    const thumbPath = path.join(dataDir, fileId + ".thumb.jpg");

    // PIL cannot decode SVG, so Python used a valid SVG to force a failure.
    // sharp does decode SVG; undecodable bytes hit the same failure path.
    const originalContent = Buffer.from("not a decodable image payload");
    await fsp.writeFile(filePath, originalContent);
    const metadata = new FileMetadata(fileId, filename, 3600, nowSeconds());
    await metadata.save(metaPath);

    // Python monkeypatches app.generate_thumbnail; the module export is the
    // equivalent seam. The call-count assertion is only meaningful while the
    // spy is proven to observe real route calls (checked on the first attempt).
    const generateSpy = vi.spyOn(storage, "generateThumbnail");

    // First attempt: generation fails because the payload cannot be decoded.
    const res1 = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res1.statusCode).toBe(200);
    expect(res1.rawPayload.equals(originalContent)).toBe(true);
    // Marker .thumb.fail must be created, and .thumb.jpg must not exist
    expect(fs.existsSync(failMarker)).toBe(true);
    expect(fs.existsSync(thumbPath)).toBe(false);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    generateSpy.mockClear();
    const markerMtimeBefore = (await fsp.stat(failMarker)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Second attempt: with .thumb.fail present, generate_thumbnail must NOT be called
    const res2 = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res2.statusCode).toBe(200);
    expect(res2.rawPayload.equals(originalContent)).toBe(true);
    expect(generateSpy).not.toHaveBeenCalled();
    // Behavioural cross-check: the marker is only rewritten after a failed
    // generation attempt, so its mtime must be untouched.
    expect((await fsp.stat(failMarker)).mtimeMs).toBe(markerMtimeBefore);
  });

  it("test_thumbnail_generation_failure_logs_real_error_details", async () => {
    const app = await anonServer();
    const fileId = randomUUID();
    const filename = "unsupported.png";
    const filePath = path.join(dataDir, fileId);
    const metaPath = path.join(dataDir, fileId + ".meta.json");

    await fsp.writeFile(filePath, Buffer.from("this is corrupt binary payload not an image"));
    const metadata = new FileMetadata(fileId, filename, 3600, nowSeconds());
    await metadata.save(metaPath);

    const res = await app.inject({ method: "GET", url: "/t/" + fileId + "/" + filename });
    expect(res.statusCode).toBe(200);

    const failEvents = logEvents().filter((event) => event.event === "thumbnail_generation_failed");
    expect(failEvents).toHaveLength(1);
    const event = failEvents[0]!;
    expect(event.file_id).toBe(fileId);
    // Must NOT be the old generic fixed string "unsupported_format"
    expect(event.reason).not.toBe("unsupported_format");
    // Must include the real error details from the image library. Python/PIL
    // reports "cannot identify image file"; sharp reports "Input file contains
    // unsupported image format" for the same undecodable payload.
    const errorText = String(event.error ?? event.reason ?? "").toLowerCase();
    expect(errorText).toContain("unsupported image format");
  });
});

describe("listing and pagination", () => {
  it("test_api_files_pagination_defaults_more_than_50", async () => {
    const app = await authServer();
    const baseTime = nowSeconds();
    for (let i = 0; i < 55; i += 1) {
      const fid = "file-" + String(i).padStart(3, "0");
      await storeRawFile(fid, "test_" + String(i).padStart(3, "0") + ".txt", 86400, baseTime + i, 100 + i);
    }

    const res = await app.inject({ method: "GET", url: "/api/files", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(typeof data).toBe("object");
    expect(data.items.length).toBe(50);
    expect(data.total).toBe(55);
    expect(data.page).toBe(1);
    expect(data.page_size).toBe(50);
    expect(data.total_pages).toBe(2);
  });

  it("test_api_files_pagination_page_2", async () => {
    const app = await authServer();
    const baseTime = nowSeconds();
    for (let i = 0; i < 75; i += 1) {
      const fid = "file-" + String(i).padStart(3, "0");
      await storeRawFile(fid, "file_" + String(i).padStart(3, "0") + ".txt", 86400, baseTime + i, 10);
    }

    const resP1 = await app.inject({ method: "GET", url: "/api/files?page=1", headers: authHeader() });
    expect(resP1.statusCode).toBe(200);
    const p1 = resP1.json();
    expect(p1.items.length).toBe(50);
    expect(p1.page).toBe(1);
    expect(p1.total).toBe(75);
    expect(p1.total_pages).toBe(2);

    const resP2 = await app.inject({ method: "GET", url: "/api/files?page=2", headers: authHeader() });
    expect(resP2.statusCode).toBe(200);
    const p2 = resP2.json();
    expect(p2.items.length).toBe(25);
    expect(p2.page).toBe(2);
    expect(p2.total).toBe(75);
    expect(p2.total_pages).toBe(2);

    const p1Ids = new Set<string>((p1.items as Array<Record<string, any>>).map((item) => item.id as string));
    const p2Ids = new Set<string>((p2.items as Array<Record<string, any>>).map((item) => item.id as string));
    expect([...p1Ids].some((id) => p2Ids.has(id))).toBe(false);
    expect(new Set([...p1Ids, ...p2Ids]).size).toBe(75);
  });

  it("test_api_files_filter_by_query_q", async () => {
    const app = await authServer();
    const baseTime = nowSeconds();
    for (let i = 0; i < 60; i += 1) {
      const fid = "rep-" + String(i).padStart(3, "0");
      await storeRawFile(fid, "Monthly_Report_" + String(i).padStart(3, "0") + ".pdf", 86400, baseTime + i, 50);
    }
    for (let i = 0; i < 20; i += 1) {
      const fid = "other-" + String(i).padStart(3, "0");
      await storeRawFile(fid, "holiday_photo_" + String(i).padStart(3, "0") + ".jpg", 86400, baseTime + 100 + i, 80);
    }

    const res = await app.inject({ method: "GET", url: "/api/files?q=REPORT", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.total).toBe(60);
    expect(data.items.length).toBe(50);
    expect(data.total_pages).toBe(2);
    const allMatch = (data.items as Array<Record<string, any>>).every((item) =>
      (item.filename as string).toLowerCase().includes("report"),
    );
    expect(allMatch).toBe(true);

    const resP2 = await app.inject({ method: "GET", url: "/api/files?q=report&page=2", headers: authHeader() });
    expect(resP2.statusCode).toBe(200);
    const dataP2 = resP2.json();
    expect(dataP2.total).toBe(60);
    expect(dataP2.items.length).toBe(10);
    expect(dataP2.page).toBe(2);
    const allMatchP2 = (dataP2.items as Array<Record<string, any>>).every((item) =>
      (item.filename as string).toLowerCase().includes("report"),
    );
    expect(allMatchP2).toBe(true);
  });

  it("test_api_files_filter_by_kind", async () => {
    const app = await authServer();
    const filesToCreate: Array<[string, number]> = [
      ["img1.png", 10],
      ["img2.jpg", 10],
      ["img3.webp", 10],
      ["doc1.pdf", 10],
      ["doc2.docx", 10],
      ["doc3.txt", 10],
      ["vid1.mp4", 10],
      ["vid2.webm", 10],
      ["arc1.zip", 10],
      ["arc2.tar.gz", 10],
    ];
    const baseTime = nowSeconds();
    for (let idx = 0; idx < filesToCreate.length; idx += 1) {
      const entry = filesToCreate[idx]!;
      const fid = "kind-test-" + idx;
      await storeRawFile(fid, entry[0], 86400, baseTime + idx, entry[1], Buffer.alloc(entry[1], "x"));
    }

    // Kind image
    let res = await app.inject({ method: "GET", url: "/api/files?kind=image", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    let data = res.json();
    expect(data.total).toBe(3);
    expect(data.items.length).toBe(3);
    expect(new Set((data.items as Array<Record<string, any>>).map((f) => f.filename))).toEqual(
      new Set(["img1.png", "img2.jpg", "img3.webp"]),
    );

    // Kind document
    res = await app.inject({ method: "GET", url: "/api/files?kind=document", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    data = res.json();
    expect(data.total).toBe(3);
    expect(new Set((data.items as Array<Record<string, any>>).map((f) => f.filename))).toEqual(
      new Set(["doc1.pdf", "doc2.docx", "doc3.txt"]),
    );

    // Kind video
    res = await app.inject({ method: "GET", url: "/api/files?kind=video", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    data = res.json();
    expect(data.total).toBe(2);
    expect(new Set((data.items as Array<Record<string, any>>).map((f) => f.filename))).toEqual(
      new Set(["vid1.mp4", "vid2.webm"]),
    );

    // Kind archive (catch-all for other extensions)
    res = await app.inject({ method: "GET", url: "/api/files?kind=archive", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    data = res.json();
    expect(data.total).toBe(2);
    expect(new Set((data.items as Array<Record<string, any>>).map((f) => f.filename))).toEqual(
      new Set(["arc1.zip", "arc2.tar.gz"]),
    );
  });

  it("test_api_files_sort_name_and_size_and_expiry", async () => {
    const app = await authServer();
    const baseTime = nowSeconds();

    // file A: name="Zeta.txt", size=500, expires in 200s (ttl=200, created=now)
    await storeRawFile("id-a", "Zeta.txt", 200, baseTime, 500);
    // file B: name="Alpha.txt", size=1000, never expires (ttl=0, created=now - 50)
    await storeRawFile("id-b", "Alpha.txt", 0, baseTime - 50, 1000);
    // file C: name="Beta.txt", size=100, expires in 50s (ttl=50, created=now)
    await storeRawFile("id-c", "Beta.txt", 50, baseTime, 100);

    // Sort name: Alpha, Beta, Zeta
    let res = await app.inject({ method: "GET", url: "/api/files?sort=name", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect((res.json().items as Array<Record<string, any>>).map((f) => f.filename)).toEqual([
      "Alpha.txt",
      "Beta.txt",
      "Zeta.txt",
    ]);

    // Sort size: 1000 (Alpha), 500 (Zeta), 100 (Beta)
    res = await app.inject({ method: "GET", url: "/api/files?sort=size", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect((res.json().items as Array<Record<string, any>>).map((f) => f.size_bytes)).toEqual([1000, 500, 100]);

    // Sort expiry: Beta (50s), Zeta (200s), Alpha (never expires: -1 at end)
    res = await app.inject({ method: "GET", url: "/api/files?sort=expiry", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect((res.json().items as Array<Record<string, any>>).map((f) => f.filename)).toEqual([
      "Beta.txt",
      "Zeta.txt",
      "Alpha.txt",
    ]);
  });

  it("test_api_files_aggregates_reflect_full_filtered_set_and_mcp_paginated", async () => {
    const app = await authServer();
    const baseTime = nowSeconds();

    // Create 60 image files (each 100 bytes): 30 expiring soon (ttl=1800) and 30 never expiring (ttl=0)
    for (let i = 0; i < 60; i += 1) {
      const fid = "img-" + String(i).padStart(3, "0");
      const ttl = i < 30 ? 1800 : 0;
      await storeRawFile(fid, "photo_" + String(i).padStart(3, "0") + ".png", ttl, baseTime + i, 100);
    }

    // Create 10 non-image files (each 200 bytes, ttl=1800)
    for (let i = 0; i < 10; i += 1) {
      const fid = "txt-" + String(i).padStart(3, "0");
      await storeRawFile(fid, "doc_" + String(i).padStart(3, "0") + ".txt", 1800, baseTime + 100 + i, 200);
    }

    // 1. Check page 1 with kind=image filter
    let res = await app.inject({ method: "GET", url: "/api/files?kind=image&page=1", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    let data = res.json();
    expect(data.items.length).toBe(50);
    expect(data.total).toBe(60);
    expect(data.page).toBe(1);
    expect(data.page_size).toBe(50);
    expect(data.total_pages).toBe(2);
    // Full filtered set: 60 images * 100 bytes = 6000 bytes (not just 50 * 100)
    expect(data.total_size_bytes).toBe(6000);
    // Full filtered set: 30 expiring soon images (not just those in page 1)
    expect(data.expiring_soon_count).toBe(30);

    // 2. Check page 2 with kind=image filter
    res = await app.inject({ method: "GET", url: "/api/files?kind=image&page=2", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    data = res.json();
    expect(data.items.length).toBe(10);
    expect(data.total).toBe(60);
    expect(data.page).toBe(2);
    expect(data.total_size_bytes).toBe(6000);
    expect(data.expiring_soon_count).toBe(30);

    // 3. Check MCP list_files() returns paginated format (max 50 items)
    const mcpRes = await listFiles();
    expect(typeof mcpRes).toBe("object");
    expect(mcpRes.items.length).toBe(50);
    expect(mcpRes.total).toBe(70);
    expect(mcpRes.page).toBe(1);
    expect(mcpRes.page_size).toBe(50);
    expect(mcpRes.total_pages).toBe(2);
    expect(mcpRes.items.every((file) => "id" in file && "filename" in file)).toBe(true);
  });

  it("test_expiring_soon_count_boundary_condition", async () => {
    const baseTime = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(baseTime * 1000);

    const app = await authServer();

    // File 1: expires in exactly 3600s -> NOT expiring soon (< 3600)
    await storeRawFile("f-boundary-3600", "file3600.txt", 3600, baseTime, 10);
    // File 2: expires in 3599s -> IS expiring soon (< 3600)
    await storeRawFile("f-boundary-3599", "file3599.txt", 3600, baseTime - 1, 10);
    // File 3: never expires (ttl=0, expires_in=-1)
    await storeRawFile("f-boundary-never", "filenever.txt", 0, baseTime, 10);

    const res = await app.inject({ method: "GET", url: "/api/files", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    const itemsById: Record<string, any> = {};
    for (const item of data.items as Array<Record<string, any>>) {
      itemsById[item.id as string] = item;
    }
    expect(itemsById["f-boundary-3600"].expires_in).toBe(3600);
    expect(itemsById["f-boundary-3599"].expires_in).toBe(3599);
    expect(itemsById["f-boundary-never"].expires_in).toBe(-1);
    // Exactly 3600s must NOT be counted in expiring_soon_count (< 3600)
    expect(data.expiring_soon_count).toBe(1);
  });
});

describe("MCP setup and pages", () => {
  it("test_mcp_setup_unauthenticated", async () => {
    const app = await anonServer();

    // Browser request (Accept: text/html) redirects to /auth/login
    const resBrowser = await app.inject({
      method: "GET",
      url: "/mcp-setup",
      headers: { accept: "text/html" },
    });
    expect(resBrowser.statusCode).toBe(302);
    expect(resBrowser.headers.location).toBe("/auth/login");

    // API client request returns 401
    const resApi = await app.inject({ method: "GET", url: "/mcp-setup" });
    expect(resApi.statusCode).toBe(401);
    expect(resApi.json().error).toBe("unauthorized");
  });

  it("test_mcp_setup_authenticated", async () => {
    const secretKey = "super-secret-mcp-key-xyz-987";
    const app = await anonServer(secretKey, TEST_API_KEY);

    const res = await app.inject({ method: "GET", url: "/mcp-setup", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"] ?? "")).toContain("text/html");

    const html = res.body;

    // 1) Endpoint real: BASE_URL + '/mcp'
    expect(html).toContain(config.baseUrl + "/mcp");

    // 2) 5 tools with names and their docstrings
    const expectedTools: Array<[string, string]> = [
      ["upload_file", "Upload a file encoded in base64 with TTL in seconds (0 = never expires)."],
      ["list_files", "List active (non-expired) files with metadata."],
      ["get_file_info", "Get metadata for a specific active file."],
      ["extend_ttl", "Extend or update TTL for an existing file."],
      ["delete_file", "Delete a file by ID."],
    ];
    for (const [toolName, toolDesc] of expectedTools) {
      expect(html).toContain(toolName);
      expect(html).toContain(toolDesc);
    }

    // 3) JSON example with X-API-Key and BASE_URL/mcp
    expect(html).toContain('"mcpServers"');
    expect(html).toContain('"tmpup"');
    expect(html).toContain('"type": "http"');
    expect(html).toContain("X-API-Key");
    expect(html).toContain("SUA_CHAVE_AQUI");

    // 4) Page NEVER contains the real value of TMPUP_API_KEYS
    expect(html).not.toContain(secretKey);
  });

  it("test_mcp_link_in_html_template", async () => {
    // Only the authenticated GET / behaviour: the pure HTML_TEMPLATE assertions
    // are already ported in test/templates.test.ts.
    const app = await authServer();
    const res = await app.inject({ method: "GET", url: "/", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/mcp-setup"');
    expect(res.body).toContain("MCP");
  });
});

describe("async request path", () => {
  it("test_routes_are_async_def", async () => {
    // Python asserted the endpoints were async def and offloaded blocking IO to
    // starlette.concurrency.run_in_threadpool. Node has no threadpool hop: the
    // equivalent guarantee is an async request path backed by node:fs/promises,
    // so every request-path helper must return a promise.
    const { fileId } = await storeUuidFile({ filename: "t.png", ttl: 3600, content: Buffer.from("fakepng") });

    const downloadPromise = downloadFile(fileId, "t.png");
    expect(downloadPromise).toBeInstanceOf(Promise);
    await downloadPromise;

    const viewPromise = viewFile(fileId, "t.png");
    expect(viewPromise).toBeInstanceOf(Promise);
    await viewPromise;

    const thumbnailPromise = thumbnailFile(fileId, "t.png");
    expect(thumbnailPromise).toBeInstanceOf(Promise);
    await thumbnailPromise;

    const listPromise = storage.listActiveFiles();
    expect(listPromise).toBeInstanceOf(Promise);
    await listPromise;

    const infoPromise = getFileInfo(fileId);
    expect(infoPromise).toBeInstanceOf(Promise);
    await infoPromise;

    const extendPromise = extendFileTtl(fileId, 7200);
    expect(extendPromise).toBeInstanceOf(Promise);
    await extendPromise;

    const thumbDeletePromise = deleteThumbnail(fileId);
    expect(thumbDeletePromise).toBeInstanceOf(Promise);
    await thumbDeletePromise;

    const deletePromise = deleteFileById(fileId);
    expect(deletePromise).toBeInstanceOf(Promise);
    await deletePromise;

    const cleanupPromise = storage.cleanupExpiredFiles();
    expect(cleanupPromise).toBeInstanceOf(Promise);
    await cleanupPromise;

    const ensurePromise = storage.ensureDataDir();
    expect(ensurePromise).toBeInstanceOf(Promise);
    await ensurePromise;
  });

  it("request-path sources use no synchronous fs calls (threadpool guard)", async () => {
    const requestPathSources = [
      "../src/routes/auth.ts",
      "../src/routes/files.ts",
      "../src/routes/pages.ts",
      "../src/routes/transfer.ts",
      "../src/storage.ts",
      "../src/files.ts",
    ];
    const forbidden = ["readFileSync(", "writeFileSync(", "statSync(", "existsSync(", "readdirSync("];
    for (const source of requestPathSources) {
      const text = await fsp.readFile(fileURLToPath(new URL(source, import.meta.url)), "utf8");
      for (const call of forbidden) {
        expect(text.includes(call), source + " must not call " + call).toBe(false);
      }
    }
  });

  it("test_download_and_view_file_helpers_are_sync", async () => {
    // Python: these extracted helpers were synchronous functions (invoked via
    // run_in_threadpool). Node equivalent: async functions that can be awaited
    // directly and return the same descriptor objects.
    expect(downloadFile.constructor.name).toBe("AsyncFunction");
    expect(viewFile.constructor.name).toBe("AsyncFunction");
    expect(thumbnailFile.constructor.name).toBe("AsyncFunction");

    const fileId = randomUUID();
    const { metadataPath } = await storeUuidFile({
      fileId,
      filename: "test.png",
      ttl: 3600,
      content: Buffer.from("fakepng"),
    });

    // Call downloadFile directly and await it.
    const resp = await downloadFile(fileId, "test.png");
    expect(typeof resp.filePath).toBe("string");
    expect(resp.mediaType).toBe("image/png");
    expect(resp.headers).toEqual({ "Content-Disposition": "inline" });

    // Verify views incremented.
    const reloaded = await reloadMeta(metadataPath);
    expect(reloaded.views).toBe(1);

    // Call downloadFile with dl=1
    const respDl = await downloadFile(fileId, "test.png", "1");
    expect(String(respDl.headers["Content-Disposition"])).toContain("attachment");

    // Verify downloads incremented.
    const reloadedDl = await reloadMeta(metadataPath);
    expect(reloadedDl.downloads).toBe(1);

    // viewFile for an image returns the HTML viewer descriptor.
    const viewResp = await viewFile(fileId, "test.png");
    expect("html" in viewResp).toBe(true);
    expect((viewResp as { html: string }).html).toContain("test.png");

    // viewFile for a non-image returns the redirect descriptor.
    const txtId = randomUUID();
    await storeUuidFile({ fileId: txtId, filename: "doc.txt", ttl: 3600, content: Buffer.from("text") });
    const viewTxtResp = await viewFile(txtId, "doc.txt");
    expect(viewTxtResp).toEqual({ statusCode: 307, location: "/d/" + txtId + "/doc.txt" });

    // 404 behaviour rejects with HttpError.
    await expectHttpError(downloadFile("invalid-id", "test.png"), 404);
    await expectHttpError(viewFile("invalid-id", "test.png"), 404);
  });
});

/**
 * Regression: POST /api/upload must persist the exact request bytes for every
 * content type. Fastify's built-in JSON/text parsers consume the body before
 * the handler runs, so re-encoding the parsed value corrupts the upload
 * (minified JSON, quoted text). app.py streamed \`request.stream()\` raw, so
 * anything but byte-for-byte storage is a porting regression.
 */
describe("upload body fidelity", () => {
  async function uploadRaw(contentType: string, body: Buffer, filename: string): Promise<Buffer> {
    const app = await authServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: {
        ...authHeader(),
        "x-filename": filename,
        "x-ttl": "3600",
        "content-type": contentType,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().id as string;

    const download = await app.inject({ method: "GET", url: "/d/" + id + "/" + filename });
    expect(download.statusCode).toBe(200);
    return download.rawPayload;
  }

  it("stores text/plain bodies byte for byte", async () => {
    const body = Buffer.from("linha 1\nlinha 2 com acentos: ção\n", "utf8");
    expect(await uploadRaw("text/plain", body, "notas.txt")).toEqual(body);
  });

  it("stores application/json bodies byte for byte (no re-serialization)", async () => {
    const body = Buffer.from('{\n  "a": 1,\n  "b": [1, 2, 3]\n}\n', "utf8");
    expect(await uploadRaw("application/json", body, "dados.json")).toEqual(body);
  });

  it("stores unknown content types byte for byte", async () => {
    const body = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x10]);
    expect(await uploadRaw("application/x-custom", body, "blob.bin")).toEqual(body);
  });
});

/**
 * The MCP setup page interpolates config.baseUrl in three places. BASE_URL is
 * operator-controlled, but a value containing markup must not be able to inject
 * HTML into the page (app.py interpolated the JSON config raw).
 */
describe("mcp-setup page escaping", () => {
  it("neutralizes markup coming from BASE_URL", async () => {
    const app = await authServer();
    const original = config.baseUrl;
    try {
      config.baseUrl = "https://evil.example.com/<script>alert(1)</script>";
      const res = await app.inject({ method: "GET", url: "/mcp-setup", headers: authHeader() });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("<script>alert(1)</script>");
      expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    } finally {
      config.baseUrl = original;
    }
  });

  it("keeps the copy button attribute intact when BASE_URL contains a quote", async () => {
    const app = await authServer();
    const original = config.baseUrl;
    try {
      config.baseUrl = "https://evil.example.com/'onmouseover='alert(1)";
      const res = await app.inject({ method: "GET", url: "/mcp-setup", headers: authHeader() });
      expect(res.statusCode).toBe(200);
      // With the apostrophe escaped the attribute still terminates where the
      // template says it does; without escaping the injected quote would close
      // it early and this pattern would no longer match.
      const button = res.body.match(/onclick='copyText\(this, ([^']*\))'/);
      expect(button).not.toBeNull();
      expect(button?.[1]).toContain("&#x27;");
    } finally {
      config.baseUrl = original;
    }
  });
});

/**
 * The upload guarantee has to hold on a real socket too: with app.inject() the
 * body arrives pre-buffered, so only a listen()+fetch() test proves that the
 * raw Fastify stream is what gets written to disk.
 */
describe("upload body fidelity over a real socket", () => {
  it("stores application/json bytes exactly as sent over HTTP", async () => {
    const app = await authServer();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const body = '{\n  "socket": true,\n  "x": [1, 2]\n}\n';
      const upload = await fetch(address + "/api/upload", {
        method: "POST",
        headers: {
          ...authHeader(),
          "x-filename": "socket.json",
          "x-ttl": "3600",
          "content-type": "application/json",
        },
        body,
      });
      expect(upload.status).toBe(200);
      const id = ((await upload.json()) as { id: string }).id;

      const download = await fetch(address + "/d/" + id + "/socket.json");
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).toString("utf8")).toBe(body);
    } finally {
      await app.close();
    }
  });
});

/**
 * The MCP body limit must answer the client instead of tearing the socket down
 * mid-stream (Fastify's own bodyLimit no longer applies to streamed bodies).
 */
describe("MCP body limit over a real socket", () => {
  it("answers 413 for an oversized chunked body", async () => {
    // The route captures the limit when the server is built, so set it first.
    const originalLimit = config.maxMcpUploadSize;
    config.maxMcpUploadSize = 512;
    const app = await authServer();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      // A ReadableStream body has no content-length, so the handler has to hit
      // its own read limit instead of the cheap header check.
      const oversized = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
          controller.close();
        },
      });
      const response = await fetch(address + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: oversized,
        // node fetch requires duplex for a streaming request body
        duplex: "half",
      });
      expect(response.status).toBe(413);
      const payload = (await response.json()) as { error: { code: number } };
      expect(payload.error.code).toBe(-32000);
    } finally {
      config.maxMcpUploadSize = originalLimit;
      await app.close();
    }
  });
});



