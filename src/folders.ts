/**
 * Virtual one-level folders: sidecar `<uuid>.folder.json` plus optional
 * `folder_id` on file metadata. Zip upload flattens to basenames; download
 * streams a zip. Deleting a folder deletes its files.
 */
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { Unzip, UnzipInflate, UnzipPassThrough, zipSync } from "fflate";

import { config } from "./config.js";
import { logEvent } from "./logger.js";
import {
  FileMetadata,
  dataDirPath,
  deleteFileById,
  deleteThumbnail,
  fileExists,
  fileMetaDict,
  getFilePaths,
  parseFileId,
  validateTtl,
  withMetadataLock,
} from "./storage.js";
import type {
  FolderListPage,
  FolderMetadataData,
  PublicFileMetadata,
  PublicFolder,
} from "./types.js";

const FOLDER_SUFFIX = ".folder.json";
const METADATA_SUFFIX = ".meta.json";
const MAX_ZIP_ENTRIES = 1000;

export class FolderError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "FolderError";
    this.statusCode = statusCode;
  }
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function parseFolderId(folderId: unknown): string {
  return parseFileId(folderId);
}

export function validateFolderName(name: unknown): string {
  if (typeof name !== "string") {
    throw new FolderError(400, "Invalid folder name");
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new FolderError(400, "Invalid folder name");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new FolderError(400, "Invalid folder name");
  }
  if (/[/\\]/.test(trimmed) || /[\x00-\x1f]/.test(trimmed)) {
    throw new FolderError(400, "Invalid folder name");
  }
  return trimmed;
}

export function getFolderPath(folderId: unknown): string {
  const canonical = parseFolderId(folderId);
  return path.join(dataDirPath(), `${canonical}${FOLDER_SUFFIX}`);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${randomUUID().replace(/-/g, "")}`;
  try {
    await fsp.writeFile(tempPath, JSON.stringify(value));
    await fsp.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fsp.unlink(tempPath);
    } catch {
      // best effort
    }
    throw err;
  }
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) {
      return [];
    }
    throw err;
  }
}

export async function loadFolderRecord(folderId: unknown): Promise<FolderMetadataData | null> {
  let folderPath: string;
  try {
    folderPath = getFolderPath(folderId);
  } catch {
    return null;
  }
  try {
    const raw = await fsp.readFile(folderPath, "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    const record = data as Partial<FolderMetadataData>;
    if (
      typeof record.folder_id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.created_at !== "number"
    ) {
      return null;
    }
    try {
      if (parseFolderId(record.folder_id) !== parseFolderId(folderId)) {
        return null;
      }
    } catch {
      return null;
    }
    return {
      folder_id: parseFolderId(record.folder_id),
      name: record.name,
      created_at: record.created_at,
    };
  } catch (err) {
    if (err instanceof SyntaxError || isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

async function listFolderRecords(): Promise<FolderMetadataData[]> {
  const dir = dataDirPath();
  const names = await readDirNames(dir);
  const records: FolderMetadataData[] = [];
  for (const name of names) {
    if (!name.endsWith(FOLDER_SUFFIX)) {
      continue;
    }
    const id = name.slice(0, -FOLDER_SUFFIX.length);
    const record = await loadFolderRecord(id);
    if (record) {
      records.push(record);
    }
  }
  return records.sort((a, b) => b.created_at - a.created_at);
}

async function listMemberMetadata(folderId: string): Promise<FileMetadata[]> {
  const dir = dataDirPath();
  const names = await readDirNames(dir);
  const members: FileMetadata[] = [];
  for (const name of names) {
    if (!name.endsWith(METADATA_SUFFIX)) {
      continue;
    }
    const sidecarId = name.slice(0, -METADATA_SUFFIX.length);
    let canonicalSidecar: string;
    try {
      canonicalSidecar = parseFileId(sidecarId);
    } catch {
      continue;
    }
    try {
      const metadata = await FileMetadata.fromFile(path.join(dir, name));
      if (!metadata || metadata.folderId !== folderId) {
        continue;
      }
      if (parseFileId(metadata.fileId) !== canonicalSidecar) {
        continue;
      }
      members.push(metadata);
    } catch {
      continue;
    }
  }
  return members;
}

async function folderToPublic(record: FolderMetadataData): Promise<PublicFolder> {
  const members = await listMemberMetadata(record.folder_id);
  const active = members.filter((m) => !m.isExpired);
  return {
    id: record.folder_id,
    name: record.name,
    created_at: record.created_at,
    file_count: active.length,
    total_size_bytes: active.reduce((sum, m) => sum + (m.sizeBytes || 0), 0),
    download_url: `${config.baseUrl}/api/folders/${record.folder_id}/download`,
  };
}

export async function createFolder(name: unknown): Promise<PublicFolder> {
  let validName: string;
  try {
    validName = validateFolderName(name);
  } catch (err) {
    logEvent("folder_create_failed", { err: errorMessage(err), reason: "invalid_name" });
    throw err;
  }

  try {
    const record = await withMetadataLock(async () => {
      const existing = await listFolderRecords();
      if (existing.some((folder) => folder.name.toLowerCase() === validName.toLowerCase())) {
        throw new FolderError(409, "Folder name already exists");
      }
      const folderId = randomUUID();
      const created: FolderMetadataData = {
        folder_id: folderId,
        name: validName,
        created_at: nowSeconds(),
      };
      await atomicWriteJson(getFolderPath(folderId), created);
      return created;
    });
    logEvent("folder_created", { folder_id: record.folder_id });
    return folderToPublic(record);
  } catch (err) {
    if (err instanceof FolderError && err.statusCode === 409) {
      logEvent("folder_create_failed", { err: err.message, reason: "duplicate_name" });
      throw err;
    }
    logEvent("folder_create_failed", { err: errorMessage(err) });
    throw err;
  }
}

export async function listFolders(page = 1): Promise<FolderListPage> {
  const records = await listFolderRecords();
  const pageSize = config.pageSize;
  const total = records.length;
  const totalPages = Math.ceil(total / pageSize);
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * pageSize;
  const slice = records.slice(start, start + pageSize);
  const items = await Promise.all(slice.map((record) => folderToPublic(record)));
  return {
    items,
    total,
    page: safePage,
    page_size: pageSize,
    total_pages: totalPages,
  };
}

export async function getFolderInfo(folderId: unknown): Promise<PublicFolder | null> {
  const record = await loadFolderRecord(folderId);
  if (!record) {
    return null;
  }
  return folderToPublic(record);
}

export async function requireFolder(folderId: unknown): Promise<FolderMetadataData> {
  const record = await loadFolderRecord(folderId);
  if (!record) {
    throw new FolderError(404, "Folder not found");
  }
  return record;
}

export async function deleteFolder(folderId: unknown): Promise<{ deleted: boolean; files_deleted: number }> {
  let canonical: string;
  try {
    canonical = parseFolderId(folderId);
  } catch {
    logEvent("folder_delete_failed", { folder_id: folderId, reason: "not_found" });
    return { deleted: false, files_deleted: 0 };
  }

  let memberIds: string[] = [];
  try {
    const found = await withMetadataLock(async () => {
      const record = await loadFolderRecord(canonical);
      if (!record) {
        return false;
      }
      const members = await listMemberMetadata(canonical);
      memberIds = members.map((m) => m.fileId);
      const folderPath = getFolderPath(canonical);
      if (await fileExists(folderPath)) {
        await fsp.unlink(folderPath);
      }
      return true;
    });
    if (!found) {
      logEvent("folder_delete_failed", { folder_id: canonical, reason: "not_found" });
      return { deleted: false, files_deleted: 0 };
    }
  } catch (err) {
    logEvent("folder_delete_failed", { folder_id: canonical, err: errorMessage(err) });
    throw err;
  }

  let filesDeleted = 0;
  for (const fileId of memberIds) {
    try {
      if (await deleteFileById(fileId)) {
        filesDeleted += 1;
      }
    } catch (err) {
      logEvent("folder_delete_failed", {
        folder_id: canonical,
        file_id: fileId,
        err: errorMessage(err),
        reason: "member_delete_failed",
      });
    }
  }

  logEvent("folder_deleted", { folder_id: canonical, files_deleted: filesDeleted });
  return { deleted: true, files_deleted: filesDeleted };
}

export async function setFileFolder(
  fileId: unknown,
  folderId: string | null,
): Promise<PublicFileMetadata | null> {
  let canonicalFile: string;
  try {
    canonicalFile = parseFileId(fileId);
  } catch {
    return null;
  }

  let canonicalFolder: string | null = null;
  if (folderId !== null) {
    try {
      canonicalFolder = parseFolderId(folderId);
    } catch {
      throw new FolderError(400, "Invalid folder ID");
    }
    await requireFolder(canonicalFolder);
  }

  const { filePath, metadataPath } = getFilePaths(canonicalFile);
  const notFound = await withMetadataLock(async () => {
    const metadata = await FileMetadata.fromFile(metadataPath);
    if (!metadata || metadata.isExpired || !(await fileExists(filePath))) {
      return true;
    }
    if (canonicalFolder) {
      await requireFolder(canonicalFolder);
      const existing = await listMemberMetadata(canonicalFolder);
      if (
        existing.some(
          (member) => !member.isExpired && member.filename === metadata.filename && member.fileId !== metadata.fileId,
        )
      ) {
        throw new FolderError(400, `Duplicate filename in folder: ${metadata.filename}`);
      }
    }
    metadata.folderId = canonicalFolder;
    await metadata.save(metadataPath);
    return false;
  });
  if (notFound) {
    return null;
  }
  logEvent("file_moved", { file_id: canonicalFile, folder_id: canonicalFolder });
  const metadata = await FileMetadata.fromFile(metadataPath);
  if (!metadata) {
    return null;
  }
  return fileMetaDict(metadata);
}

interface ZipEntry {
  filename: string;
  content: Buffer;
}

function zipBasename(entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new FolderError(400, `Invalid path in zip: ${entryName}`);
  }
  const segments = normalized.split("/").filter((part) => part.length > 0);
  if (segments.some((part) => part === ".." || part === ".")) {
    throw new FolderError(400, `Invalid path in zip: ${entryName}`);
  }
  const base = segments[segments.length - 1];
  if (!base) {
    throw new FolderError(400, `Invalid path in zip: ${entryName}`);
  }
  return base;
}

export function parseZipEntries(zipBytes: Uint8Array): ZipEntry[] {
  const maxUncompressed = config.maxMcpUploadSize;
  const collected: Array<{ name: string; chunks: Uint8Array[] }> = [];
  let totalBytes = 0;
  let entryCount = 0;
  let failed: FolderError | null = null;

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  unzipper.onfile = (file) => {
    if (failed || file.name.endsWith("/")) {
      return;
    }
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      failed = new FolderError(400, "Zip contains too many files");
      return;
    }
    const chunks: Uint8Array[] = [];
    file.ondata = (err, dat, final) => {
      if (failed) {
        return;
      }
      if (err) {
        failed = new FolderError(400, `Invalid zip: ${errorMessage(err)}`);
        return;
      }
      if (dat && dat.length > 0) {
        totalBytes += dat.length;
        if (totalBytes > maxUncompressed) {
          failed = new FolderError(400, "Zip uncompressed size exceeds limit");
          return;
        }
        chunks.push(dat);
      }
      if (final) {
        collected.push({ name: file.name, chunks });
      }
    };
    try {
      file.start();
    } catch (err) {
      failed = new FolderError(400, `Invalid zip: ${errorMessage(err)}`);
    }
  };

  try {
    unzipper.push(zipBytes, true);
  } catch (err) {
    throw new FolderError(400, `Invalid zip: ${errorMessage(err)}`);
  }
  if (failed) {
    throw failed;
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  for (const item of collected) {
    const filename = zipBasename(item.name);
    if (seen.has(filename)) {
      throw new FolderError(400, `Duplicate filename in folder: ${filename}`);
    }
    seen.add(filename);
    const content = Buffer.concat(item.chunks);
    if (content.length === 0) {
      throw new FolderError(400, "Empty file");
    }
    entries.push({ filename, content });
  }
  if (entries.length === 0) {
    throw new FolderError(400, "Zip contains no files");
  }
  return entries;
}

async function persistEntries(
  folderId: string,
  entries: ZipEntry[],
  ttl: number,
): Promise<PublicFileMetadata[]> {
  await requireFolder(folderId);
  const created: Array<{ filePath: string; metadataPath: string; fileId: string }> = [];

  try {
    return await withMetadataLock(async () => {
      await requireFolder(folderId);
      const existing = await listMemberMetadata(folderId);
      const existingNames = new Set(existing.filter((m) => !m.isExpired).map((m) => m.filename));
      for (const entry of entries) {
        if (existingNames.has(entry.filename)) {
          throw new FolderError(400, `Duplicate filename in folder: ${entry.filename}`);
        }
      }

      const stored: PublicFileMetadata[] = [];
      for (const entry of entries) {
        const fileId = randomUUID();
        const { filePath, metadataPath } = getFilePaths(fileId);
        await fsp.writeFile(filePath, entry.content);
        created.push({ filePath, metadataPath, fileId });
        const metadata = new FileMetadata(
          fileId,
          entry.filename,
          ttl,
          nowSeconds(),
          0,
          0,
          null,
          null,
          entry.content.length,
          folderId,
        );
        await metadata.save(metadataPath);
        stored.push(await fileMetaDict(metadata));
      }
      return stored;
    });
  } catch (err) {
    for (const item of created) {
      await fsp.unlink(item.filePath).catch(() => undefined);
      await fsp.unlink(item.metadataPath).catch(() => undefined);
      await deleteThumbnail(item.fileId).catch(() => undefined);
    }
    throw err;
  }
}

export async function uploadZipToFolder(
  folderId: unknown,
  zipBytes: Uint8Array,
  ttl: unknown = 0,
): Promise<{ folder: PublicFolder; files: PublicFileMetadata[] }> {
  let canonical: string;
  try {
    canonical = parseFolderId(folderId);
  } catch {
    throw new FolderError(404, "Folder not found");
  }
  let validTtl: number;
  try {
    validTtl = validateTtl(ttl);
  } catch (err) {
    logEvent("folder_upload_failed", { folder_id: canonical, err: errorMessage(err) });
    throw err;
  }

  try {
    const entries = parseZipEntries(zipBytes);
    const files = await persistEntries(canonical, entries, validTtl);
    const folder = await getFolderInfo(canonical);
    if (!folder) {
      throw new FolderError(404, "Folder not found");
    }
    logEvent("folder_upload_success", { folder_id: canonical, files: files.length });
    return { folder, files };
  } catch (err) {
    logEvent("folder_upload_failed", { folder_id: canonical, err: errorMessage(err) });
    throw err;
  }
}

export async function createFolderFromZip(
  name: unknown,
  zipBytes: Uint8Array,
  ttl: unknown = 0,
): Promise<{ folder: PublicFolder; files: PublicFileMetadata[] }> {
  const folder = await createFolder(name);
  try {
    return await uploadZipToFolder(folder.id, zipBytes, ttl);
  } catch (err) {
    await deleteFolder(folder.id).catch(() => undefined);
    throw err;
  }
}

export async function zipFolder(folderId: unknown): Promise<{ filename: string; bytes: Buffer; fileCount: number }> {
  let canonical: string;
  try {
    canonical = parseFolderId(folderId);
  } catch {
    throw new FolderError(404, "Folder not found");
  }

  const record = await loadFolderRecord(canonical);
  if (!record) {
    logEvent("folder_download_failed", { folder_id: canonical, reason: "not_found" });
    throw new FolderError(404, "Folder not found");
  }

  const members = (await listMemberMetadata(canonical)).filter((m) => !m.isExpired);
  if (members.length === 0) {
    logEvent("folder_download_failed", { folder_id: canonical, reason: "empty" });
    throw new FolderError(400, "Folder is empty");
  }

  try {
    const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
    for (const member of members) {
      const { filePath } = getFilePaths(member.fileId);
      const content = await fsp.readFile(filePath);
      let zipName: string;
      try {
        zipName = zipBasename(member.filename);
      } catch {
        zipName = `file-${member.fileId}`;
      }
      if (Object.prototype.hasOwnProperty.call(files, zipName)) {
        zipName = `${member.fileId}-${zipName}`;
      }
      files[zipName] = new Uint8Array(content);
    }
    const bytes = Buffer.from(zipSync(files));
    logEvent("folder_download", { folder_id: canonical, files: members.length });
    return { filename: `${record.name}.zip`, bytes, fileCount: members.length };
  } catch (err) {
    logEvent("folder_download_failed", { folder_id: canonical, err: errorMessage(err) });
    throw err;
  }
}
