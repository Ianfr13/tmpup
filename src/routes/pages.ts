/** Server-rendered pages and the admin route (app.py 1808-1830, 1821-1985). */
import type { FastifyInstance } from "fastify";

import { config } from "../config.js";
import { escapeHtml, jsonForScript } from "../html.js";
import { setAllFilesInfiniteTtl } from "../storage.js";
import { renderListPage, renderMcpSetupPage } from "../templates/index.js";

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/** `POST /admin/set-all-infinite`: TTL=0 for every stored file. */
function setAllInfinite(): Promise<number> {
  return setAllFilesInfiniteTtl();
}

/** Render the MCP setup page exactly like the Python route. */
function renderMcpSetup(): string {
  const mcpUrl = `${config.baseUrl}/mcp`;
  const configDict = {
    mcpServers: {
      tmpup: {
        type: "http",
        url: mcpUrl,
        headers: { "X-API-Key": "SUA_CHAVE_AQUI" },
      },
    },
  };
  return renderMcpSetupPage({
    baseUrl: escapeHtml(config.baseUrl),
    // The JSON goes into a single-quoted onclick attribute, so apostrophes must
    // not be able to close it (app.py interpolated both values raw).
    mcpUrlJs: jsonForScript(mcpUrl).replaceAll("'", "&#x27;"),
    // Rendered inside a <pre>: escape the markup-sensitive characters without
    // touching the quotes of the JSON itself (app.py interpolated it raw).
    jsonConfig: escapeHtml(JSON.stringify(configDict, null, 2), false),
  });
}

export async function registerPageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_request, reply) => {
    return reply.type(HTML_CONTENT_TYPE).send(renderListPage());
  });

  app.get("/mcp-setup", async (_request, reply) => {
    return reply.type(HTML_CONTENT_TYPE).send(renderMcpSetup());
  });

  app.post("/admin/set-all-infinite", async () => {
    const updated = await setAllInfinite();
    return { updated };
  });
}
