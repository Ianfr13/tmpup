/** Process entry point: startup tasks + HTTP listener. */
import { assertRuntimeConfig, config } from "./config.js";
import { runStartupTasks } from "./lifecycle.js";
import { buildServer } from "./server.js";

assertRuntimeConfig();

const app = await buildServer({ logger: true });
const stopCleanup = await runStartupTasks();

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  // A second SIGINT/SIGTERM (Ctrl-C twice, docker stop retry, orchestrator
  // escalation) must not re-enter close() while the first one is pending.
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  let failed = false;
  try {
    // Waits for an in-flight cleanup pass, then stops the timer.
    await stopCleanup();
    await app.close();
  } catch (error) {
    failed = true;
    app.log.error({ err: error }, "error during shutdown");
  }
  process.exit(failed ? 1 : exitCode);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

try {
  await app.listen({ host: config.httpHost, port: config.port });
  console.log(`TmpUp started - data directory: ${config.dataDir}`);
  console.log(`Auto-cleanup every ${config.cleanupIntervalMs / 1000} seconds`);
} catch (error) {
  app.log.error({ err: error }, "failed to bind the HTTP listener");
  await shutdown("listen-failed", 1);
}
