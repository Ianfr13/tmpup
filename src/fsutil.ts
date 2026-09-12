/** Filesystem/stream helpers shared by the route modules. */
import { unlink } from "node:fs/promises";
import type { Readable } from "node:stream";

/** ENOENT-tolerant unlink (Python's `Path.unlink(missing_ok=True)`). */
export async function removeIfExists(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface LimitedBody {
  /** Bytes read while still under the limit. */
  data: Buffer;
  /** True when the body exceeded the limit (the rest was drained/discarded). */
  tooLarge: boolean;
}

/**
 * Read a request body with a hard size limit.
 *
 * The catch-all content-type parser hands every body over as a stream, so
 * Fastify's own `bodyLimit` never applies. Oversized bodies are NOT aborted
 * mid-iteration: throwing inside the read loop destroys the request socket
 * before the handler can answer (the client would see a connection reset, not
 * the 413). Instead the excess is drained up to a bounded multiple of the
 * limit, which keeps the response deliverable and still drops a flood.
 */
export async function readLimitedBody(stream: Readable, limit: number): Promise<LimitedBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  let drained = 0;
  let tooLarge = false;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limit) {
      tooLarge = true;
      drained += buffer.length;
      if (drained > limit * 8) {
        stream.destroy();
        break;
      }
      continue;
    }
    chunks.push(buffer);
  }
  return { data: Buffer.concat(chunks), tooLarge };
}
