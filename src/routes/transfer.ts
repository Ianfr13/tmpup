/**
 * File transfer routes: download (/d), viewer (/v) and thumbnail (/t).
 * Ported 1:1 from app.py 1411-1806, plus the Starlette FileResponse behaviours
 * app.py relied on (byte ranges, ETag/Last-Modified, 304/416).
 */
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { removeIfExists } from "../fsutil.js";
import { escapeHtml, jsonForScript } from "../html.js";
import { guessContentType } from "../mime.js";
import { renderViewerPage } from "../templates/index.js";
import {
  FileMetadata,
  deleteThumbnail,
  fileExists,
  formatExpiry,
  generateThumbnail,
  getFilePaths,
  isImageFile,
  parseFileId,
  withMetadataLock,
} from "../storage.js";
import { pythonQuote } from "../url.js";

/** Description of a file to stream back to the client. */
export interface FileResponseDescriptor {
  filePath: string;
  mediaType: string;
  headers: Record<string, string>;
}

/** Description of an HTTP redirect response. */
export interface RedirectDescriptor {
  statusCode: number;
  location: string;
}

/** Description of an HTML response. */
export interface HtmlDescriptor {
  html: string;
}

const INLINE_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/", "text/", "application/pdf"];
const THUMBNAIL_CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "public, max-age=31536000, immutable",
};

/**
 * Inline content types that a browser can execute as a document. Uploaded HTML
 * or SVG is therefore served sandboxed: app.py served it inline too, which let
 * an uploaded file run script on the service origin.
 */
const SCRIPTABLE_INLINE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
]);

export function isInlineContentType(contentType: string): boolean {
  return INLINE_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix));
}

export function isScriptableInlineType(contentType: string): boolean {
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return SCRIPTABLE_INLINE_TYPES.has(base);
}

/**
 * Headers that neutralize a scriptable document served inline.
 *
 * Applied by /d AND by every /t fallback that re-serves the original file
 * (when sharp cannot rasterize it or a .thumb.fail marker exists): an SVG is a
 * valid image for app.py's extension list, so without this the thumbnail route
 * would hand it back unsandboxed.
 */
export function inlineSafetyHeaders(contentType: string): Record<string, string> {
  if (!isScriptableInlineType(contentType)) return {};
  return {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  };
}

/** `force_download = bool(dl and dl.lower() not in ("0", "false", "no"))` */
export function isForcedDownload(dl: string | null | undefined): boolean {
  if (!dl) return false;
  return !["0", "false", "no"].includes(dl.toLowerCase());
}

/**
 * Shared lookup used by all three transfer handlers: resolves paths, loads the
 * sidecar and performs the same lazy expiry cleanup as app.py.
 *
 * @throws {HttpError} 404 `File not found` / 404 `File expired`
 */
async function resolveStoredFile(
  fileId: string,
): Promise<{ filePath: string; metadataPath: string; metadata: FileMetadata }> {
  let filePath: string;
  let metadataPath: string;
  try {
    ({ filePath, metadataPath } = getFilePaths(fileId));
  } catch {
    throw new HttpError(404, "File not found");
  }

  const metadata = await FileMetadata.fromFile(metadataPath);
  if (!metadata) {
    throw new HttpError(404, "File not found");
  }

  // The sidecar's embedded id is used for thumbnail paths and for the deletion
  // below, so it must be a UUID that matches the sidecar's own filename before
  // anything touches the filesystem (a corrupt/tampered sidecar must not be
  // able to reach other files).
  let embeddedId: string;
  try {
    embeddedId = parseFileId(metadata.fileId);
  } catch {
    throw new HttpError(404, "File not found");
  }
  if (embeddedId !== parseFileId(fileId)) {
    throw new HttpError(404, "File not found");
  }

  if (metadata.isExpired) {
    // Purge under the metadata lock (same invariant as deleteFileById) so a
    // concurrent counter save cannot recreate the sidecar we are removing.
    await withMetadataLock(async () => {
      await removeIfExists(filePath);
      await removeIfExists(metadataPath);
    });
    await deleteThumbnail(embeddedId);
    throw new HttpError(404, "File expired");
  }

  if (!(await fileExists(filePath))) {
    throw new HttpError(404, "File not found");
  }

  return { filePath, metadataPath, metadata };
}

/**
 * `_download_file`: resolves the file, decides inline vs attachment, bumps the
 * view/download counters under the metadata lock and returns what to stream.
 */
export async function downloadFile(
  fileId: string,
  filename = "",
  dl: string | null | undefined = null,
): Promise<FileResponseDescriptor> {
  const { filePath, metadataPath, metadata } = await resolveStoredFile(fileId);

  const contentType = guessContentType(metadata.filename);
  const inline = isInlineContentType(contentType);
  const forceDownload = isForcedDownload(dl);
  const now = Date.now() / 1000;

  const headers: Record<string, string> = {};
  if (inline && !forceDownload) {
    headers["Content-Disposition"] = "inline";
    Object.assign(headers, inlineSafetyHeaders(contentType));
  } else {
    // app.py: urlquote(metadata.filename, safe="") -- slashes are encoded too.
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${pythonQuote(metadata.filename, "")}`;
  }

  await withMetadataLock(async () => {
    // Re-read under the lock so the increment is based on the latest state.
    // If the sidecar disappeared in the meantime the file was deleted: skip the
    // write instead of resurrecting it (app.py's `or metadata` fallback did
    // recreate a sidecar for a file that no longer exists).
    const fresh = await FileMetadata.fromFile(metadataPath);
    if (!fresh) return;
    if (inline && !forceDownload) {
      fresh.views += 1;
      fresh.lastViewedAt = now;
    } else {
      fresh.downloads += 1;
      fresh.lastDownloadedAt = now;
    }
    await fresh.save(metadataPath);
  });

  return { filePath, mediaType: contentType, headers };
}

/** `_view_file`: HTML viewer for images, 307 redirect to the raw file otherwise. */
export async function viewFile(
  fileId: string,
  filename = "",
): Promise<HtmlDescriptor | RedirectDescriptor> {
  const { metadata } = await resolveStoredFile(fileId);

  if (!isImageFile(metadata.filename)) {
    // Starlette's RedirectResponse quotes the URL before writing the header
    // (urllib's quote with this safe set), so non-ASCII/spaced names are
    // encoded exactly like app.py did.
    return {
      statusCode: 307,
      location: pythonQuote(`/d/${fileId}/${metadata.filename}`, ":/%#?=@[]!$&'()*+,;"),
    };
  }

  const safeFilename = escapeHtml(metadata.filename);
  const imageUrl = escapeHtml(`/d/${fileId}/${metadata.filename}`, true);
  const downloadUrl = escapeHtml(`/d/${fileId}/${metadata.filename}?dl=1`, true);
  const imageUrlAbs = `${config.baseUrl}/d/${fileId}/${metadata.filename}`;

  return {
    html: renderViewerPage({
      filename: safeFilename,
      imageUrl,
      downloadUrl,
      imageUrlAbsJson: jsonForScript(imageUrlAbs),
      fileIdJson: jsonForScript(fileId),
      expiryText: formatExpiry(metadata.expiresIn),
    }),
  };
}

/** `_thumbnail_file`: cached JPEG thumbnail with fail-marker fallback. */
export async function thumbnailFile(fileId: string, filename = ""): Promise<FileResponseDescriptor> {
  const { filePath, metadata } = await resolveStoredFile(fileId);

  if (!isImageFile(metadata.filename)) {
    throw new HttpError(404, "File is not an image");
  }

  const thumbPath = path.join(config.dataDir, `${metadata.fileId}.thumb.jpg`);
  if (await fileExists(thumbPath)) {
    return { filePath: thumbPath, mediaType: "image/jpeg", headers: { ...THUMBNAIL_CACHE_HEADERS } };
  }

  const failMarkerPath = path.join(config.dataDir, `${metadata.fileId}.thumb.fail`);
  // Both fallbacks re-serve the original file, so a scriptable type (SVG) must
  // carry the sandbox headers here too.
  const fallback = {
    filePath,
    mediaType: guessContentType(metadata.filename),
    headers: inlineSafetyHeaders(guessContentType(metadata.filename)),
  };
  if (await fileExists(failMarkerPath)) {
    return fallback;
  }

  const success = await generateThumbnail(filePath, thumbPath, 200, metadata.fileId);
  if (!success) {
    try {
      await writeFile(failMarkerPath, "");
    } catch {
      // touch() failures are ignored in app.py
    }
    return fallback;
  }

  return { filePath: thumbPath, mediaType: "image/jpeg", headers: { ...THUMBNAIL_CACHE_HEADERS } };
}

interface ByteRange {
  start: number;
  end: number;
}

/** Single-range `Range: bytes=...` parsing (Starlette FileResponse semantics). */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  // Starlette does units.strip().lower() before comparing, so "BYTES=0-1" and
  // "bytes = 0-1" are valid ranges too (RFC 9110: units are case-insensitive).
  const match = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || size === 0 || start >= size || start > end) {
    return "unsatisfiable";
  }
  return { start, end };
}

/** True when the client's validators match the current representation (304). */
function isNotModified(request: FastifyRequest, etag: string, lastModified: Date): boolean {
  const ifNoneMatch = request.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch.length > 0) {
    const normalize = (value: string): string => value.trim().replace(/^W\//, "");
    return ifNoneMatch.split(",").some((candidate) => {
      const trimmed = candidate.trim();
      // RFC 9110: `*` matches any current representation; weak validators are
      // compared without the W/ prefix for GET/HEAD.
      return trimmed === "*" || normalize(trimmed) === normalize(etag);
    });
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (typeof ifModifiedSince === "string" && ifModifiedSince.length > 0) {
    const since = Date.parse(ifModifiedSince);
    return Number.isFinite(since) && Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000);
  }
  return false;
}

async function streamFile(
  reply: FastifyReply,
  request: FastifyRequest,
  descriptor: FileResponseDescriptor,
): Promise<FastifyReply> {
  const info = await stat(descriptor.filePath);
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;

  reply.type(descriptor.mediaType);
  reply.header("accept-ranges", "bytes");
  reply.header("last-modified", info.mtime.toUTCString());
  reply.header("etag", etag);
  for (const [name, value] of Object.entries(descriptor.headers)) {
    reply.header(name, value);
  }

  if (isNotModified(request, etag, info.mtime)) {
    reply.code(304);
    return reply.send();
  }

  const range = parseRangeHeader(
    typeof request.headers.range === "string" ? request.headers.range : undefined,
    info.size,
  );
  if (range === "unsatisfiable") {
    reply.code(416).header("content-range", `bytes */${info.size}`);
    return reply.send();
  }
  if (range) {
    reply.code(206);
    reply.header("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
    reply.header("content-length", String(range.end - range.start + 1));
    return reply.send(createReadStream(descriptor.filePath, { start: range.start, end: range.end }));
  }

  reply.header("content-length", String(info.size));
  return reply.send(createReadStream(descriptor.filePath));
}

export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { file_id: string; filename: string };
    Querystring: { dl?: string | string[] };
  }>("/d/:file_id/:filename", async (request, reply) => {
    // A repeated ?dl=1&dl=0 reaches the handler as an array; FastAPI kept the
    // first value, so normalize instead of crashing on .toLowerCase().
    const dl = Array.isArray(request.query.dl) ? (request.query.dl[0] ?? null) : (request.query.dl ?? null);
    const result = await downloadFile(request.params.file_id, request.params.filename, dl);
    return streamFile(reply, request, result);
  });

  app.get<{ Params: { file_id: string; filename: string } }>(
    "/v/:file_id/:filename",
    async (request, reply) => {
      const result = await viewFile(request.params.file_id, request.params.filename);
      if ("html" in result) {
        return reply.type("text/html; charset=utf-8").send(result.html);
      }
      return reply.redirect(result.location, result.statusCode);
    },
  );

  app.get<{ Params: { file_id: string; filename: string } }>(
    "/t/:file_id/:filename",
    async (request, reply) => {
      const result = await thumbnailFile(request.params.file_id, request.params.filename);
      return streamFile(reply, request, result);
    },
  );
}
