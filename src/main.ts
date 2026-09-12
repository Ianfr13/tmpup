/** Process entry point: startup tasks + HTTP listener. */
import { assertRuntimeConfig, config } from "./config.js";
import { runStartupTasks } from "./lifecycle.js";
import { buildServer } from "./server.js";

assertRuntimeConfig();

const stopCleanup = await runStartupTasks();
const app = await buildServer({ logger: true });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  // A second SIGINT/SIGTERM (Ctrl-C twice, docker stop retry, orchestrator
  // escalation) must not re-enter close() while the first one is pending.
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  stopCleanup();
  try {
    await app.close();
  } catch (error) {
    app.log.error({ error }, "error during shutdown");
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

await app.listen({ host: config.httpHost, port: config.port });
