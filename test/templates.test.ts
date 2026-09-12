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
  it("raw template files are byte-identical to the Python template constants", () => {
    expect(sha256(HTML_TEMPLATE)).toBe("204560f8ba3442a226564ed93f1438d7f653056146bf5b442ad48fb448dc940e");
    expect(sha256(LOGIN_HTML)).toBe("a415e461645331a46a6ade4bb8513abab09fd795d330c968f88864a902b1d950");
    expect(sha256(VIEWER_TEMPLATE)).toBe("4685f65497558d50a88453689e6bbc817056b9ac5421cd62b8e635426e3dd486");
    expect(sha256(MCP_SETUP_TEMPLATE)).toBe("928e48bb963dbbc7eae806a17d4ea2850aeed74ffadb94011dd5b525f823953e");
  });

  it("renders the viewer page byte-identically to Python str.format", () => {
    const baseUrl = "https://tmpup.douravita.com.br";
    const filename = 'a"b<script>&.png';
    const fileId = "11111111-1111-1111-1111-111111111111";
    const html = renderViewerPage({
      filename: escapeHtml(filename),
      imageUrl: escapeHtml(`/d/${fileId}/${filename}`, true),
      downloadUrl: escapeHtml(`/d/${fileId}/${filename}?dl=1`, true),
      imageUrlAbsJson: jsonForScript(`${baseUrl}/d/${fileId}/${filename}`),
      fileIdJson: jsonForScript(fileId),
      expiryText: "Expira em 5min",
    });
    expect(sha256(html)).toBe("d3a42f4352fb088e5c7ac13c301e0865303571d6f5d24a3f83e0ead16aaa2be1");
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
    expect(sha256(html)).toBe("be36cf4c4733297cfe2f83a79bc6beb2356126356f6c41d5b807dc0c14344cde");
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
describe("frontend template contracts (ported from test_app.py)", () => {
  it("uses the /t/ thumbnail route instead of the raw /d/ url", () => {
    expect(
      HTML_TEMPLATE.includes('replace("/d/", "/t/")') || HTML_TEMPLATE.includes("replace('/d/', '/t/')"),
    ).toBe(true);
    expect(HTML_TEMPLATE).not.toContain('<img class="file-thumb" src="${esc(f.url)}"');
  });

  it("contains pagination UI and client-side logic", () => {
    expect(HTML_TEMPLATE).toContain("Anterior");
    expect(HTML_TEMPLATE).toContain("Proxima");
    expect(HTML_TEMPLATE).toContain("prevPageBtn");
    expect(HTML_TEMPLATE).toContain("nextPageBtn");
    expect(HTML_TEMPLATE.includes("/api/files?") || HTML_TEMPLATE.includes("URLSearchParams")).toBe(true);
    expect(HTML_TEMPLATE).toContain("currentPage = 1");
  });

  it("contains search debounce, request token and page clamp", () => {
    expect(HTML_TEMPLATE).toContain("searchDebounceTimer");
    expect(HTML_TEMPLATE).toContain("clearTimeout(searchDebounceTimer)");
    expect(HTML_TEMPLATE).toContain("setTimeout");
    expect(HTML_TEMPLATE).toContain("300");
    expect(HTML_TEMPLATE).toContain("loadFilesRequestId");
    expect(HTML_TEMPLATE).toContain("requestId !== loadFilesRequestId");
    expect(HTML_TEMPLATE).toContain("Math.min(currentPage");
    expect(
      HTML_TEMPLATE.includes("currentPage > validPage") ||
        HTML_TEMPLATE.includes("currentPage !== validPage"),
    ).toBe(true);
  });

  it("links to the MCP setup page", () => {
    expect(HTML_TEMPLATE).toContain('href="/mcp-setup"');
    expect(HTML_TEMPLATE).toContain("MCP");
  });
});
