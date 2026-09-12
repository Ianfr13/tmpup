import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { config, type Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

/** Full config snapshot taken at module load (apiKeys cloned, not shared). */
const ORIGINAL_CONFIG: Config = { ...config, apiKeys: new Set(config.apiKeys) };

/** Create a throwaway data dir and point `config.dataDir` at it. */
export async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tmpup-test-"));
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  config.dataDir = dataDir;
  return dataDir;
}

/** Replace the accepted API keys (TypeScript equivalent of monkeypatching API_KEYS). */
export function useApiKeys(...keys: string[]): void {
  config.apiKeys = new Set(keys);
}

/** Restore every config field captured at module load. */
export function restoreConfig(): void {
  Object.assign(config, ORIGINAL_CONFIG, { apiKeys: new Set(ORIGINAL_CONFIG.apiKeys) });
}

/** Build a Fastify instance ready for `app.inject()`. */
export async function buildTestServer(): Promise<FastifyInstance> {
  return buildServer();
}

/**
 * Remove a data dir created by {@link makeDataDir}: its `<mkdtemp>/data`
 * parent is what `mkdtemp` created, so that is what gets deleted. A path that
 * does not follow the convention is removed directly instead of deleting an
 * unrelated parent directory.
 */
export async function removeDataDir(dataDir: string): Promise<void> {
  const parent = path.dirname(dataDir);
  const target = path.basename(dataDir) === "data" && path.basename(parent).startsWith("tmpup-test-")
    ? parent
    : dataDir;
  await rm(target, { recursive: true, force: true });
}

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * One-shot HTTP call over a real socket.
 *
 * Uses node:http with `agent: false` instead of fetch: the global keep-alive
 * dispatcher holds idle sockets open, and Fastify's close() would then wait for
 * them (the socket tests hung on app.close()). A body sent without a
 * content-length header is chunked, which exercises the streaming paths.
 */
export function httpCall(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: options.method ?? "GET", headers: options.headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

/** API key used by the ported `auth_client` fixture. */
export const TEST_API_KEY = "test-key";

/** Build a server whose requests are authenticated with an API key. */
export async function buildAuthenticatedServer(key: string = TEST_API_KEY): Promise<FastifyInstance> {
  useApiKeys(key);
  return buildTestServer();
}

/** Headers matching the ported `auth_client` fixture. */
export function authHeader(key: string = TEST_API_KEY): Record<string, string> {
  return { "x-api-key": key };
}

