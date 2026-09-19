/**
 * MCP server: the 5 tools exposed by app.py (1991-2102) plus the Streamable
 * HTTP endpoint mounted at /mcp.
 *
 * Tool names, parameters, docstrings and error messages are ported 1:1.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { filterSortPaginateFiles } from "./files.js";
import {
  FolderError,
  createFolder,
  createFolderFromZip,
  deleteFolder,
  getFolderInfo,
  listFolders,
  requireFolder,
} from "./folders.js";
import { readLimitedBody, removeIfExists } from "./fsutil.js";
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
import type { FileListPage, FolderListPage, PublicFileMetadata, PublicFolder, UploadResult } from "./types.js";
import { SERVICE_VERSION } from "./version.js";

function maxSizeMessage(): string {
  const megabytes = Math.trunc(config.maxMcpUploadSize / (1024 * 1024));
  return `File exceeds maximum allowed size (${megabytes}MB)`;
}

/** Number of trailing \`=\` padding characters in a base64 string. */
function base64Padding(value: string): number {
  if (value.endsWith("==")) return 2;
  if (value.endsWith("=")) return 1;
  return 0;
}

/**
 * Strict base64 decoding, equivalent to
 * `base64.b64decode(value, validate=True)` (Node's decoder is lenient).
 */
export function strictBase64Decode(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid base64-encoded string");
  }
  return Buffer.from(value, "base64");
}

/** `upload_file` tool implementation: base64 payload -> stored file. */
export async function uploadFile(
  filename: string,
  contentBase64: string,
  ttl = 0,
  folderId: string | null = null,
): Promise<UploadResult> {
  let validTtl: number;
  try {
    validTtl = validateTtl(ttl);
  } catch (error) {
    logEvent("mcp_upload_failed", { filename, ttl, error: (error as Error).message });
    throw error;
  }

  const pad = base64Padding(contentBase64);
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

  let canonicalFolder: string | null = null;
  if (folderId) {
    try {
      canonicalFolder = (await requireFolder(folderId)).folder_id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logEvent("mcp_upload_failed", { filename, error: message });
      throw error instanceof FolderError ? new Error(message) : error;
    }
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
      canonicalFolder,
    );
    await metadata.save(metadataPath);

    logEvent("mcp_upload_success", {
      file_id: fileId,
      filename,
      size: content.length,
      ttl: validTtl,
      folder_id: canonicalFolder,
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
  folder_id?: string | null;
}

/** `list_files` tool implementation. */
export async function listFiles(options: ListFilesOptions = {}): Promise<FileListPage> {
  const allFiles = await listActiveFiles();
  return filterSortPaginateFiles(allFiles, {
    q: options.q ?? null,
    kind: options.kind ?? "all",
    sort: options.sort ?? "date",
    page: options.page ?? 1,
    folderId: options.folder_id ?? undefined,
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

function asMcpError(err: unknown): never {
  if (err instanceof FolderError) {
    throw new Error(err.message);
  }
  throw err;
}

export async function mcpCreateFolder(name: string): Promise<PublicFolder> {
  try {
    return await createFolder(name);
  } catch (err) {
    asMcpError(err);
  }
}

export async function mcpListFolders(page = 1): Promise<FolderListPage> {
  return listFolders(page);
}

export async function mcpGetFolderInfo(folderId: string): Promise<PublicFolder> {
  const info = await getFolderInfo(folderId);
  if (!info) {
    throw new Error(`Folder not found: ${folderId}`);
  }
  return info;
}

export async function mcpDeleteFolder(folderId: string): Promise<{ deleted: boolean; files_deleted: number }> {
  try {
    const result = await deleteFolder(folderId);
    if (!result.deleted) {
      throw new Error(`Folder not found: ${folderId}`);
    }
    return result;
  } catch (err) {
    asMcpError(err);
  }
}

export async function mcpUploadFolder(
  name: string,
  contentBase64: string,
  ttl = 0,
): Promise<{ folder: PublicFolder; files: PublicFileMetadata[] }> {
  const pad = base64Padding(contentBase64);
  const estimatedSize = Math.floor((contentBase64.length * 3) / 4) - pad;
  if (estimatedSize > config.maxMcpUploadSize) {
    const message = maxSizeMessage();
    logEvent("folder_upload_failed", { error: message });
    throw new Error(message);
  }
  let content: Buffer;
  try {
    content = strictBase64Decode(contentBase64);
  } catch (error) {
    const message = `Invalid base64: ${(error as Error).message}`;
    logEvent("folder_upload_failed", { error: message });
    throw new Error(message, { cause: error });
  }
  if (content.length === 0) {
    logEvent("folder_upload_failed", { error: "Empty file" });
    throw new Error("Empty file");
  }
  try {
    return await createFolderFromZip(name, content, ttl);
  } catch (err) {
    asMcpError(err);
  }
}

export async function mcpDownloadFolder(
  folderId: string,
): Promise<{ url: string; filename: string; file_count: number }> {
  try {
    const info = await getFolderInfo(folderId);
    if (!info) {
      throw new FolderError(404, `Folder not found: ${folderId}`);
    }
    if (info.file_count === 0) {
      throw new FolderError(400, "Folder is empty");
    }
    return { url: info.download_url, filename: `${info.name}.zip`, file_count: info.file_count };
  } catch (err) {
    asMcpError(err);
  }
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
  const server = new McpServer({ name: "TmpUp", version: SERVICE_VERSION });

  server.registerTool(
    "upload_file",
    {
      description:
        "Upload a file encoded in base64 with TTL in seconds (0 = never expires). Optional folder_id places the file in that folder.",
      inputSchema: {
        filename: z.string(),
        content_base64: z.string(),
        ttl: z.number().int().optional(),
        folder_id: z.string().optional(),
      },
    },
    async ({ filename, content_base64, ttl, folder_id }) =>
      asToolResult(await uploadFile(filename, content_base64, ttl ?? 0, folder_id ?? null)),
  );

  server.registerTool(
    "list_files",
    {
      description:
        "List active (non-expired) files with metadata, filtered and paginated.\n\n" +
        "Supports search by name/substring (q), filter by file type (kind: all/image/document/video/archive),\n" +
        "sorting (sort: date/name/size/expiry), and pagination (page, returns up to 50 items per page).\n" +
        "To look up a specific file by its unique ID, use the separate get_file_info(file_id) tool.\n" +
        "Optional folder_id filters to one folder; use folder_id=root for files not in any folder.",
      inputSchema: {
        q: z.string().optional(),
        kind: z.string().optional(),
        sort: z.string().optional(),
        page: z.number().int().optional(),
        folder_id: z.string().optional(),
      },
    },
    async ({ q, kind, sort, page, folder_id }) => asToolResult(await listFiles({ q, kind, sort, page, folder_id })),
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

  server.registerTool(
    "create_folder",
    {
      description: "Create an empty folder.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => asToolResult(await mcpCreateFolder(name)),
  );

  server.registerTool(
    "list_folders",
    {
      description: "List folders with file counts, paginated.",
      inputSchema: { page: z.number().int().optional() },
    },
    async ({ page }) => asToolResult(await mcpListFolders(page ?? 1)),
  );

  server.registerTool(
    "get_folder_info",
    {
      description: "Get metadata for a specific folder.",
      inputSchema: { folder_id: z.string() },
    },
    async ({ folder_id }) => asToolResult(await mcpGetFolderInfo(folder_id)),
  );

  server.registerTool(
    "delete_folder",
    {
      description: "Delete a folder and all files inside it.",
      inputSchema: { folder_id: z.string() },
    },
    async ({ folder_id }) => asToolResult(await mcpDeleteFolder(folder_id)),
  );

  server.registerTool(
    "upload_folder",
    {
      description:
        "Upload a zip encoded in base64. Creates a folder, extracts each file as an independent item (TTL 0 = never expires).",
      inputSchema: {
        name: z.string(),
        content_base64: z.string(),
        ttl: z.number().int().optional(),
      },
    },
    async ({ name, content_base64, ttl }) => asToolResult(await mcpUploadFolder(name, content_base64, ttl ?? 0)),
  );

  server.registerTool(
    "download_folder",
    {
      description:
        "Get an authenticated download URL for a zip of the folder. Fetch the URL with X-API-Key. Fails if the folder is empty.",
      inputSchema: { folder_id: z.string() },
    },
    async ({ folder_id }) => asToolResult(await mcpDownloadFolder(folder_id)),
  );

  return server;
}

/** Long-lived instance kept for parity with app.py's module-level `mcp`. */
export const mcp: McpServer = createMcpServer();



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
  // The transport reads the (unparsed) request stream into memory, so bound the
  // declared payload: a JSON-RPC body only has to carry a base64 200MB upload.
  const maxBodyBytes = Math.ceil(config.maxMcpUploadSize * 1.5);

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      await reply.code(413).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Request body too large." },
        id: null,
      });
      return;
    }

    // Fastify hands every body over as a raw stream (its JSON parser was
    // removed so uploads stay byte-exact), so the JSON-RPC payload is parsed
    // here: this also bounds the memory the transport would otherwise allocate.
    let parsedBody: unknown;
    try {
      const { data, tooLarge } = await readLimitedBody(request.raw, maxBodyBytes);
      if (tooLarge) {
        await reply.code(413).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Request body too large." },
          id: null,
        });
        return;
      }
      parsedBody = JSON.parse(data.toString("utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        // Invalid JSON is a client error (answered below), not a server fault.
        logEvent("mcp_body_read_failed", { error: (error as Error).message });
      }
      await reply.code(400).send({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON-RPC message" },
        id: null,
      });
      return;
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // After hijack() Fastify never writes for this request, so errors that
    // escape the transport have to be answered on the raw response or the
    // client waits forever.
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, parsedBody);
    } catch (error) {
      console.error("mcp request failed:", error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          }),
        );
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
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
