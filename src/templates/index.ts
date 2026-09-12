/**
 * Server-rendered HTML templates.
 *
 * The `.html` files in this directory are byte-identical copies of the Python
 * template strings in `app.py` (HTML_TEMPLATE, LOGIN_HTML, VIEWER_TEMPLATE,
 * MCP_SETUP_TEMPLATE). Keeping them as real files avoids re-escaping the
 * frontend JS (which is full of backticks and ${...} template literals).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function load(name: string): string {
  return readFileSync(fileURLToPath(new URL("./" + name, import.meta.url)), "utf8");
}

/** Upload/list frontend (app.py HTML_TEMPLATE). */
export const HTML_TEMPLATE: string = load("list.html");
/** Login page (app.py LOGIN_HTML). */
export const LOGIN_HTML: string = load("login.html");
/** Image viewer page, Python str.format template (app.py VIEWER_TEMPLATE). */
export const VIEWER_TEMPLATE: string = load("viewer.html");
/** MCP setup page, {{PLACEHOLDER}} template (app.py MCP_SETUP_TEMPLATE). */
export const MCP_SETUP_TEMPLATE: string = load("mcp-setup.html");

/**
 * Minimal equivalent of Python's `str.format` for the subset used by the
 * templates: `{{` / `}}` are literal braces and `{name}` is substituted from
 * `vars`. Missing variables throw, like Python's KeyError.
 */
export function pythonFormat(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    // hasOwnProperty: `name in vars` would also match Object.prototype keys.
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error("Missing template variable: " + name);
    }
    return vars[name] as string;
  });
}

export interface ViewerPageVars {
  filename: string;
  imageUrl: string;
  downloadUrl: string;
  imageUrlAbsJson: string;
  fileIdJson: string;
  expiryText: string;
}

/** Render the image viewer page exactly like `_view_file` does. */
export function renderViewerPage(vars: ViewerPageVars): string {
  return pythonFormat(VIEWER_TEMPLATE, {
    filename: vars.filename,
    image_url: vars.imageUrl,
    download_url: vars.downloadUrl,
    image_url_abs_json: vars.imageUrlAbsJson,
    file_id_json: vars.fileIdJson,
    expiry_text: vars.expiryText,
  });
}

/** Render the upload frontend page. */
export function renderListPage(): string {
  return HTML_TEMPLATE;
}

/** Render the login page. */
export function renderLoginPage(): string {
  return LOGIN_HTML;
}

export interface McpSetupPageVars {
  baseUrl: string;
  mcpUrlJs: string;
  jsonConfig: string;
}

/** Render the MCP setup page exactly like the `/mcp-setup` route does. */
export function renderMcpSetupPage(vars: McpSetupPageVars): string {
  return MCP_SETUP_TEMPLATE.replaceAll("{{BASE_URL}}", () => vars.baseUrl)
    .replaceAll("{{MCP_URL_JS}}", () => vars.mcpUrlJs)
    .replaceAll("{{JSON_CONFIG}}", () => vars.jsonConfig);
}
