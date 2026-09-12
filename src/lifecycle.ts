/** Startup / shutdown side effects (mirrors app.py startup_event and cleanup_task). */
import { config } from "./config.js";
import { logEvent } from "./logger.js";
import { cleanupExpiredFiles, ensureDataDir, setAllFilesInfiniteTtl } from "./storage.js";

/** Boot migration (app.py startup_event): every existing file becomes TTL=0.
 * It runs on every boot, but only rewrites sidecars whose ttl is not already 0. */
export async function migrateAllToInfiniteTtl(): Promise<number> {
  await ensureDataDir();
  const migrated = await setAllFilesInfiniteTtl();
  if (migrated > 0) {
    console.log(`Migrated ${migrated} file(s) to infinite TTL`);
  }
  return migrated;
}

/**
 * Start the periodic expired-file cleanup.
 *
 * app.py's loop was `while True: await sleep(); cleanup()`: strictly sequential.
 * setInterval would start a new pass while the previous one is still running
 * (racy unlinks and a double-counted `cleaned`), so ticks are skipped while a
 * pass is in flight. The returned stop function clears the timer and waits for
 * the in-flight pass, so shutdown never races a running cleanup.
 */
export function startCleanupLoop(): () => Promise<void> {
  let running = false;
  let current: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    current = cleanupExpiredFiles()
      .catch((error: unknown) => {
        console.error("cleanup failed:", error);
      })
      .then(() => {
        running = false;
      });
  }, config.cleanupIntervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await current;
  };
}

/** Everything app.py did in its startup event. */
export async function runStartupTasks(): Promise<() => Promise<void>> {
  await migrateAllToInfiniteTtl();
  const stop = startCleanupLoop();
  return stop;
}
