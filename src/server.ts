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
import { registerFolderRoutes } from "./routes/folders.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerTransferRoutes } from "./routes/transfer.js";

export interface BuildServerOptions {
  /** Enable Fastify's request logging (off in tests). */
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // close() must not wait for idle keep-alive sockets (a browser/undici pool
    // would otherwise hold the shutdown open); in-flight requests still finish.
    forceCloseConnections: "idle",
    // Fastify sets requestTimeout to 0 (= disabled) on the underlying server, so
    // the documented drain of an oversized body and the upload stream would have
    // no bound at all against a client that dribbles bytes forever.
    requestTimeout: 300_000,
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.statusCode >= 500) {
        // Log the real reason but never leak internals (paths, driver text) to
        // the client; app.py forwarded the detail verbatim here.
        request.log.error({ err: error }, "request failed");
        void reply.code(error.statusCode).send({ detail: "Internal Server Error" });
        return;
      }
      void reply.code(error.statusCode).send({ detail: error.detail });
      return;
    }
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? ((error as { statusCode: number }).statusCode as number)
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    const detail = statusCode >= 500 ? "Internal Server Error" : (error as Error).message;
    void reply.code(statusCode).send({ detail });
  });

  await registerAuthRoutes(app);
  await registerFileRoutes(app);
  await registerFolderRoutes(app);
  await registerTransferRoutes(app);
  await registerPageRoutes(app);
  await registerMcpRoutes(app);

  return app;
}
