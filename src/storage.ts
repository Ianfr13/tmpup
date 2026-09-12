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
/** Sidecar suffix (Python's `DATA_DIR.glob("*.meta.json")`). */
const METADATA_SUFFIX = ".meta.json";

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
export async function fileExists(filePath: string): Promise<boolean> {
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
      const data: unknown = JSON.parse(raw);
      // Valid JSON that is not a metadata object (null, an array, a stray file
      // named <uuid>.meta.json) is treated as corrupt, exactly like a parse error.
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return null;
      }
      const record = data as Partial<FileMetadataData>;
      if (
        typeof record.file_id !== "string" ||
        typeof record.filename !== "string" ||
        typeof record.ttl !== "number" ||
        typeof record.created_at !== "number"
      ) {
        return null;
      }
      return FileMetadata.fromDict(record as FileMetadataData);
    } catch (err) {
      if (err instanceof SyntaxError || isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Save metadata to a JSON sidecar file.
   *
   * Written to a unique temporary file and renamed into place: readers
   * (listActiveFiles/getFileInfo/the transfer helpers) read sidecars without
   * taking the lock, so an in-place truncate would let them observe a
   * half-written file and report a stored file as missing.
   */
  async save(metadataPath: string): Promise<void> {
    const tempPath = `${metadataPath}.tmp-${randomUUID().replace(/-/g, "")}`;
    try {
      await fsp.writeFile(tempPath, JSON.stringify(this.toDict()));
      await fsp.rename(tempPath, metadataPath);
    } catch (err) {
      try {
        await fsp.unlink(tempPath);
      } catch {
        // best effort: the temp file may not exist
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Validate TTL: 0 means never expires, otherwise 1..31536000 seconds. */
export function validateTtl(ttl: unknown): number {
  if (typeof ttl !== "number" || !Number.isInteger(ttl)) {
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
  // The id is used verbatim in the public dict, like app.py's _file_meta_dict.
  const fileId = metadata.fileId;
  let sizeBytes = metadata.sizeBytes || 0;
  if (sizeBytes <= 0) {
    try {
      const { filePath } = getFilePaths(fileId);
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
    id: fileId,
    filename: metadata.filename,
    url: `${config.baseUrl}/d/${fileId}/${metadata.filename}`,
    view_url: `${config.baseUrl}/v/${fileId}/${metadata.filename}`,
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
  // pathlib's Path.glob (unlike the module-level glob.glob) DOES match
  // leading-dot names, so hidden sidecars stay visible to listings, cleanup and
  // the TTL migration, exactly like app.py.
  return entries.filter((name) => name.endsWith(METADATA_SUFFIX));
}

/** Run `worker` over `items` with at most `limit` calls in flight. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/** List active (non-expired) files with metadata, newest first. */
export async function listActiveFiles(): Promise<PublicFileMetadata[]> {
  const dir = dataDirPath();
  const entries = await metadataSidecars(dir);
  // Bounded concurrency: production keeps ~1880 sidecars and the sequential
  // version paid one round trip per file (read + stat) on every listing.
  const dicts = await mapWithConcurrency(entries, 32, async (entry) => {
    try {
      const metadata = await FileMetadata.fromFile(path.join(dir, entry));
      return metadata && !metadata.isExpired ? await fileMetaDict(metadata) : null;
    } catch {
      // One unreadable/odd sidecar must not fail the whole listing (app.py's
      // from_file returned None and the entry was skipped).
      return null;
    }
  });
  const files = dicts.filter((dict): dict is PublicFileMetadata => dict !== null);
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
  // A corrupt/copied sidecar must not answer for another file's id (the route
  // would otherwise hand out foreign urls and size_bytes).
  try {
    if (parseFileId(metadata.fileId) !== parseFileId(fileId)) {
      return null;
    }
  } catch {
    return null;
  }
  return fileMetaDict(metadata);
}

/**
 * Path-safe id for thumbnail files.
 *
 * Callers pass ids read from sidecar JSON. UUIDs are canonicalized; other
 * values (only test fixtures today) are kept as-is but must not contain a path
 * separator, so a tampered sidecar cannot delete files outside the data dir.
 */
function safeThumbnailId(fileId: string): string {
  try {
    return parseFileId(fileId);
  } catch (err) {
    if (fileId.includes("/") || fileId.includes("\\") || fileId.includes("..")) {
      throw err;
    }
    return fileId;
  }
}

/** Remove the cached thumbnail and failure marker for `canonicalFileId`. */
export async function deleteThumbnail(canonicalFileId: string): Promise<void> {
  const fileId = safeThumbnailId(canonicalFileId);
  for (const suffix of THUMB_SUFFIXES) {
    const target = path.join(dataDirPath(), `${fileId}${suffix}`);
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
    const metadataPath = path.join(dir, entry);
    // Delete the sidecar's OWN file. Using the id embedded in the JSON could
    // target a different, live file when a sidecar is corrupt or hand-edited.
    const fileId = entry.slice(0, -METADATA_SUFFIX.length);
    const filePath = path.join(dir, fileId);

    try {
      // The expiry decision is re-taken under the lock: a concurrent
      // extend_ttl / set-all-infinite must not race this purge.
      const removed = await withMetadataLock(async () => {
        const metadata = await FileMetadata.fromFile(metadataPath);
        if (!metadata || !metadata.isExpired) {
          return false;
        }
        if (await fileExists(filePath)) {
          await fsp.unlink(filePath);
        }
        if (await fileExists(metadataPath)) {
          await fsp.unlink(metadataPath);
        }
        await deleteThumbnail(fileId);
        return true;
      });
      if (removed) {
        cleaned += 1;
      }
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
  let errors = 0;
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
    } catch (err) {
      // A missing/invalid sidecar is skipped (fromFile already returns null for
      // those); anything else is a real failure and must not be hidden, or the
      // admin route would report success while a file stayed expiring.
      console.log(`Error migrating ${entry}: ${errorMessage(err)}`);
      errors += 1;
    }
  }
  if (errors > 0) {
    console.log(`Failed to migrate ${errors} file(s)`);
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
  // pathlib computes the suffix from the final path component only, and a
  // leading dot is not an extension separator (".env", ".png", "report.").
  const sepIndex = filename.lastIndexOf("/");
  const name = sepIndex === -1 ? filename : filename.slice(sepIndex + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
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
