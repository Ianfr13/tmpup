/**
 * Central runtime configuration.
 *
 * Values are read from the environment once at module load. `dataDir` and
 * `apiKeys` are intentionally mutable so tests can point them at a temp dir /
 * test key (the TypeScript equivalent of the Python suite's `monkeypatch`).
 */

export interface Config {
  baseUrl: string;
  secretKey: string;
  googleClientId: string;
  googleClientSecret: string;
  allowedDomain: string;
  /** Session lifetime in seconds (7 days). */
  sessionMaxAge: number;
  /** Maximum decoded size accepted by the MCP upload tool (200MB). */
  maxMcpUploadSize: number;
  /** Directory where uploaded files and metadata sidecars live. */
  dataDir: string;
  port: number;
  httpHost: string;
  /** Valid X-API-Key values (comma separated in TMPUP_API_KEYS). */
  apiKeys: Set<string>;
  /** File listing page size. */
  pageSize: number;
  /** Expired-file cleanup interval in milliseconds. */
  cleanupIntervalMs: number;
}

function parseApiKeys(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0),
  );
}

export const config: Config = {
  baseUrl: process.env.BASE_URL ?? "https://tmpup.douravita.com.br",
  secretKey: process.env.SECRET_KEY ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  allowedDomain: "douravita.com.br",
  sessionMaxAge: 86400 * 7,
  maxMcpUploadSize: 200 * 1024 * 1024,
  dataDir: process.env.DATA_DIR ?? "/data",
  port: Number.parseInt(process.env.PORT ?? "8844", 10),
  httpHost: process.env.HOST ?? "0.0.0.0",
  apiKeys: parseApiKeys(process.env.TMPUP_API_KEYS),
  pageSize: 50,
  cleanupIntervalMs: 60_000,
};

/** Slug returned for callers authenticated with a valid API key. */
export const API_KEY_CLIENT = "api-key-client";
