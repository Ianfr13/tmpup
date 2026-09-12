/** Startup / shutdown side effects (mirrors app.py startup_event and cleanup_task). */
import { config } from "./config.js";
import { logEvent } from "./logger.js";
import { cleanupExpiredFiles, ensureDataDir, setAllFilesInfiniteTtl } from "./storage.js";

/** One-time migration performed on boot: every existing file becomes TTL=0. */
export async function migrateAllToInfiniteTtl(): Promise<number> {
  await ensureDataDir();
  const migrated = await setAllFilesInfiniteTtl();
  if (migrated > 0) {
    console.log(`Migrated ${migrated} file(s) to infinite TTL`);
  }
  return migrated;
}

/** Start the periodic expired-file cleanup. Returns a stop function. */
export function startCleanupLoop(): () => void {
  // app.py's loop was `while True: await sleep(); cleanup()`: strictly
  // sequential. setInterval would start a new pass while the previous one is
  // still running (racy unlinks and a double-counted `cleaned`), so skip ticks.
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void cleanupExpiredFiles()
      .catch((error: unknown) => {
        console.error("cleanup failed:", error);
      })
      .finally(() => {
        running = false;
      });
  }, config.cleanupIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Everything app.py did in its startup event. */
export async function runStartupTasks(): Promise<() => void> {
  await ensureDataDir();
  await migrateAllToInfiniteTtl();
  const stop = startCleanupLoop();
  console.log(`TmpUp started - data directory: ${config.dataDir}`);
  console.log(`Auto-cleanup every ${config.cleanupIntervalMs / 1000} seconds`);
  logEvent("startup", { data_dir: config.dataDir });
  return stop;
}
