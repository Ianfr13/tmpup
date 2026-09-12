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
  });

  // app.py always consumed the raw request bytes (request.stream()), whatever
  // the content type. Fastify's built-in JSON/text parsers would consume and
  // re-encode the body first, so uploads sent as application/json or text/plain
  // were stored corrupted (re-serialized JSON, re-quoted text). Remove those
  // parsers and hand every body to the handler as a raw stream: routes either
  // parse it explicitly (readJsonBody) or pass it to the MCP transport.
  // Nothing buffers, so Fastify's bodyLimit does not apply to these streams.
  app.removeContentTypeParser(["application/json", "text/plain"]);
  app.addContentTypeParser("*", (_request, payload, done) => {
    done(null, payload);
  });

  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    await authHook(request, reply);
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ detail: "Not Found" });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      if (error.statusCode >= 500) {
        console.error("request failed:", error);
      }
      void reply.code(error.statusCode).send({ detail: error.detail });
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
