/** REST routes for virtual folders. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";

import { config } from "../config.js";
import { HttpError } from "../errors.js";
import {
  FolderError,
  createFolder,
  deleteFolder,
  getFolderInfo,
  listFolders,
  uploadZipToFolder,
  zipFolder,
} from "../folders.js";
import { readLimitedBody } from "../fsutil.js";
import { pythonInt, pythonQuote } from "../url.js";
import { validateTtl } from "../storage.js";

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isReadable(value: unknown): value is Readable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === "function"
  );
}

async function readJsonBody(request: FastifyRequest): Promise<unknown> {
  const body: unknown = request.body;
  if (isReadable(body)) {
    const { data, tooLarge } = await readLimitedBody(body, config.maxJsonBodyBytes);
    if (tooLarge) {
      throw new HttpError(413, "Request body too large");
    }
    try {
      return JSON.parse(data.toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }
  if (body === undefined || body === null) {
    throw new HttpError(400, "Invalid JSON body");
  }
  return body;
}

function throwHttp(err: unknown): never {
  if (err instanceof FolderError) {
    throw new HttpError(err.statusCode, err.message);
  }
  if (err instanceof HttpError) {
    throw err;
  }
  throw new HttpError(500, err instanceof Error ? err.message : "Internal Server Error");
}

function parsePage(value: unknown): number {
  if (value === undefined) return 1;
  try {
    return pythonInt(String(value));
  } catch {
    return 1;
  }
}

export async function registerFolderRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/folders", async (request) => {
    const body = await readJsonBody(request);
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("name" in body)) {
      throw new HttpError(400, "'name' field is required");
    }
    try {
      return await createFolder((body as { name: unknown }).name);
    } catch (err) {
      throwHttp(err);
    }
  });

  app.get<{ Querystring: { page?: string | string[] } }>("/api/folders", async (request) => {
    return listFolders(parsePage(firstValue(request.query.page)));
  });

  app.get<{ Params: { folder_id: string } }>("/api/folders/:folder_id", async (request) => {
    const info = await getFolderInfo(request.params.folder_id);
    if (!info) {
      throw new HttpError(404, "Folder not found");
    }
    return info;
  });

  app.delete<{ Params: { folder_id: string } }>("/api/folders/:folder_id", async (request) => {
    try {
      const result = await deleteFolder(request.params.folder_id);
      if (!result.deleted) {
        throw new HttpError(404, "Folder not found");
      }
      return result;
    } catch (err) {
      throwHttp(err);
    }
  });

  app.post<{ Params: { folder_id: string } }>("/api/folders/:folder_id/upload", async (request) => {
    const rawTtl = firstValue(request.headers["x-ttl"]) ?? "0";
    let ttl: number;
    try {
      ttl = validateTtl(pythonInt(rawTtl));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : "Invalid TTL");
    }

    const body: unknown = request.body;
    if (!isReadable(body)) {
      throw new HttpError(400, "Zip body required");
    }
    const { data, tooLarge } = await readLimitedBody(body, config.maxMcpUploadSize);
    if (tooLarge) {
      throw new HttpError(413, "Request body too large");
    }
    if (data.length === 0) {
      throw new HttpError(400, "Empty file");
    }
    try {
      return await uploadZipToFolder(request.params.folder_id, data, ttl);
    } catch (err) {
      throwHttp(err);
    }
  });

  app.get<{ Params: { folder_id: string } }>("/api/folders/:folder_id/download", async (request, reply) => {
    try {
      const zipped = await zipFolder(request.params.folder_id);
      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${pythonQuote(zipped.filename, "")}`,
      );
      return reply.send(zipped.bytes);
    } catch (err) {
      throwHttp(err);
    }
  });
}
