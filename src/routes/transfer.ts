/**
 * File transfer routes: download (/d), viewer (/v) and thumbnail (/t).
 * Ported 1:1 from app.py 1411-1806.
 */
import { createReadStream } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { escapeHtml, jsonForScript } from "../html.js";
import { guessContentType } from "../mime.js";
import { pythonQuote } from "../url.js";
import { renderViewerPage } from "../templates/index.js";
import {
  FileMetadata,
  deleteThumbnail,
  formatExpiry,
  generateThumbnail,
  getFilePaths,
  isImageFile,
  withMetadataLock,
} from "../storage.js";

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

export function isInlineContentType(contentType: string): boolean {
  return INLINE_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix));
}

/** `force_download = bool(dl and dl.lower() not in ("0", "false", "no"))` */
export function isForcedDownload(dl: string | null | undefined): boolean {
  if (!dl) return false;
  return !["0", "false", "no"].includes(dl.toLowerCase());
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function unlinkIfExists(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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

  if (metadata.isExpired) {
    await unlinkIfExists(filePath);
    await unlinkIfExists(metadataPath);
    await deleteThumbnail(metadata.fileId);
    throw new HttpError(404, "File expired");
  }

  if (!(await exists(filePath))) {
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
  } else {
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${pythonQuote(metadata.filename)}`;
  }

  await withMetadataLock(async () => {
    // Re-read under the lock so the increment is based on the latest state.
    const fresh = (await FileMetadata.fromFile(metadataPath)) ?? metadata;
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
    return { statusCode: 307, location: `/d/${fileId}/${metadata.filename}` };
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
  if (await exists(thumbPath)) {
    return { filePath: thumbPath, mediaType: "image/jpeg", headers: { ...THUMBNAIL_CACHE_HEADERS } };
  }

  const failMarkerPath = path.join(config.dataDir, `${metadata.fileId}.thumb.fail`);
  if (await exists(failMarkerPath)) {
    return { filePath, mediaType: guessContentType(metadata.filename), headers: {} };
  }

  const success = await generateThumbnail(filePath, thumbPath, 200, metadata.fileId);
  if (!success) {
    try {
      await writeFile(failMarkerPath, "");
    } catch {
      // touch() failures are ignored in app.py
    }
    return { filePath, mediaType: guessContentType(metadata.filename), headers: {} };
  }

  return { filePath: thumbPath, mediaType: "image/jpeg", headers: { ...THUMBNAIL_CACHE_HEADERS } };
}

async function streamFile(reply: FastifyReply, descriptor: FileResponseDescriptor): Promise<FastifyReply> {
  const info = await stat(descriptor.filePath);
  reply.type(descriptor.mediaType);
  reply.header("content-length", String(info.size));
  for (const [name, value] of Object.entries(descriptor.headers)) {
    reply.header(name, value);
  }
  return reply.send(createReadStream(descriptor.filePath));
}

export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { file_id: string; filename: string }; Querystring: { dl?: string } }>(
    "/d/:file_id/:filename",
    async (request, reply) => {
      const result = await downloadFile(
        request.params.file_id,
        request.params.filename,
        request.query.dl ?? null,
      );
      return streamFile(reply, result);
    },
  );

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
      return streamFile(reply, result);
    },
  );
}
