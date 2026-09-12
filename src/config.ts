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
  /** Maximum size accepted for the small JSON bodies parsed by the routes. */
  maxJsonBodyBytes: number;
  /** Expired-file cleanup interval in milliseconds. */
  cleanupIntervalMs: number;
}

/** Python's `int(os.environ["PORT"])` fails fast; so does this. */
function parsePort(raw: string | undefined): number {
  const text = (raw ?? "8844").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid PORT: ${JSON.stringify(raw)} is not a positive integer`);
  }
  const value = Number.parseInt(text, 10);
  if (value < 1 || value > 65535) {
    throw new Error(`Invalid PORT: ${value} is out of range (1-65535)`);
  }
  return value;
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
  allowedDomain: process.env.ALLOWED_DOMAIN ?? "douravita.com.br",
  sessionMaxAge: 86400 * 7,
  maxMcpUploadSize: 200 * 1024 * 1024,
  dataDir: process.env.DATA_DIR ?? "/data",
  port: parsePort(process.env.PORT),
  httpHost: process.env.HOST ?? "0.0.0.0",
  apiKeys: parseApiKeys(process.env.TMPUP_API_KEYS),
  pageSize: 50,
  maxJsonBodyBytes: 1024 * 1024,
  cleanupIntervalMs: 60_000,
};

/** Slug returned for callers authenticated with a valid API key. */
export const API_KEY_CLIENT = "api-key-client";

/**
 * Fail-closed check for the process entry point.
 *
 * An empty SECRET_KEY would sign every session cookie with a constant,
 * publicly known key (the salt is part of the format), so anyone could mint a
 * valid session for any address. app.py silently accepted it; this port
 * refuses to start instead of running with forgeable sessions.
 *
 * @throws {Error} when SECRET_KEY is missing or blank
 */
export function assertRuntimeConfig(): void {
  if (config.secretKey.trim() === "") {
    throw new Error(
      "SECRET_KEY is not set: session cookies would be signed with an empty key. " +
        "Set SECRET_KEY in the environment (reuse the value from the previous deployment).",
    );
  }
}
