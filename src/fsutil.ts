/** Filesystem/stream helpers shared by the route modules. */
import { unlink } from "node:fs/promises";
import type { Readable } from "node:stream";

/** ENOENT-tolerant unlink (Python's Path.unlink(missing_ok=True)). */
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
  /** True when the body exceeded the limit (the excess was drained/discarded). */
  tooLarge: boolean;
}

/**
 * Read a request body with a hard size limit.
 *
 * The catch-all content-type parser hands every body over as a stream, so
 * Fastify's own bodyLimit never applies. Oversized bodies are NOT aborted and
 * the stream is never destroyed: IncomingMessage.destroy() tears down the
 * socket the handler still has to answer on, so the client would see a
 * connection reset instead of the 413. The excess is drained (discarded) until
 * the request ends; Node's own requestTimeout bounds a stalled flood.
 */
export async function readLimitedBody(stream: Readable, limit: number): Promise<LimitedBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  return { data: Buffer.concat(chunks), tooLarge };
}
