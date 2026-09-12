/** Filesystem helpers shared by the route modules. */
import { unlink } from "node:fs/promises";

/** ENOENT-tolerant unlink (Python's `Path.unlink(missing_ok=True)`). */
export async function removeIfExists(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
