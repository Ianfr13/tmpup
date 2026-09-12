/**
 * Fastify application factory.
 *
 * Mirrors the assembly at the bottom of app.py: middleware (auth), the REST
 * routes, the file-transfer routes, the server-rendered pages and the MCP
 * server mounted at /mcp.
 */
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { authHook } from "./auth.js";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { registerMcpRoutes } from "./mcp.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerTransferRoutes } from "./routes/transfer.js";

export interface BuildServerOptions {
  /** Enable Fastify's request logging (off in tests). */
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // MCP tool calls carry base64 payloads in JSON, so the JSON body limit must
    // accommodate a full 200MB upload (base64 inflates by ~4/3).
    bodyLimit: Math.ceil(config.maxMcpUploadSize * 1.5),
  });

  // Unknown content types are handed to the handler as a raw stream so that
  // POST /api/upload can stream to disk without buffering the file in memory.
  app.addContentTypeParser("*", (_request, payload, done) => {
    done(null, payload);
  });

  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    if (reply.sent) return;
    await authHook(request, reply);
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ detail: "Not Found" });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ detail: error.detail });
      return;
    }
    // FastAPI returns 400 {"detail": "Invalid JSON body"} for malformed JSON.
    if ((error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      void reply.code(400).send({ detail: "Invalid JSON body" });
      return;
    }
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? ((error as { statusCode: number }).statusCode as number)
        : 500;
    if (statusCode >= 500) {
      console.error("request failed:", error);
    }
    const detail = statusCode >= 500 ? "Internal Server Error" : (error as Error).message;
    void reply.code(statusCode).send({ detail });
  });

  await registerAuthRoutes(app);
  await registerFileRoutes(app);
  await registerTransferRoutes(app);
  await registerPageRoutes(app);
  await registerMcpRoutes(app);

  return app;
}
