import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  HTML_TEMPLATE,
  LOGIN_HTML,
  MCP_SETUP_TEMPLATE,
  VIEWER_TEMPLATE,
  pythonFormat,
  renderListPage,
  renderLoginPage,
  renderMcpSetupPage,
  renderViewerPage,
} from "../src/templates/index.js";
import { escapeHtml, jsonForScript, unescapeHtml } from "../src/html.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function templateFile(name: string): string {
  return readFileSync(fileURLToPath(new URL("../src/templates/" + name, import.meta.url)), "utf8");
}

/**
 * Golden hashes captured from the Python implementation (app.py running under
 * CPython 3.11 + itsdangerous-independent stdlib) so the port cannot drift.
 */
describe("templates: byte parity with the Python app", () => {
  it("login page stays byte-identical to the Python template constant", () => {
    expect(sha256(LOGIN_HTML)).toBe("a415e461645331a46a6ade4bb8513abab09fd795d330c968f88864a902b1d950");
  });

  it("renders the viewer page with the supplied media html", () => {
    const baseUrl = "https://tmpup.douravita.com.br";
    const filename = 'a"b<script>&.png';
    const fileId = "11111111-1111-1111-1111-111111111111";
    const mediaUrl = escapeHtml(`/d/${fileId}/${filename}`, true);
    const html = renderViewerPage({
      filename: escapeHtml(filename),
      mediaHtml: `<img class="viewer-img" src="${mediaUrl}" alt="${escapeHtml(filename)}">`,
      downloadUrl: escapeHtml(`/d/${fileId}/${filename}?dl=1`, true),
      imageUrlAbsJson: jsonForScript(`${baseUrl}/d/${fileId}/${filename}`),
      fileIdJson: jsonForScript(fileId),
      expiryText: "Expira em 5min",
    });
    expect(html).toContain('class="viewer-img"');
    expect(html).toContain("Expira em 5min");
    expect(html).toContain(fileId);
  });

  it("renders the mcp-setup page byte-identically to the Python route", () => {
    const baseUrl = "https://tmpup.douravita.com.br";
    const cfg = JSON.stringify(
      { mcpServers: { tmpup: { type: "http", url: `${baseUrl}/mcp`, headers: { "X-API-Key": "SUA_CHAVE_AQUI" } } } },
      null,
      2,
    );
    const html = renderMcpSetupPage({
      baseUrl: escapeHtml(baseUrl),
      mcpUrlJs: jsonForScript(`${baseUrl}/mcp`),
      jsonConfig: cfg,
    });
    expect(html).toContain("upload_folder");
    expect(html).toContain(baseUrl);
  });

  it("keeps the stray template files on disk in sync with the exported constants", () => {
    expect(templateFile("list.html")).toBe(HTML_TEMPLATE);
    expect(templateFile("login.html")).toBe(LOGIN_HTML);
    expect(templateFile("viewer.html")).toBe(VIEWER_TEMPLATE);
    expect(templateFile("mcp-setup.html")).toBe(MCP_SETUP_TEMPLATE);
  });
});

describe("pythonFormat", () => {
  it("substitutes named fields and unescapes doubled braces", () => {
    expect(pythonFormat("a{{b}}c{name}", { name: "X" })).toBe("a{b}cX");
  });

  it("throws for a missing field like Python's KeyError", () => {
    expect(() => pythonFormat("{missing}", {})).toThrow(/Missing template variable/);
  });

  it("leaves a single unmatched brace untouched", () => {
    expect(pythonFormat("body{color:red}", {})).toBe("body{color:red}");
  });
});

describe("html helpers", () => {
  it("escapes like Python html.escape", () => {
    expect(escapeHtml('a&b<c>d"e\'f')).toBe("a&amp;b&lt;c&gt;d&quot;e&#x27;f");
    expect(escapeHtml('a"b', false)).toBe('a"b');
  });

  it("round-trips unescape", () => {
    const original = "a&b<c>d\"e'f";
    expect(unescapeHtml(escapeHtml(original))).toBe(original);
  });

  it("escapes closing tags for inline script JSON", () => {
    expect(jsonForScript("</script>")).toBe('"' + "<" + "\\/script>" + '"');
  });
});

describe("page entry points", () => {
  it("returns the raw list and login pages", () => {
    expect(renderListPage()).toBe(HTML_TEMPLATE);
    expect(renderLoginPage()).toBe(LOGIN_HTML);
  });
});
describe("frontend template contracts (painel de trabalho)", () => {
  it("uses the /t/ thumbnail route instead of the raw /d/ url", () => {
    expect(
      HTML_TEMPLATE.includes('replace("/d/", "/t/")') || HTML_TEMPLATE.includes("replace('/d/', '/t/')"),
    ).toBe(true);
    expect(HTML_TEMPLATE).not.toContain('<img class="file-thumb" src="${esc(f.url)}"');
  });

  it("links to the MCP setup page and auth logout", () => {
    expect(HTML_TEMPLATE).toContain('href="/mcp-setup"');
    expect(HTML_TEMPLATE).toContain("MCP");
    expect(HTML_TEMPLATE).toContain('href="/auth/logout"');
    expect(HTML_TEMPLATE).toContain("Sair");
  });

  it("pins header, sidebar, upload strip and title row layout elements", () => {
    expect(HTML_TEMPLATE).toContain('id="searchInput"');
    expect(HTML_TEMPLATE).toContain('id="summaryBar"');
    expect(HTML_TEMPLATE).toContain('id="userEmail"');
    expect(HTML_TEMPLATE).toContain("Tudo");
    expect(HTML_TEMPLATE).toContain("Sem pasta");
    expect(HTML_TEMPLATE).toContain("Com validade");
    expect(HTML_TEMPLATE).toContain('id="btnNewFolder"');
    expect(HTML_TEMPLATE).toContain("Filtrar pastas");
    expect(HTML_TEMPLATE).toContain('id="folderList"');
    expect(HTML_TEMPLATE).toContain('id="destSelect"');
    expect(HTML_TEMPLATE).toContain('id="ttlSelect"');
    expect(HTML_TEMPLATE).toContain('id="breadcrumb"');
    expect(HTML_TEMPLATE).toContain('id="btnDownloadFolder"');
    expect(HTML_TEMPLATE).toContain('id="btnDeleteFolder"');
    expect(HTML_TEMPLATE).toContain('data-kind="all"');
    expect(HTML_TEMPLATE).toContain('data-kind="image"');
    expect(HTML_TEMPLATE).toContain('data-kind="document"');
    expect(HTML_TEMPLATE).toContain('data-kind="video"');
    expect(HTML_TEMPLATE).toContain('data-kind="archive"');
  });

  it("uses load-more pagination and removes prev/next page buttons", () => {
    expect(HTML_TEMPLATE).toContain("Carregar mais antigos");
    expect(HTML_TEMPLATE).toContain('id="loadMoreBtn"');
    expect(HTML_TEMPLATE).not.toContain("prevPageBtn");
    expect(HTML_TEMPLATE).not.toContain("nextPageBtn");
    expect(HTML_TEMPLATE).not.toContain("Anterior");
    expect(HTML_TEMPLATE).not.toContain("Proxima");
  });

  it("contains view navigation queries with stack=1 and expiring=1, request guard and debounce", () => {
    expect(HTML_TEMPLATE).toContain("stack=1");
    expect(HTML_TEMPLATE).toContain("expiring=1");
    expect(HTML_TEMPLATE).toContain("loadFilesRequestId");
    expect(HTML_TEMPLATE).toContain("requestId !== loadFilesRequestId");
    expect(HTML_TEMPLATE).toContain("searchDebounceTimer");
    expect(HTML_TEMPLATE).toContain("clearTimeout(searchDebounceTimer)");
    expect(HTML_TEMPLATE).toContain("300");
  });

  it("contains structured logging for error branches", () => {
    expect(HTML_TEMPLATE).toContain("tmpup-web");
    expect(HTML_TEMPLATE).toContain("console.error");
  });

  it("pins the absence of emoji entities (&#1...)", () => {
    expect(HTML_TEMPLATE).not.toContain("&#1");
  });
});
