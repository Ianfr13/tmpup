/** Bounded, authenticated uploads that fit behind reverse-proxy body limits. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifySession } from "../auth.js";
import { config } from "../config.js";
import { FolderError, requireFolder } from "../folders.js";
import { readLimitedBody, removeIfExists } from "../fsutil.js";
import { logEvent } from "../logger.js";
import { FileMetadata, getFilePaths } from "../storage.js";

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const COMPLETED_TTL = 10 * 60 * 1000;
interface Upload {
  owner: string; filename: string; size: number; ttl: number; offset: number;
  filePath: string; touched: number; busy: boolean; folderId: string | null;
  result?: Record<string, unknown>;
}
function owner(request: FastifyRequest): string {
  const email = verifySession(request.cookies?.session);
  return createHash("sha256").update(email ? `user:${email}` : `key:${request.headers["x-api-key"]}`).digest("hex");
}

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  const directory = path.join(config.dataDir, ".uploads");
  await mkdir(directory, { recursive: true });
  const uploads = new Map<string, Upload>();
  // Staging files have no public metadata; remove abandoned files from older processes.
  async function cleanup() {
    const cutoff = Date.now() - SESSION_TTL;
    for (const [id, upload] of uploads) {
      if (!upload.busy && upload.touched < Date.now() - (upload.result ? COMPLETED_TTL : SESSION_TTL)) {
        await removeIfExists(upload.filePath); uploads.delete(id);
      }
    }
    const active = new Set([...uploads.values()].map(u => u.filePath));
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]+\.part$/.test(name)) continue;
      const file = path.join(directory, name);
      if (!active.has(file)) {
        try { if ((await stat(file)).mtimeMs < cutoff) await removeIfExists(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
  await cleanup();
  let cleaning: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!cleaning) cleaning = cleanup().catch(error => app.log.error(error, "Upload cleanup failed")).finally(() => { cleaning = undefined; });
  }, 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer); await cleaning;
    await Promise.all([...uploads.values()].map(u => removeIfExists(u.filePath)));
    uploads.clear();
  });
  function lookup(request: FastifyRequest): Upload | undefined {
    const { id } = request.params as { id: string };
    const upload = uploads.get(id);
    if (!upload || upload.owner !== owner(request) || upload.touched < Date.now() - (upload.result ? COMPLETED_TTL : SESSION_TTL)) return;
    upload.touched = Date.now();
    return upload;
  }

  app.post("/api/uploads", async (request, reply) => {
    const body = await readLimitedBody(request.body as Readable, config.maxJsonBodyBytes);
    if (body.tooLarge) return reply.code(413).send({ error: "Request too large" });
    let input: { filename?: unknown; size?: unknown; ttl?: unknown; folder_id?: unknown };
    try { input = JSON.parse(body.data.toString()); }
    catch { return reply.code(400).send({ error: "Invalid JSON" }); }
    if (!input || typeof input !== "object") return reply.code(400).send({ error: "Invalid upload" });
    const { filename, size } = input;
    const ttl = input.ttl ?? 86400;
    if (typeof filename !== "string" || !filename.trim() || filename.length > 255 || /[/\\\x00-\x1f\x7f]/.test(filename) || filename === "." || filename === ".." ||
        typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 ||
        typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 0 || ttl > 86400 * 365) {
      return reply.code(400).send({ error: "Invalid filename, size or TTL" });
    }
    let folderId: string | null = null;
    if (input.folder_id != null) {
      try { folderId = (await requireFolder(input.folder_id)).folder_id; }
      catch (error) {
        if (!(error instanceof FolderError)) throw error;
        logEvent("chunked_upload_folder_rejected", { err: error.message });
        return reply.code(error.statusCode).send({ error: error.message });
      }
    }
    const user = owner(request);
    const active = [...uploads.values()].filter(u => !u.result);
    if (active.length >= 256 || active.filter(u => u.owner === user).length >= 16) {
      return reply.code(429).send({ error: "Too many upload sessions; finish or cancel existing uploads" });
    }
    const id = randomUUID();
    const filePath = path.join(directory, `${id}.part`);
    uploads.set(id, { owner: user, filename, size, ttl, offset: 0, filePath, touched: Date.now(), busy: true, folderId });
    try { const file = await open(filePath, "wx"); await file.close(); }
    catch (error) { uploads.delete(id); throw error; }
    uploads.get(id)!.busy = false;
    return reply.code(201).send({ upload_id: id, chunk_size: UPLOAD_CHUNK_SIZE, offset: 0 });
  });

  app.put("/api/uploads/:id", async (request, reply) => {
    const upload = lookup(request);
    if (!upload) return reply.code(404).send({ error: "Upload session not found or expired" });
    if (upload.busy || upload.result) return reply.code(409).send({ error: "Upload is busy or completed" });
    const rawOffset = (request.query as { offset?: string }).offset;
    const offset = Number(rawOffset);
    if (typeof rawOffset !== "string" || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset)) return reply.code(400).send({ error: "Invalid offset" });
    upload.busy = true;
    try {
      const body = await readLimitedBody(request.body as Readable, UPLOAD_CHUNK_SIZE);
      if (body.tooLarge || offset + body.data.length > upload.size) return reply.code(413).send({ error: "Chunk exceeds upload limit" });
      if (!body.data.length) return reply.code(400).send({ error: "Empty chunk" });
      if (offset > upload.offset || (offset < upload.offset && offset + body.data.length > upload.offset)) return reply.code(409).send({ error: "Unexpected offset", offset: upload.offset });
      const file = await open(upload.filePath, "r+");
      let conflictingRetry = false;
      try {
        if (offset < upload.offset) {
          const previous = Buffer.alloc(body.data.length);
          const { bytesRead } = await file.read(previous, 0, previous.length, offset);
          conflictingRetry = bytesRead !== previous.length || !previous.equals(body.data);
        } else {
          try {
            let written = 0;
            while (written < body.data.length) {
              const { bytesWritten } = await file.write(body.data, written, body.data.length - written, offset + written);
              if (!bytesWritten) throw new Error("Unable to write upload chunk");
              written += bytesWritten;
            }
            upload.offset += body.data.length;
          } catch (error) { await file.truncate(upload.offset); throw error; }
        }
      } finally { await file.close(); }
      if (conflictingRetry) return reply.code(409).send({ error: "Retry data differs from stored chunk" });
      return { offset: upload.offset };
    } finally { upload.busy = false; upload.touched = Date.now(); }
  });

  app.post("/api/uploads/:id/complete", async (request, reply) => {
    const upload = lookup(request);
    if (!upload) return reply.code(404).send({ error: "Upload session not found or expired" });
    if (upload.result) return upload.result;
    if (upload.busy || upload.offset !== upload.size) return reply.code(409).send({ error: "Upload incomplete or busy", offset: upload.offset });
    upload.busy = true;
    try {
      if ((await stat(upload.filePath)).size !== upload.size) return reply.code(409).send({ error: "Upload size mismatch" });
      const fileId = randomUUID();
      const { filePath, metadataPath } = getFilePaths(fileId);
      const metadata = new FileMetadata(fileId, upload.filename, upload.ttl, Date.now() / 1000, 0, 0, null, null, upload.size, upload.folderId);
      await rename(upload.filePath, filePath);
      try { await metadata.save(metadataPath); }
      catch (error) { await rename(filePath, upload.filePath); throw error; }
      upload.result = { id: fileId, filename: upload.filename, url: `${config.baseUrl}/d/${fileId}/${encodeURIComponent(upload.filename)}`, size_bytes: upload.size, expires_in: upload.ttl };
      return upload.result;
    } finally { upload.busy = false; upload.touched = Date.now(); }
  });

  app.delete("/api/uploads/:id", async (request, reply) => {
    const upload = lookup(request);
    if (!upload) return reply.code(404).send({ error: "Upload session not found or expired" });
    if (upload.busy) return reply.code(409).send({ error: "Upload is busy" });
    upload.busy = true;
    try {
      await removeIfExists(upload.filePath);
      uploads.delete((request.params as { id: string }).id);
      return { cancelled: true };
    } finally { upload.busy = false; }
  });
}
