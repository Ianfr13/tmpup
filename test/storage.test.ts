/**
 * Ported 1:1 from test_app.py (storage/model/listing/thumbnail unit tests).
 *
 * The Python suite's autouse `isolate_data_dir` fixture is the `makeDataDir()`
 * call in `beforeEach`; `capsys` is `vi.spyOn(console, "log")` + `readOut()`
 * (log_event prints one JSON line per event).
 *
 * Adaptations (Python-only details, documented rather than weakened):
 *  - `test_validate_ttl_rejects_bool_and_float`: JS has a single `number` type,
 *    so `1.0` is literally identical to `1` and cannot be distinguished from an
 *    integer. The bool rejections and the non-integer float (3.9) are kept; the
 *    `1.0` case is impossible to express and is asserted as the Python int it
 *    is at runtime (see the test body).
 *  - `test_direct_malicious_file_id_validation`: the `_download_file` /
 *    `_view_file` 404 assertions belong to src/routes/transfer.ts and live in
 *    test/routes.test.ts (owned by the routes layer); every storage-level
 *    assertion is ported here.
 *  - Thumbnail fixtures use `sharp` instead of PIL; the temp-file assertion
 *    spies on `fs/promises.rename` (the atomic replace) instead of PIL's
 *    `Image.save`, which is the closest equivalent seam.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { filterSortPaginateFiles } from "../src/files.js";
import { logEvent } from "../src/logger.js";
import {
  FileMetadata,
  deleteFileById,
  deleteThumbnail,
  extendFileTtl,
  fileMetaDict,
  generateThumbnail,
  getFileInfo,
  getFilePaths,
  listActiveFiles,
  validateTtl,
} from "../src/storage.js";
import type { PublicFileMetadata } from "../src/types.js";
import { makeDataDir, removeDataDir, restoreConfig } from "./helpers.js";

let dataDir = "";
let captured: string[] = [];
const extraDirs: string[] = [];

/** Python's `time.time()`. */
function nowSeconds(): number {
  return Date.now() / 1000;
}

/** capsys.readouterr().out — returns (and clears) everything logged since last call. */
function readOut(): string {
  const out = captured.join("\n");
  captured = [];
  return out ? out + "\n" : "";
}

/** tmp_path for the thumbnail tests (tracked for cleanup). */
async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), "tmpup-thumb-"));
  extraDirs.push(dir);
  return dir;
}

interface RgbBackground {
  r: number;
  g: number;
  b: number;
  alpha?: number;
}

/** PIL `Image.new(...).save(path, format="PNG")` equivalent. */
async function createPng(
  filePath: string,
  width: number,
  height: number,
  background: RgbBackground,
  channels: 3 | 4 = 3,
): Promise<void> {
  await sharp({ create: { width, height, channels, background } }).png().toFile(filePath);
}

beforeEach(async () => {
  captured = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  });
  dataDir = await makeDataDir();
});

afterEach(async () => {
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

describe("validate_ttl", () => {
  it("test_validate_ttl_valid", () => {
    expect(validateTtl(0)).toBe(0);
    expect(validateTtl(1)).toBe(1);
    expect(validateTtl(3600)).toBe(3600);
    expect(validateTtl(31536000)).toBe(31536000);
  });

  it("test_validate_ttl_invalid", () => {
    expect(() => validateTtl(-1)).toThrow(Error);
    expect(() => validateTtl(31536001)).toThrow(Error);
    expect(() => validateTtl("invalid")).toThrow(Error);
  });

  it("test_validate_ttl_rejects_bool_and_float", () => {
    expect(() => validateTtl(true)).toThrow("TTL must be a valid integer");
    expect(() => validateTtl(false)).toThrow("TTL must be a valid integer");
    expect(() => validateTtl(3.9)).toThrow("TTL must be a valid integer");
    // Python: isinstance(1.0, int) is False, so validate_ttl(1.0) raised.
    // JS has one number type: 1.0 === 1, so the closest faithful equivalent is
    // that the integral value is accepted (the Python-only float tag is gone).
    expect(validateTtl(1.0)).toBe(1);
  });

  it("test_validate_ttl_boundary_and_simplified_check", () => {
    expect(validateTtl(0)).toBe(0);
    expect(validateTtl(86400 * 365)).toBe(86400 * 365);
    expect(() => validateTtl(-1)).toThrow(/TTL must be 0 .* or between 1 and 31536000/);
    expect(() => validateTtl(86400 * 365 + 1)).toThrow(/TTL must be 0 .* or between 1 and 31536000/);
  });
});

describe("FileMetadata", () => {
  it("test_file_metadata_defaults_and_backwards_compatibility", () => {
    const now = 1000.0;
    const meta = new FileMetadata("id1", "file.txt", 3600, now);
    expect(meta.views).toBe(0);
    expect(meta.downloads).toBe(0);
    expect(meta.lastViewedAt).toBeNull();
    expect(meta.lastDownloadedAt).toBeNull();
    expect(meta.sizeBytes).toBe(0);
    expect(meta.toDict()).toEqual({
      file_id: "id1",
      filename: "file.txt",
      ttl: 3600,
      created_at: now,
      views: 0,
      downloads: 0,
      last_viewed_at: null,
      last_downloaded_at: null,
      size_bytes: 0,
    });

    const legacyData = {
      file_id: "old-id",
      filename: "old.txt",
      ttl: 1800,
      created_at: 500.0,
    };
    const metaLegacy = FileMetadata.fromDict(legacyData);
    expect(metaLegacy.fileId).toBe("old-id");
    expect(metaLegacy.filename).toBe("old.txt");
    expect(metaLegacy.ttl).toBe(1800);
    expect(metaLegacy.createdAt).toBe(500.0);
    expect(metaLegacy.views).toBe(0);
    expect(metaLegacy.downloads).toBe(0);
    expect(metaLegacy.lastViewedAt).toBeNull();
    expect(metaLegacy.lastDownloadedAt).toBeNull();
    expect(metaLegacy.sizeBytes).toBe(0);

    const fullData = {
      file_id: "id2",
      filename: "new.txt",
      ttl: 1800,
      created_at: 500.0,
      views: 5,
      downloads: 3,
      last_viewed_at: 600.0,
      last_downloaded_at: 700.0,
      size_bytes: 2048,
    };
    const metaFull = FileMetadata.fromDict(fullData);
    expect(metaFull.views).toBe(5);
    expect(metaFull.downloads).toBe(3);
    expect(metaFull.lastViewedAt).toBe(600.0);
    expect(metaFull.lastDownloadedAt).toBe(700.0);
    expect(metaFull.sizeBytes).toBe(2048);
    expect(metaFull.toDict()).toEqual(fullData);
  });

  it("test_file_meta_dict_helper", async () => {
    const now = nowSeconds();
    const meta = new FileMetadata("test-id", "doc.pdf", 7200, now);
    const metaDict = await fileMetaDict(meta);
    expect(Object.keys(metaDict).sort()).toEqual(
      [
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
        "folder_id",
      ].sort(),
    );
    expect(metaDict).toMatchObject({
      id: "test-id",
      filename: "doc.pdf",
      url: config.baseUrl + "/d/test-id/doc.pdf",
      view_url: config.baseUrl + "/v/test-id/doc.pdf",
      is_image: false,
      created_at: now,
      size_bytes: 0,
      views: 0,
      downloads: 0,
      last_viewed_at: null,
      last_downloaded_at: null,
    });
    // expires_in is the remaining TTL from ttl=7200. The helper and the
    // assertion can straddle a second boundary (Python had the same window),
    // so assert the exact two-value window instead of a snapshot value.
    expect([7199, 7200]).toContain(metaDict.expires_in);
  });

  it("test_file_meta_dict_real_file_size_and_metrics", async () => {
    const fileId = randomUUID();
    const content = Buffer.alloc(1234, "x");
    fs.writeFileSync(path.join(dataDir, fileId), content);
    const now = nowSeconds();
    const meta = new FileMetadata(fileId, "report.pdf", 3600, now, 4, 2, now - 50, now - 10);
    const metaDict = await fileMetaDict(meta);
    expect(metaDict.size_bytes).toBe(1234);
    expect(metaDict.views).toBe(4);
    expect(metaDict.downloads).toBe(2);
    expect(metaDict.last_viewed_at).toBe(now - 50);
    expect(metaDict.last_downloaded_at).toBe(now - 10);

    // If file is missing on disk, size_bytes must be 0 without raising.
    fs.unlinkSync(path.join(dataDir, fileId));
    const missingDict = await fileMetaDict(meta);
    expect(missingDict.size_bytes).toBe(0);
  });
});

describe("listing", () => {
  it("test_list_active_files", async () => {
    expect(await listActiveFiles()).toEqual([]);

    const t = nowSeconds();

    // File 1: active image
    const meta1 = new FileMetadata("id-1", "test1.png", 3600, t - 100);
    await meta1.save(path.join(dataDir, "id-1.meta.json"));
    fs.writeFileSync(path.join(dataDir, "id-1"), "content1");

    // File 2: active text (newer)
    const meta2 = new FileMetadata("id-2", "test2.txt", 0, t - 10);
    await meta2.save(path.join(dataDir, "id-2.meta.json"));
    fs.writeFileSync(path.join(dataDir, "id-2"), "content2");

    // File 3: expired
    const meta3 = new FileMetadata("id-3", "test3.txt", 10, t - 1000);
    await meta3.save(path.join(dataDir, "id-3.meta.json"));
    fs.writeFileSync(path.join(dataDir, "id-3"), "content3");

    const files = await listActiveFiles();
    expect(files.length).toBe(2);
    // Sorted by created_at desc -> id-2 first, then id-1
    expect(files[0]!.id).toBe("id-2");
    expect(files[0]!.filename).toBe("test2.txt");
    expect(files[0]!.is_image).toBe(false);
    expect(files[0]!.expires_in).toBe(-1);
    expect(files[0]!).toHaveProperty("url");
    expect(files[0]!).toHaveProperty("view_url");

    expect(files[1]!.id).toBe("id-1");
    expect(files[1]!.filename).toBe("test1.png");
    expect(files[1]!.is_image).toBe(true);
  });

  it("test_get_file_info_existing_and_missing", async () => {
    expect(await getFileInfo("non-existent")).toBeNull();

    const activeId = randomUUID();
    const meta = new FileMetadata(activeId, "photo.jpg", 1800, nowSeconds());
    await meta.save(path.join(dataDir, activeId + ".meta.json"));
    fs.writeFileSync(path.join(dataDir, activeId), "image-data");

    const info = await getFileInfo(activeId);
    expect(info).not.toBeNull();
    expect(info!.id).toBe(activeId);
    expect(info!.filename).toBe("photo.jpg");
    expect(info!.is_image).toBe(true);
    expect(info!.expires_in).toBeGreaterThanOrEqual(0);
    expect(info!.expires_in).toBeLessThanOrEqual(1800);
    expect(info!).toHaveProperty("url");
    expect(info!).toHaveProperty("view_url");

    const expId = randomUUID();
    const metaExp = new FileMetadata(expId, "old.txt", 10, nowSeconds() - 50);
    await metaExp.save(path.join(dataDir, expId + ".meta.json"));
    fs.writeFileSync(path.join(dataDir, expId), "old-data");

    expect(await getFileInfo(expId)).toBeNull();
  });
});

describe("filter_sort_paginate_files", () => {
  it("test_filter_sort_paginate_files_unit", () => {
    const files = [
      { filename: "a.txt", size_bytes: 100, expires_in: 10, created_at: 1 },
      { filename: "b.jpg", size_bytes: 500, expires_in: -1, created_at: 2 },
      { filename: "c.zip", size_bytes: 200, expires_in: 5000, created_at: 3 },
    ] as unknown as PublicFileMetadata[];

    // Test empty list
    const resEmpty = filterSortPaginateFiles([]);
    expect(resEmpty.items).toEqual([]);
    expect(resEmpty.total).toBe(0);
    expect(resEmpty.total_pages).toBe(0);
    expect(resEmpty.total_size_bytes).toBe(0);
    expect(resEmpty.expiring_soon_count).toBe(0);

    // Test page clamp (< 1 becomes 1)
    const resClamp = filterSortPaginateFiles(files, { page: 0 });
    expect(resClamp.page).toBe(1);
    expect(resClamp.items.length).toBe(3);

    // Test kind filter
    const resKind = filterSortPaginateFiles(files, { kind: "image" });
    expect(resKind.items.length).toBe(1);
    expect(resKind.items[0]!.filename).toBe("b.jpg");

    // Test sort by size descending
    const resSortSize = filterSortPaginateFiles(files, { sort: "size" });
    expect(resSortSize.items.map((f) => f.filename)).toEqual(["b.jpg", "c.zip", "a.txt"]);

    // Test expiring_soon_count: expires_in between 0 and 3600 (only a.txt has 10s)
    expect(resSortSize.expiring_soon_count).toBe(1);
    expect(resSortSize.total_size_bytes).toBe(800);
  });
});

describe("log_event", () => {
  it("test_log_event", () => {
    logEvent("test_event", { foo: "bar", num: 123 });
    const data = JSON.parse(readOut().trim());
    expect(data).toEqual({ svc: "tmpup", event: "test_event", foo: "bar", num: 123 });
  });
});

describe("delete_file_by_id", () => {
  it("test_delete_file_by_id", async () => {
    expect(await deleteFileById("missing-id")).toBe(false);
    let data = JSON.parse(readOut().trim());
    expect(data.svc).toBe("tmpup");
    expect(data.event).toBe("file_delete_failed");
    expect(data.file_id).toBe("missing-id");

    const delId = randomUUID();
    const filePath = path.join(dataDir, delId);
    const metaPath = path.join(dataDir, delId + ".meta.json");
    fs.writeFileSync(filePath, "content");
    await new FileMetadata(delId, "test.txt", 3600, nowSeconds()).save(metaPath);

    expect(await deleteFileById(delId)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(metaPath)).toBe(false);

    data = JSON.parse(readOut().trim());
    expect(data.svc).toBe("tmpup");
    expect(data.event).toBe("file_deleted");
    expect(data.file_id).toBe(delId);
  });

  it("test_delete_file_by_id_propagates_unexpected_exception", async () => {
    const validId = randomUUID();
    const filePath = path.join(dataDir, validId);
    const metaPath = path.join(dataDir, validId + ".meta.json");
    fs.writeFileSync(filePath, "content");
    await new FileMetadata(validId, "test.txt", 3600, nowSeconds()).save(metaPath);

    vi.spyOn(fsp, "unlink").mockRejectedValue(new Error("Permission denied: simulated delete failure"));

    await expect(deleteFileById(validId)).rejects.toThrow(/Permission denied/);
  });

  it("test_delete_file_by_id_handles_race_condition_file_not_found", async () => {
    const fileId = randomUUID();
    const { filePath, metadataPath } = getFilePaths(fileId);
    fs.writeFileSync(filePath, "content");
    await new FileMetadata(fileId, "test.txt", 3600, nowSeconds()).save(metadataPath);

    // Simulate concurrent deletion where unlink raises FileNotFoundError
    vi.spyOn(fsp, "unlink").mockRejectedValue(
      Object.assign(new Error("Simulated concurrent unlink"), { code: "ENOENT" }),
    );
    expect(await deleteFileById(fileId)).toBe(false);

    const out = readOut();
    expect(out).toContain("file_delete_failed");
    expect(out).toContain("not_found");
  });

  it("test_delete_file_by_id_rapid_consecutive_deletes", async () => {
    const fileId = randomUUID();
    const { filePath, metadataPath } = getFilePaths(fileId);
    fs.writeFileSync(filePath, "content");
    await new FileMetadata(fileId, "test.txt", 3600, nowSeconds()).save(metadataPath);

    expect(await deleteFileById(fileId)).toBe(true);
    expect(await deleteFileById(fileId)).toBe(false);
  });

  it("test_delete_file_by_id_propagates_non_file_not_found", async () => {
    const fileId = randomUUID();
    const { filePath, metadataPath } = getFilePaths(fileId);
    fs.writeFileSync(filePath, "content");
    await new FileMetadata(fileId, "test.txt", 3600, nowSeconds()).save(metadataPath);

    vi.spyOn(fsp, "unlink").mockRejectedValue(new Error("Simulated permission denied"));
    await expect(deleteFileById(fileId)).rejects.toThrow(/Simulated permission denied/);
  });

  it("test_direct_malicious_file_id_validation", async () => {
    const outsideDir = await makeTempDir();
    const canary = path.join(outsideDir, "secret.txt");
    const canaryBytes = Buffer.from("top-secret-canary");
    fs.writeFileSync(canary, canaryBytes);
    const canaryMtime = fs.statSync(canary, { bigint: true }).mtimeNs;

    const maliciousIds = [
      "../../etc/cron.d/x",
      "/etc/passwd",
      "nao-e-uuid",
      "../outside_direct/secret.txt",
      "../../../etc/shadow",
      "invalid-uuid-12345",
      "../../DATA_DIR",
    ];

    for (const badId of maliciousIds) {
      // get_file_paths must raise ValueError
      expect(() => getFilePaths(badId)).toThrow(/Invalid file ID/);

      // _get_file_info must return None
      expect(await getFileInfo(badId)).toBeNull();

      // delete_file_by_id must return False
      expect(await deleteFileById(badId)).toBe(false);

      // extend_file_ttl must return None
      expect(await extendFileTtl(badId, 3600)).toBeNull();

      // _download_file / _view_file 404 assertions live in test/routes.test.ts.
    }

    // Canary must remain intact
    expect(fs.existsSync(canary)).toBe(true);
    expect(fs.readFileSync(canary).equals(canaryBytes)).toBe(true);
    expect(fs.statSync(canary, { bigint: true }).mtimeNs).toBe(canaryMtime);
  });
});

describe("extend_file_ttl", () => {
  it("test_extend_file_ttl_not_found", async () => {
    const res = await extendFileTtl("non-existent-id", 3600);
    expect(res).toBeNull();
    const data = JSON.parse(readOut().trim());
    expect(data.svc).toBe("tmpup");
    expect(data.event).toBe("extend_ttl_failed");
    expect(data.file_id).toBe("non-existent-id");
    expect(data.reason).toBe("not_found");
  });

  it("test_extend_file_ttl_invalid_ttl", async () => {
    const extId = randomUUID();
    const meta = new FileMetadata(extId, "doc.txt", 100, nowSeconds() - 50);
    await meta.save(path.join(dataDir, extId + ".meta.json"));
    fs.writeFileSync(path.join(dataDir, extId), "content");

    await expect(extendFileTtl(extId, -5)).rejects.toThrow(Error);

    expect(readOut()).toContain("extend_ttl_failed");
  });

  it("test_extend_file_ttl_success", async () => {
    const oldTime = nowSeconds() - 50;
    const extId2 = randomUUID();
    const meta = new FileMetadata(extId2, "doc.txt", 100, oldTime);
    await meta.save(path.join(dataDir, extId2 + ".meta.json"));
    fs.writeFileSync(path.join(dataDir, extId2), "content");

    const updated = await extendFileTtl(extId2, 7200);
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(extId2);
    expect(updated!.filename).toBe("doc.txt");
    expect(updated!.created_at).toBeGreaterThan(oldTime);
    expect(updated!.expires_in).toBeGreaterThan(7000);

    // Verify saved on disk
    const reloaded = await FileMetadata.fromFile(path.join(dataDir, extId2 + ".meta.json"));
    expect(reloaded!.ttl).toBe(7200);
    expect(reloaded!.createdAt).toBe(updated!.created_at);

    const data = JSON.parse(readOut().trim());
    expect(data.svc).toBe("tmpup");
    expect(data.event).toBe("extend_ttl_success");
    expect(data.file_id).toBe(extId2);
    expect(data.ttl).toBe(7200);
  });
});

describe("delete_thumbnail", () => {
  it("test_delete_thumbnail_removes_jpg_and_fail_marker", async () => {
    const fileId = randomUUID();
    const thumbPath = path.join(dataDir, fileId + ".thumb.jpg");
    const failPath = path.join(dataDir, fileId + ".thumb.fail");

    // Case 1: Neither exists - must execute silently without raising
    await deleteThumbnail(fileId);

    // Case 2: Both exist - must remove both
    fs.writeFileSync(thumbPath, "jpeg-bytes");
    fs.writeFileSync(failPath, "");
    expect(fs.existsSync(thumbPath)).toBe(true);
    expect(fs.existsSync(failPath)).toBe(true);

    await deleteThumbnail(fileId);
    expect(fs.existsSync(thumbPath)).toBe(false);
    expect(fs.existsSync(failPath)).toBe(false);

    // Case 3: Only .thumb.jpg exists
    fs.writeFileSync(thumbPath, "jpeg-bytes");
    expect(fs.existsSync(thumbPath)).toBe(true);
    await deleteThumbnail(fileId);
    expect(fs.existsSync(thumbPath)).toBe(false);

    // Case 4: Only .thumb.fail exists
    fs.writeFileSync(failPath, "");
    expect(fs.existsSync(failPath)).toBe(true);
    await deleteThumbnail(fileId);
    expect(fs.existsSync(failPath)).toBe(false);
  });

  it("test_delete_thumbnail_logs_unexpected_exceptions", async () => {
    const fileId = randomUUID();
    fs.writeFileSync(path.join(dataDir, fileId + ".thumb.jpg"), "content");

    vi.spyOn(fsp, "unlink").mockRejectedValue(new Error("Simulated disk error"));

    // Must not raise, but must log event
    await deleteThumbnail(fileId);

    const events = readOut()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const failEvents = events.filter((event) => event.event === "thumbnail_delete_failed");
    expect(failEvents.length).toBeGreaterThanOrEqual(1);
    expect(failEvents[0].file_id).toBe(fileId);
    expect(failEvents[0].error).toContain("Simulated disk error");
  });
});

describe("generate_thumbnail", () => {
  it("test_generate_thumbnail_large_image", async () => {
    const dir = await makeTempDir();
    const src = path.join(dir, "large_image.png");
    const thumb = path.join(dir, "large_image.thumb.jpg");

    // Create a 1000x1000 RGB test image
    await createPng(src, 1000, 1000, { r: 120, g: 180, b: 240 });

    const originalSize = fs.statSync(src).size;
    expect(originalSize).toBeGreaterThan(0);

    const success = await generateThumbnail(src, thumb, 200);
    expect(success).toBe(true);
    expect(fs.existsSync(thumb)).toBe(true);

    const thumbSize = fs.statSync(thumb).size;
    expect(thumbSize).toBeLessThan(originalSize / 2);

    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(200);
    expect([meta.width, meta.height]).toEqual([200, 200]);
  });

  it("test_generate_thumbnail_rgba_transparency", async () => {
    const dir = await makeTempDir();
    const src = path.join(dir, "transparent.png");
    const thumb = path.join(dir, "transparent.thumb.jpg");

    // 400x200 RGBA image with transparency
    await createPng(src, 400, 200, { r: 255, g: 0, b: 0, alpha: 0.5 }, 4);

    const success = await generateThumbnail(src, thumb, 200);
    expect(success).toBe(true);
    expect(fs.existsSync(thumb)).toBe(true);

    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(200);
    // Aspect ratio 2:1 preserved (200x100)
    expect([meta.width, meta.height]).toEqual([200, 100]);
    expect(meta.channels).toBe(3);

    // RGBA must be composited onto WHITE (over black the pixel would be 128,0,0).
    const { data, info } = await sharp(thumb).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    const red = data[0] ?? 0;
    const green = data[1] ?? 0;
    const blue = data[2] ?? 0;
    expect(red).toBeGreaterThanOrEqual(250);
    expect(green).toBeGreaterThanOrEqual(120);
    expect(green).toBeLessThanOrEqual(136);
    expect(blue).toBeGreaterThanOrEqual(120);
    expect(blue).toBeLessThanOrEqual(136);
  });

  it("test_generate_thumbnail_corrupt_file_returns_false", async () => {
    const dir = await makeTempDir();
    const corruptFile = path.join(dir, "fake_image.png");
    const thumb = path.join(dir, "fake.thumb.jpg");
    fs.writeFileSync(
      corruptFile,
      Buffer.concat([Buffer.from("not a valid png file at all "), Buffer.from([0x00, 0xff, 0xee, 0xdd])]),
    );

    const success = await generateThumbnail(corruptFile, thumb);
    expect(success).toBe(false);
    expect(fs.existsSync(thumb)).toBe(false);

    const data = JSON.parse(readOut().trim());
    expect(data.event).toBe("thumbnail_generation_failed");
    expect(data.file_id).toBe("fake");
    expect(typeof data.error).toBe("string");
    expect(data.error.length).toBeGreaterThan(0);
    expect(data.reason).toBe(data.error);
  });

  it("test_generate_thumbnail_uses_temp_file_and_leaves_no_tmp_leftover", async () => {
    const dir = await makeTempDir();
    const src = path.join(dir, "original.png");
    const thumb = path.join(dir, "original.thumb.jpg");
    await createPng(src, 300, 300, { r: 0, g: 128, b: 0 });

    const realRename = fsp.rename.bind(fsp);
    const savedTargets: string[] = [];
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      savedTargets.push(String(from));
      return realRename(from, to);
    });

    const success = await generateThumbnail(src, thumb, 150);
    expect(success).toBe(true);
    expect(fs.existsSync(thumb)).toBe(true);

    // The save target was a temporary file, not the final thumb path
    expect(savedTargets.length).toBe(1);
    expect(savedTargets[0]!).toContain(".tmp-");
    expect(savedTargets[0]!).not.toBe(thumb);

    // No .tmp-* files remain in the directory
    const tmpFiles = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(tmpFiles.length).toBe(0);
  });

  it("test_thumbnail_failure_preserves_existing_thumb_and_cleans_only_own_tmp", async () => {
    const dir = await makeTempDir();
    const src = path.join(dir, "image.png");
    const thumb = path.join(dir, "image.thumb.jpg");
    await createPng(src, 100, 100, { r: 0, g: 0, b: 255 });

    // Pre-create a valid existing thumbnail
    fs.writeFileSync(thumb, "pre-existing valid thumbnail content");

    // Simulate failure during the atomic replace with a temp file already written
    let saveCalled = false;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      void to;
      saveCalled = true;
      fs.writeFileSync(String(from), "partial temp content");
      throw new Error("Simulated crash during save");
    });

    const success = await generateThumbnail(src, thumb, 50);
    expect(success).toBe(false);
    expect(saveCalled).toBe(true);

    // The existing thumbnail MUST still exist and be intact
    expect(fs.existsSync(thumb)).toBe(true);
    expect(fs.readFileSync(thumb, "utf8")).toBe("pre-existing valid thumbnail content");

    // Any temp file created by this run must be cleaned up
    const tmpFiles = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(tmpFiles.length).toBe(0);
  });

  it("test_generate_thumbnail_exif_orientation_transposed", async () => {
    const dir = await makeTempDir();
    const src = path.join(dir, "exif_photo.jpg");
    const thumb = path.join(dir, "exif_photo.thumb.jpg");

    // Create 600x300 image with EXIF orientation 6 (90 degrees CW)
    await sharp({ create: { width: 600, height: 300, channels: 3, background: { r: 128, g: 0, b: 128 } } })
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6 })
      .toFile(src);
    expect((await sharp(src).metadata()).orientation).toBe(6);

    const success = await generateThumbnail(src, thumb, 200);
    expect(success).toBe(true);
    expect(fs.existsSync(thumb)).toBe(true);

    // Without exif_transpose: 600x300 resized to fit 200x200 would be (200, 100).
    // With exif_transpose: image is transposed to 300x600, resized to fit 200x200 it becomes (100, 200).
    const meta = await sharp(thumb).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });
});

/**
 * Regression: ids read from a sidecar must never reach the filesystem
 * unchecked. A corrupt/hand-edited <id>.meta.json used to feed deleteThumbnail
 * (and the thumbnail route) a raw string such as "../../victim".
 */
describe("sidecar ids are not trusted for filesystem paths", () => {
  it("deleteFileById never unlinks outside the data dir for a traversal id", async () => {
    const canonical = randomUUID();
    await fsp.writeFile(
      path.join(dataDir, canonical + ".meta.json"),
      JSON.stringify({
        file_id: "../../victim",
        filename: "x.txt",
        ttl: 3600,
        created_at: nowSeconds(),
      }),
    );
    const victim = path.join(path.dirname(dataDir), "victim.thumb.jpg");
    await fsp.writeFile(victim, "canario");

    await deleteFileById(canonical).catch(() => undefined);

    // The canary outside the data dir must survive.
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("getFileInfo ignores a sidecar whose embedded id is another file", async () => {
    const requested = randomUUID();
    const other = randomUUID();
    await fsp.writeFile(
      path.join(dataDir, requested + ".meta.json"),
      JSON.stringify({
        file_id: other,
        filename: "x.txt",
        ttl: 3600,
        created_at: nowSeconds(),
      }),
    );
    await fsp.writeFile(path.join(dataDir, requested), "content");

    expect(await getFileInfo(requested)).toBeNull();
  });
});
