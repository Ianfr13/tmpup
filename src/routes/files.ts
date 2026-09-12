/**
 * REST routes: health, file listing/metadata, TTL, delete and upload.
 * Ported 1:1 from app.py 1226-1410.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { readLimitedBody, removeIfExists } from "../fsutil.js";
import { filterSortPaginateFiles } from "../files.js";
import {
  FileMetadata,
  deleteFileById,
  extendFileTtl,
  getFileInfo,
  getFilePaths,
  listActiveFiles,
  validateTtl,
} from "../storage.js";
import { pythonInt, pythonUnquote } from "../url.js";

/** Pass-through stream that counts the bytes it forwards. */
class CountingStream extends Transform {
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

function isReadable(value: unknown): value is Readable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === "function"
  );
}

/** `await request.json()` with FastAPI's 400 `Invalid JSON body` on failure. */
async function readJsonBody(request: FastifyRequest): Promise<unknown> {
  const body: unknown = request.body;
  if (isReadable(body)) {
    // Bounded read: the catch-all parser leaves Fastify's bodyLimit unused, so
    // this is the only guard against an oversized JSON body on these routes.
    const { data, tooLarge } = await readLimitedBody(body, config.maxJsonBodyBytes);
    if (tooLarge) {
      throw new HttpError(413, "Request body too large");
    }
    const text = data.toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }
  if (body === undefined || body === null) {
    throw new HttpError(400, "Invalid JSON body");
  }
  return body;
}

/**
 * Fastify's querystring parser returns an array for a repeated key, while
 * FastAPI's `?q=a&q=b` keeps the first value; normalize to the first.
 */
function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Parse a `page` query parameter the way FastAPI's `page: int = 1` does. */
function parsePage(value: unknown): number {
  if (value === undefined) return 1;
  try {
    return pythonInt(String(value));
  } catch {
    return 1;
  }
}

/** Stream the request body to disk, returning how many bytes were written. */
async function writeRequestBodyTo(body: unknown, filePath: string): Promise<number> {
  if (isReadable(body)) {
    const counter = new CountingStream();
    await pipeline(body, counter, createWriteStream(filePath));
    return counter.bytes;
  }
  if (Buffer.isBuffer(body)) {
    await pipeline(Readable.from([body]), createWriteStream(filePath));
    return body.length;
  }
  if (typeof body === "string") {
    // Parsed text body (only reachable if a content-type parser is re-added):
    // write the bytes the parser decoded instead of quoting them as JSON.
    const buffer = Buffer.from(body, "utf8");
    await pipeline(Readable.from([buffer]), createWriteStream(filePath));
    return buffer.length;
  }
  // An already-parsed object cannot be turned back into the original bytes
  // (JSON.stringify would silently rewrite the upload), so fail loudly.
  throw new Error("request body was already consumed by a content-type parser");
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));

  app.get<{
    Querystring: {
      page?: string | string[];
      q?: string | string[];
      kind?: string | string[];
      sort?: string | string[];
    };
  }>("/api/files", async (request) => {
    const allFiles = await listActiveFiles();
    return filterSortPaginateFiles(allFiles, {
      q: firstQuery(request.query.q) ?? null,
      kind: firstQuery(request.query.kind) ?? "all",
      sort: firstQuery(request.query.sort) ?? "date",
      page: parsePage(firstQuery(request.query.page)),
    });
  });

  app.get<{ Params: { file_id: string } }>("/api/files/:file_id", async (request) => {
    const info = await getFileInfo(request.params.file_id);
    if (!info) {
      throw new HttpError(404, "File not found");
    }
    return info;
  });

  app.delete<{ Params: { file_id: string } }>("/api/files/:file_id", async (request) => {
    const deleted = await deleteFileById(request.params.file_id);
    if (!deleted) {
      throw new HttpError(404, "File not found");
    }
    return { deleted: true };
  });

  app.patch<{ Params: { file_id: string } }>("/api/files/:file_id/ttl", async (request) => {
    const body = await readJsonBody(request);
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("ttl" in body)) {
      throw new HttpError(400, "'ttl' field is required");
    }

    let validTtl: number;
    try {
      validTtl = validateTtl((body as { ttl: unknown }).ttl);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }

    const updated = await extendFileTtl(request.params.file_id, validTtl);
    if (updated === null) {
      throw new HttpError(404, "File not found");
    }
    return updated;
  });

  /**
   * POST /api/upload
   *
   * Headers: X-Filename (URL-encoded, required), X-TTL (seconds, default 3600).
   * Body: raw file bytes (streamed straight to disk, never buffered).
   */
  app.post("/api/upload", async (request) => {
    // Starlette's headers.get(name) returns the first value, and an absent
    // header is undefined (the `or "3600"` default only applies then).
    const firstHeader = (value: string | string[] | undefined): string | undefined =>
      Array.isArray(value) ? value[0] : value;

    const rawFilename = firstHeader(request.headers["x-filename"]);
    if (!rawFilename) {
      throw new HttpError(400, "X-Filename header required");
    }
    const filename = pythonUnquote(rawFilename);

    const rawTtl = firstHeader(request.headers["x-ttl"]) ?? "3600";
    let ttl: number;
    try {
      ttl = pythonInt(rawTtl);
    } catch {
      throw new HttpError(400, "X-TTL must be a valid integer");
    }

    try {
      ttl = validateTtl(ttl);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }

    const fileId = randomUUID();
    const { filePath, metadataPath } = getFilePaths(fileId);

    try {
      const totalWritten = await writeRequestBodyTo(request.body, filePath);

      if (totalWritten === 0) {
        await removeIfExists(filePath);
        // app.py wraps this 400 in its broad except-clause, so the wire status
        // ends up 500 with the original message appended.
        throw new HttpError(400, "Empty file");
      }

      const metadata = new FileMetadata(
        fileId,
        filename,
        ttl,
        Date.now() / 1000,
        0,
        0,
        null,
        null,
        totalWritten,
      );
      await metadata.save(metadataPath);

      return {
        url: `${config.baseUrl}/d/${fileId}/${filename}`,
        id: fileId,
        expires_in: ttl,
      };
    } catch (error) {
      await removeIfExists(filePath).catch(() => undefined);
      await removeIfExists(metadataPath).catch(() => undefined);
      throw new HttpError(500, `Upload failed: ${(error as Error).message}`);
    }
  });
}
