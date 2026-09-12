/**
 * MCP server: the 5 tools exposed by app.py (1991-2102) plus the Streamable
 * HTTP endpoint mounted at /mcp.
 *
 * Tool names, parameters, docstrings and error messages are ported 1:1.
 */
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { config } from "./config.js";
import { filterSortPaginateFiles } from "./files.js";
import { logEvent } from "./logger.js";
import {
  FileMetadata,
  deleteFileById,
  extendFileTtl,
  getFileInfo as readFileInfo,
  getFilePaths,
  listActiveFiles,
  validateTtl,
} from "./storage.js";
import type { FileListPage, PublicFileMetadata, UploadResult } from "./types.js";

function maxSizeMessage(): string {
  const megabytes = Math.trunc(config.maxMcpUploadSize / (1024 * 1024));
  return `File exceeds maximum allowed size (${megabytes}MB)`;
}

async function removeIfExists(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Strict base64 decoding, equivalent to
 * `base64.b64decode(value, validate=True)` (Node's decoder is lenient).
 */
export function strictBase64Decode(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid base64-encoded string");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length === padding) {
    return Buffer.alloc(0);
  }
  return Buffer.from(value, "base64");
}

/** `upload_file` tool implementation: base64 payload -> stored file. */
export async function uploadFile(
  filename: string,
  contentBase64: string,
  ttl = 0,
): Promise<UploadResult> {
  let validTtl: number;
  try {
    validTtl = validateTtl(ttl);
  } catch (error) {
    logEvent("mcp_upload_failed", { filename, ttl, error: (error as Error).message });
    throw error;
  }

  const pad = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  const estimatedSize = Math.floor((contentBase64.length * 3) / 4) - pad;
  if (estimatedSize > config.maxMcpUploadSize) {
    const message = maxSizeMessage();
    logEvent("mcp_upload_failed", { filename, error: message });
    throw new Error(message);
  }

  let content: Buffer;
  try {
    content = strictBase64Decode(contentBase64);
  } catch (error) {
    const message = `Invalid base64: ${(error as Error).message}`;
    logEvent("mcp_upload_failed", { filename, error: message });
    throw new Error(message, { cause: error });
  }

  if (content.length === 0) {
    logEvent("mcp_upload_failed", { filename, error: "Empty file" });
    throw new Error("Empty file");
  }

  if (content.length > config.maxMcpUploadSize) {
    const message = maxSizeMessage();
    logEvent("mcp_upload_failed", { filename, error: message });
    throw new Error(message);
  }

  const fileId = randomUUID();
  const { filePath, metadataPath } = getFilePaths(fileId);

  try {
    await writeFile(filePath, content);

    const metadata = new FileMetadata(
      fileId,
      filename,
      validTtl,
      Date.now() / 1000,
      0,
      0,
      null,
      null,
      content.length,
    );
    await metadata.save(metadataPath);

    logEvent("mcp_upload_success", {
      file_id: fileId,
      filename,
      size: content.length,
      ttl: validTtl,
    });
    return {
      url: `${config.baseUrl}/d/${fileId}/${filename}`,
      id: fileId,
      expires_in: validTtl,
    };
  } catch (error) {
    await removeIfExists(filePath).catch(() => undefined);
    await removeIfExists(metadataPath).catch(() => undefined);
    logEvent("mcp_upload_failed", { filename, error: (error as Error).message });
    throw error;
  }
}

export interface ListFilesOptions {
  q?: string | null;
  kind?: string;
  sort?: string;
  page?: number;
}

/** `list_files` tool implementation. */
export async function listFiles(options: ListFilesOptions = {}): Promise<FileListPage> {
  const allFiles = await listActiveFiles();
  return filterSortPaginateFiles(allFiles, {
    q: options.q ?? null,
    kind: options.kind ?? "all",
    sort: options.sort ?? "date",
    page: options.page ?? 1,
  });
}

/** `get_file_info` tool implementation. */
export async function getFileInfo(fileId: string): Promise<PublicFileMetadata> {
  const info = await readFileInfo(fileId);
  if (!info) {
    throw new Error(`File not found: ${fileId}`);
  }
  return info;
}

/** `extend_ttl` tool implementation. */
export async function extendTtl(fileId: string, ttl: number): Promise<PublicFileMetadata> {
  const info = await extendFileTtl(fileId, ttl);
  if (!info) {
    throw new Error(`File not found: ${fileId}`);
  }
  return info;
}

/** `delete_file` tool implementation. */
export async function deleteFile(fileId: string): Promise<{ deleted: boolean }> {
  return { deleted: await deleteFileById(fileId) };
}

function asToolResult(value: unknown): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "TmpUp", version: "2.0.0" });

  server.registerTool(
    "upload_file",
    {
      description: "Upload a file encoded in base64 with TTL in seconds (0 = never expires).",
      inputSchema: {
        filename: z.string(),
        content_base64: z.string(),
        ttl: z.number().int().optional(),
      },
    },
    async ({ filename, content_base64, ttl }) => asToolResult(await uploadFile(filename, content_base64, ttl ?? 0)),
  );

  server.registerTool(
    "list_files",
    {
      description:
        "List active (non-expired) files with metadata, filtered and paginated.\n\n" +
        "Supports search by name/substring (q), filter by file type (kind: all/image/document/video/archive),\n" +
        "sorting (sort: date/name/size/expiry), and pagination (page, returns up to 50 items per page).\n" +
        "To look up a specific file by its unique ID, use the separate get_file_info(file_id) tool.",
      inputSchema: {
        q: z.string().optional(),
        kind: z.string().optional(),
        sort: z.string().optional(),
        page: z.number().int().optional(),
      },
    },
    async ({ q, kind, sort, page }) => asToolResult(await listFiles({ q, kind, sort, page })),
  );

  server.registerTool(
    "get_file_info",
    {
      description: "Get metadata for a specific active file.",
      inputSchema: { file_id: z.string() },
    },
    async ({ file_id }) => asToolResult(await getFileInfo(file_id)),
  );

  server.registerTool(
    "extend_ttl",
    {
      description: "Extend or update TTL for an existing file.",
      inputSchema: { file_id: z.string(), ttl: z.number().int() },
    },
    async ({ file_id, ttl }) => asToolResult(await extendTtl(file_id, ttl)),
  );

  server.registerTool(
    "delete_file",
    {
      description: "Delete a file by ID.",
      inputSchema: { file_id: z.string() },
    },
    async ({ file_id }) => asToolResult(await deleteFile(file_id)),
  );

  return server;
}

/** Long-lived instance kept for parity with app.py's module-level `mcp`. */
export const mcp: McpServer = createMcpServer();

export function isPlainBody(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Buffer.isBuffer(value);
}

/**
 * Mount the MCP Streamable HTTP endpoint at /mcp (stateless: one server per
 * request).
 *
 * Only POST is supported: this deployment is stateless (no session ids) and
 * answers JSON, so it never offers the standalone SSE stream. The Streamable
 * HTTP spec allows a 405 for GET/DELETE in that case; without it the transport
 * would open an SSE stream that never ends and leak the per-request server.
 */
export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    reply.hijack();
    try {
      await server.connect(transport);
      const parsedBody = isPlainBody(request.body) ? request.body : undefined;
      await transport.handleRequest(request.raw, reply.raw, parsedBody);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };

  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await reply.code(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed." },
      id: null,
    });
  };

  for (const url of ["/mcp", "/mcp/"]) {
    app.post(url, handler);
    app.route({
      method: ["GET", "DELETE", "PUT", "PATCH", "OPTIONS"],
      url,
      handler: methodNotAllowed,
    });
  }
}
