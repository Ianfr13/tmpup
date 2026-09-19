/**
 * Ported 1:1 from test_app.py (MCP tools: upload_file, list_files,
 * get_file_info, extend_ttl, delete_file).
 *
 * The Python suite's autouse `isolate_data_dir` fixture is the `makeDataDir()`
 * call in `beforeEach`; `capsys` is `vi.spyOn(console, "log")` + `readOut()`
 * (log_event prints one JSON line per event).
 *
 * Adaptations (Python-only details, documented rather than weakened):
 *  - `test_mcp_server_instance`: Python asserts `mcp.name == "TmpUp"` because
 *    FastMCP exposes the server name. The TypeScript SDK's McpServer keeps the
 *    server info private, so the equivalent assertion is that the module-level
 *    `mcp` is a live `McpServer` instance.
 *  - `test_mcp_list_files_docstring`: Python inspects `list_files.__doc__`.
 *    The TypeScript equivalent is the description registered for the
 *    `list_files` tool on the module-level server (read from the SDK's
 *    registered-tool table).
 *  - `test_extend_file_ttl_and_mcp_upload_catch_only_value_error`: Python
 *    monkeypatches `app.validate_ttl` itself. ESM binds storage.ts's internal
 *    `validateTtl(...)` call statically, so spying on the module export only
 *    reaches its consumers (mcp.uploadFile) and not storage's own
 *    `extendFileTtl`. The TypeError is injected inside the body of the real
 *    `validateTtl` instead (`Number.isInteger`), which reaches both call sites
 *    and asserts exactly the same behaviour: a non-validation error propagates
 *    unchanged out of `extendFileTtl` and `uploadFile`.
 *  - `test_mcp_upload_file_rejects_payload_exceeding_size_limit`:
 *    `monkeypatch.setattr(app, "MAX_MCP_UPLOAD_SIZE", 30)` becomes a temporary
 *    `config.maxMcpUploadSize = 30` (restored in a `finally`).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { zipSync } from "fflate";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import {
  deleteFile,
  extendTtl,
  getFileInfo,
  listFiles,
  mcp,
  mcpCreateFolder,
  mcpDeleteFolder,
  mcpDownloadFolder,
  mcpUploadFolder,
  uploadFile,
} from "../src/mcp.js";
import { FileMetadata, extendFileTtl } from "../src/storage.js";
import {
  authHeader,
  httpCall,
  buildAuthenticatedServer,
  buildTestServer,
  makeDataDir,
  removeDataDir,
  restoreConfig,
  useApiKeys,
} from "./helpers.js";

let dataDir = "";
let captured: string[] = [];

/** Python's `time.time()`. */
function nowSeconds(): number {
  return Date.now() / 1000;
}

/** capsys.readouterr().out — returns (and clears) everything logged since last call. */
function readOut(): string {
  const out = captured.join("\n");
  captured = [];
  return out ? out + "\n" : "";
}

/** `f"{value:03d}"`. */
function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

/**
 * Python fixture helper: build a `FileMetadata`, `save()` its sidecar and write
 * the payload, exactly like `FileMetadata(file_id=..., ...)` + `save()` +
 * `write_bytes()` in test_app.py.
 */
async function writeFixture(
  fileId: string,
  filename: string,
  ttl: number,
  createdAt: number,
  content: Buffer,
  sizeBytes = 0,
): Promise<void> {
  const metadata = new FileMetadata(fileId, filename, ttl, createdAt, 0, 0, null, null, sizeBytes);
  await metadata.save(path.join(dataDir, `${fileId}.meta.json`));
  await fsp.writeFile(path.join(dataDir, fileId), content);
}

/** Description registered for a tool on the module-level MCP server. */
function toolDescription(name: string): string {
  const registered = (
    mcp as unknown as {
      _registeredTools: Record<string, { description?: string } | undefined>;
    }
  )._registeredTools;
  return registered[name]?.description ?? "";
}

beforeEach(async () => {
  captured = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  });
  dataDir = await makeDataDir();
});

afterEach(async () => {
  vi.restoreAllMocks();
  restoreConfig();
  if (dataDir) {
    await removeDataDir(dataDir);
    dataDir = "";
  }
});

describe("mcp tools", () => {
  it("test_mcp_server_instance", () => {
    // Python: assert mcp.name == "TmpUp"; the TS SDK does not expose the name publicly.
    expect(mcp).toBeInstanceOf(McpServer);
  });

  it("test_mcp_upload_file", async () => {
    const content = Buffer.from("MCP upload test content");
    const b64Content = content.toString("base64");

    // Valid upload
    const res = await uploadFile("mcp_test.txt", b64Content, 1800);
    expect(res).toHaveProperty("url");
    expect(res).toHaveProperty("id");
    expect(res.expires_in).toBe(1800);
    const fileId = res.id;

    // Verify on disk
    const savedFile = path.join(dataDir, fileId);
    expect(fs.existsSync(savedFile)).toBe(true);
    expect(await fsp.readFile(savedFile)).toEqual(content);

    const capturedOut = readOut();
    expect(capturedOut).toContain("mcp_upload_success");

    // Invalid TTL
    await expect(uploadFile("fail.txt", b64Content, -1)).rejects.toThrow(Error);

    // Empty content
    const emptyB64 = Buffer.alloc(0).toString("base64");
    expect(emptyB64).toBe("");
    await expect(uploadFile("empty.txt", emptyB64, 0)).rejects.toThrow("Empty file");

    // Invalid base64
    await expect(uploadFile("bad.txt", "not_valid_base64!!!", 0)).rejects.toThrow(Error);
  });

  it("test_mcp_upload_file_base64_preserves_cause", async () => {
    let caught: unknown;
    try {
      await uploadFile("bad.txt", "not_valid_base64!@#$%", 0);
    } catch (error) {
      caught = error;
    }
    // pytest.raises(ValueError) -> the call must have thrown.
    expect(caught).toBeInstanceOf(Error);
    const cause = (caught as Error).cause;
    expect(cause).toBeDefined();
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe("Invalid base64-encoded string");
  });

  it("test_mcp_list_files", async () => {
    const initial = await listFiles();
    expect(initial).toEqual({
      items: [],
      total: 0,
      page: 1,
      page_size: 50,
      total_pages: 0,
      total_size_bytes: 0,
      expiring_soon_count: 0,
    });

    const mcpF1 = randomUUID();
    await writeFixture(mcpF1, "f1.txt", 0, nowSeconds(), Buffer.from("data1"));

    const files = await listFiles();
    expect(typeof files).toBe("object");
    expect(files.total).toBe(1);
    expect(files.page).toBe(1);
    expect(files.page_size).toBe(50);
    expect(files.total_pages).toBe(1);
    expect(files.items.length).toBe(1);
    expect(files.items[0]!.id).toBe(mcpF1);
  });

  it("test_mcp_get_file_info", async () => {
    const mcpF2 = randomUUID();
    await writeFixture(mcpF2, "f2.txt", 3600, nowSeconds(), Buffer.from("data2"));

    const info = await getFileInfo(mcpF2);
    expect(info.id).toBe(mcpF2);
    expect(info.filename).toBe("f2.txt");

    await expect(getFileInfo("missing-mcp-f2")).rejects.toThrow("File not found: missing-mcp-f2");
  });

  it("test_mcp_extend_ttl", async () => {
    const mcpF3 = randomUUID();
    await writeFixture(mcpF3, "f3.txt", 100, nowSeconds(), Buffer.from("data3"));

    const info = await extendTtl(mcpF3, 86400);
    expect(info.id).toBe(mcpF3);
    expect(info.expires_in).toBeGreaterThan(80000);

    await expect(extendTtl("missing-mcp-f3", 86400)).rejects.toThrow(Error);
  });

  it("test_mcp_delete_file", async () => {
    const mcpF4 = randomUUID();
    await writeFixture(mcpF4, "f4.txt", 3600, nowSeconds(), Buffer.from("data4"));

    const res = await deleteFile(mcpF4);
    expect(res).toEqual({ deleted: true });
    expect(fs.existsSync(path.join(dataDir, mcpF4))).toBe(false);

    const res2 = await deleteFile(mcpF4);
    expect(res2).toEqual({ deleted: false });
  });

  it("test_extend_file_ttl_and_mcp_upload_catch_only_value_error", async () => {
    // Python monkeypatches app.validate_ttl so that it raises a TypeError.
    // ESM statically binds storage.ts's internal validateTtl call, so the
    // injection point that reaches both extendFileTtl and uploadFile is inside
    // validate_ttl's own body: Number.isInteger is called between the type
    // checks. The observable contract asserted below is identical.
    vi.spyOn(Number, "isInteger").mockImplementation(() => {
      throw new TypeError("Simulated unexpected TypeError in validation");
    });

    // In extend_file_ttl: TypeError should NOT be caught by 'except ValueError' and should propagate directly
    const fromExtend = await extendFileTtl("some-id", 3600).catch((error: unknown) => error);
    expect(fromExtend).toBeInstanceOf(TypeError);
    expect((fromExtend as Error).message).toContain("Simulated unexpected TypeError");

    // In upload_file: TypeError should NOT be caught by 'except ValueError' and should propagate directly
    const fromUpload = await uploadFile("test.txt", "aGVsbG8=", 3600).catch((error: unknown) => error);
    expect(fromUpload).toBeInstanceOf(TypeError);
    expect((fromUpload as Error).message).toContain("Simulated unexpected TypeError");
  });

  it("test_mcp_upload_file_rejects_payload_exceeding_size_limit", async () => {
    const originalMaxUploadSize = config.maxMcpUploadSize;
    config.maxMcpUploadSize = 30;
    try {
      const smallData = Buffer.alloc(31, "x");
      const smallB64 = smallData.toString("base64");
      await expect(uploadFile("small_limit.bin", smallB64, 0)).rejects.toThrow(
        "File exceeds maximum allowed size",
      );

      // Verify that invalid base64 in oversized payload still raises the size error (proves it checks BEFORE decoding)
      const oversizedInvalidB64 = "?".repeat(smallB64.length);
      await expect(uploadFile("small_invalid.bin", oversizedInvalidB64, 0)).rejects.toThrow(
        "File exceeds maximum allowed size",
      );

      // Within limit works
      const allowedData = Buffer.alloc(30, "x");
      const allowedB64 = allowedData.toString("base64");
      const res = await uploadFile("allowed.bin", allowedB64, 0);
      expect(res).toHaveProperty("id");
    } finally {
      config.maxMcpUploadSize = originalMaxUploadSize;
    }
  });
});

describe("mcp list_files pagination", () => {
  it("test_mcp_list_files_paginated_over_50_items", async () => {
    const baseTime = nowSeconds();
    for (let i = 0; i < 55; i++) {
      const fid = `file-${pad3(i)}`;
      await writeFixture(
        fid,
        `item_${pad3(i)}.txt`,
        0,
        baseTime + i,
        Buffer.from("0123456789"),
        10,
      );
    }

    const res = await listFiles();
    expect(typeof res).toBe("object");
    expect(res.page).toBe(1);
    expect(res.page_size).toBe(50);
    expect(res.total).toBe(55);
    expect(res.total_pages).toBe(2);
    expect(res.items.length).toBe(50);
    expect(res.total_size_bytes).toBe(550);
    expect(res.expiring_soon_count).toBe(0);
  });

  it("test_mcp_list_files_search_query", async () => {
    const baseTime = nowSeconds();
    const files: [string, string][] = [
      ["f-1", "report_2024.pdf"],
      ["f-2", "report_2025.txt"],
      ["f-3", "notes.doc"],
    ];
    for (const [fid, name] of files) {
      await writeFixture(fid, name, 0, baseTime, Buffer.from("x".repeat(10)), 10);
    }

    const resReport = await listFiles({ q: "report" });
    expect(typeof resReport).toBe("object");
    expect(resReport.total).toBe(2);
    expect(resReport.items.length).toBe(2);
    const filenames = resReport.items.map((f) => f.filename);
    expect(filenames).toContain("report_2024.pdf");
    expect(filenames).toContain("report_2025.txt");

    const res2025 = await listFiles({ q: "2025" });
    expect(res2025.total).toBe(1);
    expect(res2025.items.length).toBe(1);
    expect(res2025.items[0]!.filename).toBe("report_2025.txt");

    const resNone = await listFiles({ q: "nonexistent" });
    expect(resNone.total).toBe(0);
    expect(resNone.items).toEqual([]);
  });

  it("test_mcp_list_files_filter_kind", async () => {
    const baseTime = nowSeconds();
    const files: [string, string][] = [
      ["f-img1", "photo.png"],
      ["f-img2", "diagram.jpg"],
      ["f-doc", "doc.txt"],
      ["f-zip", "archive.zip"],
    ];
    for (const [fid, name] of files) {
      await writeFixture(fid, name, 0, baseTime, Buffer.from("y".repeat(20)), 20);
    }

    const resImg = await listFiles({ kind: "image" });
    expect(typeof resImg).toBe("object");
    expect(resImg.total).toBe(2);
    expect(resImg.items.length).toBe(2);
    const imgNames = new Set(resImg.items.map((f) => f.filename));
    expect(imgNames).toEqual(new Set(["photo.png", "diagram.jpg"]));

    const resDoc = await listFiles({ kind: "document" });
    expect(resDoc.total).toBe(1);
    expect(resDoc.items[0]!.filename).toBe("doc.txt");
  });

  it("test_mcp_list_files_pagination_page_2", async () => {
    const baseTime = nowSeconds();
    for (let i = 0; i < 60; i++) {
      const fid = `page-f-${pad3(i)}`;
      await writeFixture(fid, `data_${pad3(i)}.bin`, 0, baseTime + i, Buffer.from("12345"), 5);
    }

    const p1 = await listFiles({ page: 1 });
    const p2 = await listFiles({ page: 2 });

    expect(p1.page).toBe(1);
    expect(p1.items.length).toBe(50);
    expect(p1.total).toBe(60);
    expect(p1.total_pages).toBe(2);

    expect(p2.page).toBe(2);
    expect(p2.items.length).toBe(10);
    expect(p2.total).toBe(60);
    expect(p2.total_pages).toBe(2);

    const p1Ids = new Set(p1.items.map((f) => f.id));
    const p2Ids = new Set(p2.items.map((f) => f.id));
    for (const id of p2Ids) {
      expect(p1Ids.has(id)).toBe(false);
    }
    expect(new Set([...p1Ids, ...p2Ids]).size).toBe(60);
  });

  it("test_mcp_list_files_docstring", () => {
    // Python: doc = list_files.__doc__ or "" — the registered tool description.
    const doc = toolDescription("list_files");
    expect(doc.includes("(q)") || doc.includes("q:")).toBe(true);
    expect(doc).toContain("kind:");
    expect(doc.includes("(page") || doc.includes("page:")).toBe(true);
    expect(doc).toContain("get_file_info");
  });
});

describe("mcp streamable http endpoint", () => {
  it("test_mcp_get_and_delete_return_405_without_hanging", async () => {
    const app = await buildAuthenticatedServer();
    try {
      // GET used to hijack the reply and open an SSE stream that never ended.
      // app.inject never follows/holds a socket open, so a hang would still
      // surface as the vitest timeout rather than blocking forever.
      const get = await app.inject({
        method: "GET",
        url: "/mcp",
        headers: { ...authHeader(), accept: "text/event-stream" },
      });
      expect(get.statusCode).toBe(405);
      expect(get.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method Not Allowed." },
        id: null,
      });

      const del = await app.inject({ method: "DELETE", url: "/mcp", headers: authHeader() });
      expect(del.statusCode).toBe(405);
    } finally {
      await app.close();
    }
  });

  it("test_mcp_get_without_credentials_is_still_401", async () => {
    useApiKeys();
    const app = await buildTestServer();
    try {
      const res = await app.inject({ method: "GET", url: "/mcp" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: "unauthorized",
        detail: "Provide session cookie or X-API-Key header",
      });
    } finally {
      await app.close();
    }
  });
});

/**
 * The inject()-based tests above bypass Fastify's real body handling, which is
 * how a regression slipped through once: removing the built-in JSON parser to
 * keep uploads byte-exact left POST /mcp with an unread stream, so the transport
 * answered -32700 while every inject test still passed. This one exercises the
 * real HTTP path (listen on an ephemeral port + fetch).
 */
describe("MCP over real HTTP", () => {
  it("serves initialize, tools/list and tools/call on the socket, and 405 for GET", async () => {
    const app = await buildAuthenticatedServer();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      // node:http with agent:false instead of fetch: the global keep-alive
      // dispatcher would hold sockets open and stall app.close().
      const call = async (body: unknown) => {
        const response = await httpCall(address + "/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...authHeader(),
          },
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          json: JSON.parse(response.body.toString("utf8")) as Record<string, unknown>,
        };
      };

      const initialize = await call({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1" },
        },
      });
      expect(initialize.status).toBe(200);
      expect((initialize.json.result as { serverInfo: { name: string } }).serverInfo.name).toBe("TmpUp");

      const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const names = (tools.json.result as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(names).toEqual([
        "upload_file",
        "list_files",
        "get_file_info",
        "extend_ttl",
        "delete_file",
        "create_folder",
        "list_folders",
        "get_folder_info",
        "delete_folder",
        "upload_folder",
        "download_folder",
      ]);

      const toolsCall = await call({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "upload_file", arguments: { filename: "socket-mcp.txt", content_base64: "aGVsbG8=", ttl: 0 } },
      });
      expect(toolsCall.status).toBe(200);
      const toolResult = toolsCall.json.result as {
        content: { type: string; text: string }[];
        structuredContent: { id: string; expires_in: number };
      };
      expect(toolResult.content[0]?.type).toBe("text");
      expect(toolResult.structuredContent.expires_in).toBe(0);
      expect(toolResult.structuredContent.id).toMatch(/^[0-9a-f-]{36}$/);

      const badJson = await httpCall(address + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: "not-json",
      });
      expect(badJson.status).toBe(400);
      expect(JSON.parse(badJson.body.toString("utf8"))).toEqual({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON-RPC message" },
        id: null,
      });

      const get = await httpCall(address + "/mcp", { method: "GET", headers: authHeader() });
      expect(get.status).toBe(405);
    } finally {
      await app.close();
    }
  });
});

describe("mcp folder tools", () => {
  it("uploads a zip folder and downloads metadata", async () => {
    const zip = Buffer.from(zipSync({ "n.txt": new TextEncoder().encode("n") })).toString("base64");
    const uploaded = await mcpUploadFolder("from-mcp", zip, 0);
    expect(uploaded.files).toHaveLength(1);
    expect(uploaded.folder.name).toBe("from-mcp");

    const listed = await listFiles({ folder_id: uploaded.folder.id });
    expect(listed.items).toHaveLength(1);

    const dl = await mcpDownloadFolder(uploaded.folder.id);
    expect(dl.file_count).toBe(1);
    expect(dl.url).toContain("/api/folders/");

    const removed = await mcpDeleteFolder(uploaded.folder.id);
    expect(removed.deleted).toBe(true);
    expect(removed.files_deleted).toBe(1);
  });

  it("upload_file accepts folder_id", async () => {
    const folder = await mcpCreateFolder("box");
    const res = await uploadFile("in.txt", Buffer.from("z").toString("base64"), 0, folder.id);
    const info = await getFileInfo(res.id);
    expect(info.folder_id).toBe(folder.id);
  });
});

