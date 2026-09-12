import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { config } from "../src/config.js";
import { buildServer } from "../src/server.js";

const ORIGINAL_CONFIG = {
  dataDir: config.dataDir,
  apiKeys: new Set(config.apiKeys),
};

/** Create a throwaway data dir and point `config.dataDir` at it. */
export async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tmpup-test-"));
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  config.dataDir = dataDir;
  return dataDir;
}

/** Point `config.dataDir` at an existing directory. */
export function useDataDir(dir: string): void {
  config.dataDir = dir;
}

/** Replace the accepted API keys (TypeScript equivalent of monkeypatching API_KEYS). */
export function useApiKeys(...keys: string[]): void {
  config.apiKeys = new Set(keys);
}

/** Restore the config captured at module load. */
export function restoreConfig(): void {
  config.dataDir = ORIGINAL_CONFIG.dataDir;
  config.apiKeys = new Set(ORIGINAL_CONFIG.apiKeys);
}

/** Build a Fastify instance ready for `app.inject()`. */
export async function buildTestServer(): Promise<FastifyInstance> {
  return buildServer();
}

/** Remove a temporary data dir created by {@link makeDataDir}. */
export async function removeDataDir(dataDir: string): Promise<void> {
  await rm(path.dirname(dataDir), { recursive: true, force: true });
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

/**
 * Minimal fake Response for the sync helpers that return a Fastify reply-less
 * response object (downloadFile/viewFile/thumbnailFile).
 */
export interface CapturedFileResponse {
  status?: number;
  headers: Record<string, string>;
  body?: Buffer | string;
  redirect?: string;
  filePath?: string;
  contentType?: string;
}
