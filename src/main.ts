/** Process entry point: startup tasks + HTTP listener. */
import { config } from "./config.js";
import { runStartupTasks } from "./lifecycle.js";
import { buildServer } from "./server.js";

const stopCleanup = await runStartupTasks();
const app = await buildServer({ logger: true });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  stopCleanup();
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

await app.listen({ host: config.httpHost, port: config.port });
