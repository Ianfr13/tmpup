/**
 * Storage layer: the metadata sidecar model plus every file helper that
 * app.py keeps at module level (model 804-886, helpers 897-1070,
 * is_image_file/file_kind/generate_thumbnail/format_expiry 1614-1682).
 *
 * Async policy — "sync in Python = offloaded to a threadpool; in Node the
 * equivalent is async fs/promises on the request path". Every function that
 * touches the filesystem is therefore async and uses node:fs/promises, so a
 * listing over ~1880 sidecars never blocks the event loop. Only the pure
 * computation helpers stay synchronous: validateTtl, parseFileId,
 * getFilePaths, isImageFile, fileKind, formatExpiry, FileMetadata.fromDict /
 * toDict / the expiresAt / isExpired / expiresIn getters.
 */
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { config } from "./config.js";
import { logEvent } from "./logger.js";
import type { FileMetadataData, PublicFileMetadata } from "./types.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "avif"]);
const DOC_EXTENSIONS = new Set(["pdf", "doc", "docx", "txt"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);

const THUMB_SUFFIXES = [".thumb.jpg", ".thumb.fail"] as const;

/** Current POSIX timestamp in seconds (Python's `time.time()`). */
function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Python's `str(e) or type(e).__name__`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

/** Node's ENOENT / ENOTDIR equivalent of Python's FileNotFoundError. */
function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Async equivalent of Python's `Path.exists()`. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Metadata lock
// ---------------------------------------------------------------------------
// app.py used one global `threading.Lock` (comment: "single global lock, not
// per-file -- writes are rare/fast"). This is the single-threaded async
// equivalent: a FIFO promise chain exported so the route layer can reuse it for
// the view/download counters.
let metadataLockTail: Promise<void> = Promise.resolve();

/** Run `fn` while holding the single process-wide metadata lock. */
export async function withMetadataLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = metadataLockTail;
  let release!: () => void;
  metadataLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
export class FileMetadata {
  fileId: string;
  filename: string;
  ttl: number;
  createdAt: number;
  views: number;
  downloads: number;
  lastViewedAt: number | null;
  lastDownloadedAt: number | null;
  sizeBytes: number;

  constructor(
    fileId: string,
    filename: string,
    ttl: number,
    createdAt: number,
    views = 0,
    downloads = 0,
    lastViewedAt: number | null = null,
    lastDownloadedAt: number | null = null,
    sizeBytes = 0,
  ) {
    this.fileId = fileId;
    this.filename = filename;
    this.ttl = ttl;
    this.createdAt = createdAt;
    this.views = views;
    this.downloads = downloads;
    this.lastViewedAt = lastViewedAt;
    this.lastDownloadedAt = lastDownloadedAt;
    this.sizeBytes = sizeBytes;
  }

  get expiresAt(): number {
    return this.createdAt + this.ttl;
  }

  get isExpired(): boolean {
    if (this.ttl === 0) {
      return false;
    }
    return nowSeconds() > this.expiresAt;
  }

  get expiresIn(): number {
    if (this.ttl === 0) {
      return -1; // never expires
    }
    return Math.max(0, Math.trunc(this.expiresAt - nowSeconds()));
  }

  toDict(): FileMetadataData {
    return {
      file_id: this.fileId,
      filename: this.filename,
      ttl: this.ttl,
      created_at: this.createdAt,
      views: this.views,
      downloads: this.downloads,
      last_viewed_at: this.lastViewedAt,
      last_downloaded_at: this.lastDownloadedAt,
      size_bytes: this.sizeBytes,
    };
  }

  static fromDict(data: FileMetadataData): FileMetadata {
    return new FileMetadata(
      data.file_id,
      data.filename,
      data.ttl,
      data.created_at,
      data.views !== undefined ? data.views : 0,
      data.downloads !== undefined ? data.downloads : 0,
      data.last_viewed_at !== undefined ? data.last_viewed_at : null,
      data.last_downloaded_at !== undefined ? data.last_downloaded_at : null,
      data.size_bytes !== undefined ? data.size_bytes : 0,
    );
  }

  /** Load metadata from a JSON sidecar file (null on missing/corrupt JSON). */
  static async fromFile(metadataPath: string): Promise<FileMetadata | null> {
    try {
      const raw = await fsp.readFile(metadataPath, "utf8");
      return FileMetadata.fromDict(JSON.parse(raw) as FileMetadataData);
    } catch (err) {
      if (err instanceof SyntaxError || isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  /** Save metadata to a JSON sidecar file. */
  async save(metadataPath: string): Promise<void> {
    await fsp.writeFile(metadataPath, JSON.stringify(this.toDict()));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Validate TTL: 0 means never expires, otherwise 1..31536000 seconds. */
export function validateTtl(ttl: unknown): number {
  if (typeof ttl === "boolean" || typeof ttl !== "number" || !Number.isInteger(ttl)) {
    throw new Error("TTL must be a valid integer");
  }
  if (ttl < 0 || ttl > 86400 * 365) {
    throw new Error("TTL must be 0 (never expires) or between 1 and 31536000 seconds");
  }
  return ttl;
}

/**
 * Canonical (lowercase, dashed) UUID for `fileId`.
 *
 * Mirrors `str(uuid.UUID(str(file_id)))`: accepts the dashed, brace-wrapped,
 * `urn:uuid:`-prefixed and dash-less 32-hex forms, and returns the canonical
 * form. Anything else throws `Invalid file ID: <value>`. Because the returned
 * string is re-derived from hex digits only, path traversal is impossible.
 */
export function parseFileId(fileId: unknown): string {
  const raw = String(fileId);
  const hex = raw
    .replace(/urn:/g, "")
    .replace(/uuid:/g, "")
    .replace(/^[{}]+/, "")
    .replace(/[{}]+$/, "")
    .replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error("Invalid file ID: " + raw);
  }
  const lower = hex.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

/** Absolute data directory currently in effect (Python's `DATA_DIR`). */
export function dataDirPath(): string {
  return config.dataDir;
}

/** Absolute paths for a file and its metadata sidecar. */
export function getFilePaths(fileId: unknown): { filePath: string; metadataPath: string } {
  const canonical = parseFileId(fileId);
  const dir = dataDirPath();
  return {
    filePath: path.join(dir, canonical),
    metadataPath: path.join(dir, `${canonical}.meta.json`),
  };
}

/** Format FileMetadata into its public metadata dictionary. */
export async function fileMetaDict(metadata: FileMetadata): Promise<PublicFileMetadata> {
  let sizeBytes = metadata.sizeBytes || 0;
  if (sizeBytes <= 0) {
    try {
      const { filePath } = getFilePaths(metadata.fileId);
      sizeBytes = (await fsp.stat(filePath)).size;
    } catch (err) {
      if (isNotFound(err) || (err instanceof Error && err.message.startsWith("Invalid file ID"))) {
        sizeBytes = 0;
      } else {
        throw err;
      }
    }
  }

  return {
    id: metadata.fileId,
    filename: metadata.filename,
    url: `${config.baseUrl}/d/${metadata.fileId}/${metadata.filename}`,
    view_url: `${config.baseUrl}/v/${metadata.fileId}/${metadata.filename}`,
    is_image: isImageFile(metadata.filename),
    expires_in: metadata.expiresIn,
    created_at: metadata.createdAt,
    size_bytes: sizeBytes,
    views: metadata.views,
    downloads: metadata.downloads,
    last_viewed_at: metadata.lastViewedAt,
    last_downloaded_at: metadata.lastDownloadedAt,
  };
}

/** Directory entries matching Python's `DATA_DIR.glob("*.meta.json")`. */
async function metadataSidecars(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) {
      // pathlib.Path.glob() on a missing directory yields nothing.
      return [];
    }
    throw err;
  }
  // glob's `*` never matches a leading dot.
  return entries.filter((name) => name.endsWith(".meta.json") && !name.startsWith("."));
}

/** List active (non-expired) files with metadata, newest first. */
export async function listActiveFiles(): Promise<PublicFileMetadata[]> {
  const dir = dataDirPath();
  const files: PublicFileMetadata[] = [];
  for (const entry of await metadataSidecars(dir)) {
    const metadata = await FileMetadata.fromFile(path.join(dir, entry));
    if (metadata && !metadata.isExpired) {
      files.push(await fileMetaDict(metadata));
    }
  }
  return files.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

/** Metadata dict for a single active file, or null if not found/expired. */
export async function getFileInfo(fileId: unknown): Promise<PublicFileMetadata | null> {
  let filePath: string;
  let metadataPath: string;
  try {
    ({ filePath, metadataPath } = getFilePaths(fileId));
  } catch {
    return null;
  }
  const metadata = await FileMetadata.fromFile(metadataPath);
  if (!metadata || metadata.isExpired || !(await fileExists(filePath))) {
    return null;
  }
  return fileMetaDict(metadata);
}

/** Remove the cached thumbnail and failure marker for `canonicalFileId`. */
export async function deleteThumbnail(canonicalFileId: string): Promise<void> {
  for (const suffix of THUMB_SUFFIXES) {
    const target = path.join(dataDirPath(), `${canonicalFileId}${suffix}`);
    try {
      await fsp.unlink(target);
    } catch (err) {
      if (isNotFound(err)) {
        continue;
      }
      logEvent("thumbnail_delete_failed", { file_id: canonicalFileId, error: errorMessage(err) });
    }
  }
}

/** Remove file + sidecar by id. True when deleted, false when absent/invalid. */
export async function deleteFileById(fileId: unknown): Promise<boolean> {
  let filePath: string;
  let metadataPath: string;
  try {
    ({ filePath, metadataPath } = getFilePaths(fileId));
  } catch {
    logEvent("file_delete_failed", { file_id: fileId, reason: "not_found" });
    return false;
  }

  if (!(await fileExists(filePath)) && !(await fileExists(metadataPath))) {
    logEvent("file_delete_failed", { file_id: fileId, reason: "not_found" });
    return false;
  }

  const metadata = await FileMetadata.fromFile(metadataPath);
  const canonicalId = metadata ? metadata.fileId : path.basename(filePath);

  return withMetadataLock(async () => {
    try {
      if (await fileExists(filePath)) {
        await fsp.unlink(filePath);
      }
      if (await fileExists(metadataPath)) {
        await fsp.unlink(metadataPath);
      }
      await deleteThumbnail(canonicalId);
    } catch (err) {
      if (isNotFound(err)) {
        logEvent("file_delete_failed", { file_id: fileId, reason: "not_found" });
        return false;
      }
      logEvent("file_delete_failed", { file_id: fileId, error: errorMessage(err) });
      throw err;
    }

    logEvent("file_deleted", { file_id: fileId });
    return true;
  });
}

/** Reset `created_at` to now and store a new TTL; null when the file is gone. */
export async function extendFileTtl(fileId: unknown, ttl: unknown): Promise<PublicFileMetadata | null> {
  let validTtl: number;
  try {
    validTtl = validateTtl(ttl);
  } catch (err) {
    logEvent("extend_ttl_failed", { file_id: fileId, ttl, error: errorMessage(err) });
    throw err;
  }

  let filePath: string;
  let metadataPath: string;
  try {
    ({ filePath, metadataPath } = getFilePaths(fileId));
  } catch {
    logEvent("extend_ttl_failed", { file_id: fileId, reason: "not_found" });
    return null;
  }

  try {
    const notFound = await withMetadataLock(async () => {
      const metadata = await FileMetadata.fromFile(metadataPath);
      if (!metadata || metadata.isExpired || !(await fileExists(filePath))) {
        return true;
      }
      metadata.createdAt = nowSeconds();
      metadata.ttl = validTtl;
      await metadata.save(metadataPath);
      return false;
    });
    if (notFound) {
      logEvent("extend_ttl_failed", { file_id: fileId, reason: "not_found" });
      return null;
    }
    logEvent("extend_ttl_success", { file_id: fileId, ttl: validTtl });
    return getFileInfo(fileId);
  } catch (err) {
    logEvent("extend_ttl_failed", { file_id: fileId, error: errorMessage(err) });
    throw err;
  }
}

/** Remove expired files and their metadata. Returns the number cleaned. */
export async function cleanupExpiredFiles(): Promise<number> {
  const dir = dataDirPath();
  let cleaned = 0;
  for (const entry of await metadataSidecars(dir)) {
    const metadata = await FileMetadata.fromFile(path.join(dir, entry));
    if (!metadata || !metadata.isExpired) {
      continue;
    }
    const fileId = metadata.fileId;
    let filePath: string;
    let metadataPath: string;
    try {
      ({ filePath, metadataPath } = getFilePaths(fileId));
    } catch {
      continue;
    }

    try {
      if (await fileExists(filePath)) {
        await fsp.unlink(filePath);
      }
      if (await fileExists(metadataPath)) {
        await fsp.unlink(metadataPath);
      }
      await deleteThumbnail(fileId);
      cleaned += 1;
    } catch (err) {
      console.log(`Error cleaning up ${fileId}: ${errorMessage(err)}`);
    }
  }

  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} expired file(s)`);
  }
  return cleaned;
}

/**
 * Mark every stored file as "never expires" (TTL=0).
 *
 * Shared by the boot-time migration (app.py startup_event) and
 * POST /admin/set-all-infinite. Returns how many sidecars were updated.
 */
export async function setAllFilesInfiniteTtl(): Promise<number> {
  const dir = dataDirPath();
  let updated = 0;
  for (const entry of await metadataSidecars(dir)) {
    const metadataPath = path.join(dir, entry);
    try {
      // Read-modify-write under the same lock the counters/TTL/delete paths
      // use, so a concurrent view/download save is never lost.
      await withMetadataLock(async () => {
        const metadata = await FileMetadata.fromFile(metadataPath);
        if (metadata && metadata.ttl !== 0) {
          metadata.ttl = 0;
          await metadata.save(metadataPath);
          updated += 1;
        }
      });
    } catch {
      // Unreadable sidecars are skipped, matching FileMetadata.from_file -> None.
    }
  }
  return updated;
}

/** Ensure the data directory exists (Python: `DATA_DIR.mkdir(exist_ok=True)`). */
export async function ensureDataDir(): Promise<void> {
  await fsp.mkdir(dataDirPath(), { recursive: true });
}

/** Python's `thumb_path.with_suffix(f".tmp-{uuid.uuid4().hex}")`. */
function tempThumbPath(thumbPath: string): string {
  const parsed = path.parse(thumbPath);
  return path.join(parsed.dir, `${parsed.name}.tmp-${randomUUID().replace(/\-/g, "")}`);
}

/**
 * Generate a JPEG thumbnail (max `maxSize`, aspect preserved, never enlarged,
 * RGBA flattened onto white, EXIF auto-rotated, quality 70). Writes a unique
 * temporary file and atomically renames it into place. Never throws.
 */
export async function generateThumbnail(
  filePath: string,
  thumbPath: string,
  maxSize = 200,
  fileId?: string | null,
): Promise<boolean> {
  const tmpPath = tempThumbPath(thumbPath);
  try {
    await sharp(filePath)
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .jpeg({ quality: 70 })
      .toFile(tmpPath);
    await fsp.rename(tmpPath, thumbPath);
    return true;
  } catch (err) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // Python ignored FileNotFoundError here.
    }
    const baseName = path.basename(thumbPath);
    const fid =
      fileId ??
      (baseName.endsWith(".thumb.jpg")
        ? baseName.slice(0, -".thumb.jpg".length)
        : path.basename(filePath));
    const message = errorMessage(err);
    logEvent("thumbnail_generation_failed", { file_id: fid, error: message, reason: message });
    return false;
  }
}

/** Human readable expiry label. */
export function formatExpiry(expiresIn: number): string {
  if (expiresIn <= 0) {
    return "Nunca expira";
  }
  if (expiresIn < 3600) {
    return `Expira em ${Math.floor(expiresIn / 60)}min`;
  }
  if (expiresIn < 86400) {
    const hours = Math.floor(expiresIn / 3600);
    const minutes = Math.floor((expiresIn % 3600) / 60);
    return `Expira em ${hours}h ${minutes}min`;
  }
  return `Expira em ${Math.floor(expiresIn / 86400)} dia(s)`;
}

/** Lowercase extension of `filename` (empty when there is none). */
function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  // pathlib's Path(name).suffix is "" for hidden and trailing-dot names
  // (".env", ".png", "report."), unlike a naive lastIndexOf(".") split.
  if (dot <= 0 || dot === filename.length - 1) {
    return "";
  }
  return filename.slice(dot + 1).toLowerCase();
}

/** True when `filename` has a known image extension. */
export function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(filename));
}

/** Coarse category for a filename: image | document | video | archive. */
export function fileKind(filename: string): string {
  if (isImageFile(filename)) {
    return "image";
  }
  const ext = fileExtension(filename);
  if (DOC_EXTENSIONS.has(ext)) {
    return "document";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  return "archive";
}
