/**
 * Auth layer tests (port of the auth behaviour exercised by test_app.py plus
 * the session/API-key contracts defined in app.py lines 33-124).
 *
 * test_app.py has no dedicated unit tests for create_session/verify_session
 * (its fixtures just fake `API_KEYS` and use `TestClient`); the middleware
 * assertions below mirror test_app.py::test_mcp_auth_protection and
 * test_app.py::test_mcp_setup_unauthenticated.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authHook,
  createSession,
  isPublicPath,
  PUBLIC_PATHS,
  TimedSerializer,
  verifyApiKey,
  verifySession,
} from "../src/auth.js";
import { API_KEY_CLIENT, config } from "../src/config.js";
import { restoreConfig, useApiKeys } from "./helpers.js";

/** Real token produced by itsdangerous 2.2.0 with secret 'test-secret-key'. */
const PYTHON_TOKEN =
  "InVzZXJAZG91cmF2aXRhLmNvbS5iciI.aqVi6g.YGJj3u11KnpKq9cn-uM7GtKlh0U";
/** Unix seconds embedded in PYTHON_TOKEN (2026-09-12T14:34:18Z). */
const PYTHON_TOKEN_TIMESTAMP = 1789223658;
const TEST_SECRET = "test-secret-key";
const TEST_EMAIL = "user@douravita.com.br";

const ORIGINAL_SECRET_KEY = config.secretKey;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

beforeEach(() => {
  config.secretKey = TEST_SECRET;
});

afterEach(() => {
  restoreConfig();
  config.secretKey = ORIGINAL_SECRET_KEY;
});

describe("TimedSerializer / sessions", () => {
  it("round-trips a session created with createSession", () => {
    const token = createSession(TEST_EMAIL);
    expect(verifySession(token)).toBe(TEST_EMAIL);
  });

  it("round-trips through the TimedSerializer class", () => {
    const serializer = new TimedSerializer(TEST_SECRET);
    const token = serializer.dumps(TEST_EMAIL);
    expect(serializer.loads(token)).toBe(TEST_EMAIL);
  });

  it("reproduces a real itsdangerous 2.2.0 token byte for byte", () => {
    // Clock pinned to the fixture token's timestamp makes `dumps` fully
    // deterministic, proving the wire format (compact JSON payload, uint32
    // timestamp, HMAC-SHA1, django-concat key derivation) matches Python.
    const serializer = new TimedSerializer(TEST_SECRET, {
      now: () => PYTHON_TOKEN_TIMESTAMP,
    });
    expect(serializer.dumps(TEST_EMAIL)).toBe(PYTHON_TOKEN);
  });

  it("verifies a real itsdangerous 2.2.0 token", () => {
    // The clock is pinned to the fixture's own timestamp so this assertion
    // never depends on (or expires with) the wall clock.
    const serializer = new TimedSerializer(TEST_SECRET, {
      now: () => PYTHON_TOKEN_TIMESTAMP,
    });
    expect(serializer.loads(PYTHON_TOKEN, 604800)).toBe(TEST_EMAIL);
  });

  it("verifies a real itsdangerous 2.2.0 token through verifySession", () => {
    // verifySession deliberately uses the real clock, so a huge maxAge keeps
    // the Python-produced fixture valid regardless of when the suite runs.
    expect(
      verifySession(PYTHON_TOKEN, { maxAge: Number.MAX_SAFE_INTEGER, secretKey: TEST_SECRET }),
    ).toBe(TEST_EMAIL);
  });

  it("exposes the python token format: payload.timestamp.signature", () => {
    const token = createSession(TEST_EMAIL);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).not.toContain("=");
    expect(parts[1]).not.toContain("=");
    expect(parts[2]).not.toContain("=");
    expect(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"))).toBe(TEST_EMAIL);
  });

  it("rejects a tampered signature", () => {
    const token = createSession(TEST_EMAIL);
    const [payload, timestamp, signature] = token.split(".");
    // Flip the first signature character: unlike the trailing base64url
    // character, it always changes the decoded MAC bytes.
    const flipped = (signature!.startsWith("A") ? "B" : "A") + signature!.slice(1);
    expect(verifySession(`${payload}.${timestamp}.${flipped}`)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = createSession(TEST_EMAIL);
    const [, timestamp, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify("attacker@evil.com"), "utf8").toString("base64url");
    expect(verifySession(`${forged}.${timestamp}.${signature}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = createSession(TEST_EMAIL, "other-secret");
    expect(verifySession(token)).toBeNull();
  });

  it("rejects an expired token crafted with our own signer", () => {
    const expired = new TimedSerializer(TEST_SECRET, {
      now: () => nowSeconds() - 604801,
    }).dumps(TEST_EMAIL);
    expect(verifySession(expired, 604800)).toBeNull();
  });

  it("rejects a token signed in the future (age < 0)", () => {
    const future = new TimedSerializer(TEST_SECRET, {
      now: () => nowSeconds() + 3600,
    }).dumps(TEST_EMAIL);
    expect(verifySession(future, 604800)).toBeNull();
  });

  it("accepts a token inside the configured max age", () => {
    const token = new TimedSerializer(TEST_SECRET, {
      now: () => nowSeconds() - 60,
    }).dumps(TEST_EMAIL);
    expect(verifySession(token, 604800)).toBe(TEST_EMAIL);
  });

  it("defaults maxAge to config.sessionMaxAge", () => {
    expect(config.sessionMaxAge).toBe(604800);
    const inside = new TimedSerializer(TEST_SECRET, {
      now: () => nowSeconds() - config.sessionMaxAge + 60,
    }).dumps(TEST_EMAIL);
    const outside = new TimedSerializer(TEST_SECRET, {
      now: () => nowSeconds() - config.sessionMaxAge - 60,
    }).dumps(TEST_EMAIL);
    expect(verifySession(inside)).toBe(TEST_EMAIL);
    expect(verifySession(outside)).toBeNull();
  });

  it("rejects a missing token", () => {
    expect(verifySession(undefined)).toBeNull();
    expect(verifySession("")).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifySession("not-a-token")).toBeNull();
    expect(verifySession("a.b.c")).toBeNull();
    expect(verifySession("....")).toBeNull();
  });
});

describe("verifyApiKey", () => {
  it("returns null when no API keys are configured", () => {
    useApiKeys();
    expect(verifyApiKey({ "x-api-key": "anything" })).toBeNull();
  });

  it("returns null when the header is missing or empty", () => {
    useApiKeys("test-key");
    expect(verifyApiKey({})).toBeNull();
    expect(verifyApiKey({ "x-api-key": "" })).toBeNull();
  });

  it("returns null for a non-matching key", () => {
    useApiKeys("test-key");
    expect(verifyApiKey({ "x-api-key": "wrong-key" })).toBeNull();
    // Same length as 'test-key' but different bytes (constant-time path).
    expect(verifyApiKey({ "x-api-key": "test-keyx" })).toBeNull();
  });

  it("returns API_KEY_CLIENT for a matching key", () => {
    useApiKeys("test-key");
    expect(verifyApiKey({ "x-api-key": "test-key" })).toBe(API_KEY_CLIENT);
    expect(API_KEY_CLIENT).toBe("api-key-client");
  });

  it("reads the header case-insensitively", () => {
    useApiKeys("test-key");
    expect(verifyApiKey({ "X-API-Key": "test-key" })).toBe(API_KEY_CLIENT);
    expect(verifyApiKey({ "X-Api-Key": "test-key" })).toBe(API_KEY_CLIENT);
  });

  it("accepts any key of a configured set", () => {
    useApiKeys("first-key", "test-key", "third-key");
    expect(verifyApiKey({ "x-api-key": "third-key" })).toBe(API_KEY_CLIENT);
  });

  it("handles duplicate (array) header values like Starlette's first value", () => {
    useApiKeys("test-key");
    expect(verifyApiKey({ "x-api-key": ["test-key", "other"] })).toBe(API_KEY_CLIENT);
  });
});

describe("isPublicPath", () => {
  it("declares exactly the python PUBLIC_PATHS", () => {
    expect(PUBLIC_PATHS).toEqual([
      "/health",
      "/auth/login",
      "/auth/google",
      "/auth/callback",
      "/auth/logout",
    ]);
  });

  it("accepts every public path", () => {
    for (const path of PUBLIC_PATHS) {
      expect(isPublicPath(path)).toBe(true);
    }
  });

  it("accepts the /d/, /v/ and /t/ prefixes", () => {
    expect(isPublicPath("/d/abc/file.txt")).toBe(true);
    expect(isPublicPath("/v/abc/file.png")).toBe(true);
    expect(isPublicPath("/t/abc/file.png")).toBe(true);
    expect(isPublicPath("/d/")).toBe(true);
  });

  it("rejects protected paths and bare prefixes", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api/files")).toBe(false);
    expect(isPublicPath("/api/upload")).toBe(false);
    expect(isPublicPath("/mcp")).toBe(false);
    expect(isPublicPath("/mcp-setup")).toBe(false);
    expect(isPublicPath("/admin/set-all-infinite")).toBe(false);
    expect(isPublicPath("/d")).toBe(false);
    expect(isPublicPath("/v")).toBe(false);
    expect(isPublicPath("/t")).toBe(false);
    expect(isPublicPath("/healthz")).toBe(false);
  });
});

describe("authHook middleware", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(cookie);
    app.addHook("onRequest", authHook);
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/api/protected", async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lets public routes through without credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const withQuery = await app.inject({ method: "GET", url: "/health?verbose=1" });
    expect(withQuery.statusCode).toBe(200);
  });

  it("returns the exact 401 JSON body for API clients without credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/api/protected" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthorized",
      detail: "Provide session cookie or X-API-Key header",
    });
  });

  it("redirects browsers to /auth/login", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/auth/login");
  });

  it("accepts a valid session cookie", async () => {
    const token = createSession(TEST_EMAIL);
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { cookie: `session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects an invalid session cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { cookie: "session=garbage.value.here" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid X-API-Key", async () => {
    useApiKeys("valid-mcp-key");
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { "x-api-key": "valid-mcp-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects an invalid X-API-Key", async () => {
    useApiKeys("valid-mcp-key");
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { "x-api-key": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });
});
