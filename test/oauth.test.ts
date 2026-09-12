/**
 * The Python suite never exercised /auth/callback (Google is unreachable from
 * tests). These tests mock global fetch and cover the whole flow, including the
 * two hardening additions: the OAuth state nonce and the email_verified check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { callbackUrl, googleAuthUrl, statesMatch } from "../src/routes/auth.js";
import { makeDataDir, removeDataDir, restoreConfig, useApiKeys } from "./helpers.js";
import { buildTestServer } from "./helpers.js";

const ORIGINAL_BASE_URL = config.baseUrl;

let dataDir = "";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Mock Google: token endpoint + userinfo, with optional failure modes. */
function stubGoogle(userinfo: unknown, options: { tokenStatus?: number; reject?: boolean } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    if (options.reject) {
      throw new TypeError("fetch failed");
    }
    if (String(url).includes("/token")) {
      const status = options.tokenStatus ?? 200;
      return status === 200
        ? jsonResponse({ access_token: "token-123" })
        : new Response("<html>error</html>", { status, headers: { "content-type": "text/html" } });
    }
    return jsonResponse(userinfo);
  });
}

function stateCookie(response: { cookies: { name: string; value: string }[] }): string {
  const cookie = response.cookies.find((c) => c.name === "oauth_state");
  return cookie?.value ?? "";
}

function sessionCookie(response: { cookies: { name: string; value: string }[] }): string {
  const cookie = response.cookies.find((c) => c.name === "session");
  return cookie?.value ?? "";
}

beforeEach(async () => {
  dataDir = await makeDataDir();
  useApiKeys();
  config.secretKey = "test-secret";
  config.baseUrl = "https://tmpup.example.com";
});

afterEach(async () => {
  vi.unstubAllGlobals();
  restoreConfig();
  config.baseUrl = ORIGINAL_BASE_URL;
  await removeDataDir(dataDir);
  dataDir = "";
});

describe("OAuth login flow", () => {
  it("builds the authorization URL with the state nonce and the shared callback", () => {
    const url = new URL(googleAuthUrl("nonce-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("state")).toBe("nonce-1");
    expect(url.searchParams.get("redirect_uri")).toBe(callbackUrl());
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  it("sets a short-lived HttpOnly state cookie on /auth/google", async () => {
    const app = await buildTestServer();
    try {
      const res = await app.inject({ method: "GET", url: "/auth/google" });
      expect(res.statusCode).toBe(302);
      const cookie = res.cookies.find((c) => c.name === "oauth_state");
      expect(cookie?.value).toBeTruthy();
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.secure).toBe(true);
      expect(cookie?.maxAge).toBe(600);
      const location = new URL(String(res.headers.location));
      expect(location.searchParams.get("state")).toBe(cookie?.value);
    } finally {
      await app.close();
    }
  });

  it("issues a session cookie and /api/me returns the email on the happy path", async () => {
    stubGoogle({ email: "user@douravita.com.br", email_verified: true });
    const app = await buildTestServer();
    try {
      const start = await app.inject({ method: "GET", url: "/auth/google" });
      const state = stateCookie(start);

      const callback = await app.inject({
        method: "GET",
        url: `/auth/callback?code=abc&state=${state}`,
        cookies: { oauth_state: state },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe("/");
      const session = sessionCookie(callback);
      expect(session).not.toBe("");

      const me = await app.inject({ method: "GET", url: "/api/me", cookies: { session } });
      expect(me.json()).toEqual({ email: "user@douravita.com.br" });
    } finally {
      await app.close();
    }
  });

  it("rejects a callback without the state cookie", async () => {
    stubGoogle({ email: "user@douravita.com.br", email_verified: true });
    const app = await buildTestServer();
    try {
      const res = await app.inject({ method: "GET", url: "/auth/callback?code=abc&state=whatever" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ detail: "Estado OAuth invalido" });
      expect(sessionCookie(res)).toBe("");
    } finally {
      await app.close();
    }
  });

  it("rejects a state that does not match the cookie", async () => {
    stubGoogle({ email: "user@douravita.com.br", email_verified: true });
    const app = await buildTestServer();
    try {
      const start = await app.inject({ method: "GET", url: "/auth/google" });
      const state = stateCookie(start);
      const res = await app.inject({
        method: "GET",
        url: `/auth/callback?code=abc&state=${state}-tampered`,
        cookies: { oauth_state: state },
      });
      expect(res.statusCode).toBe(403);
      expect(sessionCookie(res)).toBe("");
    } finally {
      await app.close();
    }
  });

  it("rejects a Google account whose email is not verified", async () => {
    stubGoogle({ email: "user@douravita.com.br", email_verified: false });
    const app = await buildTestServer();
    try {
      const start = await app.inject({ method: "GET", url: "/auth/google" });
      const state = stateCookie(start);
      const res = await app.inject({
        method: "GET",
        url: `/auth/callback?code=abc&state=${state}`,
        cookies: { oauth_state: state },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ detail: "Email Google nao verificado" });
      expect(sessionCookie(res)).toBe("");
    } finally {
      await app.close();
    }
  });

  it("rejects an email outside the allowed domain", async () => {
    stubGoogle({ email: "user@evil.example.com", email_verified: true });
    const app = await buildTestServer();
    try {
      const start = await app.inject({ method: "GET", url: "/auth/google" });
      const state = stateCookie(start);
      const res = await app.inject({
        method: "GET",
        url: `/auth/callback?code=abc&state=${state}`,
        cookies: { oauth_state: state },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ detail: "Acesso restrito a @douravita.com.br" });
    } finally {
      await app.close();
    }
  });

  it("returns 401 when the token exchange fails and 502 when Google is unreachable", async () => {
    const app = await buildTestServer();
    try {
      const start = await app.inject({ method: "GET", url: "/auth/google" });
      const state = stateCookie(start);

      stubGoogle({ email: "user@douravita.com.br", email_verified: true }, { tokenStatus: 500 });
      const failed = await app.inject({
        method: "GET",
        url: `/auth/callback?code=abc&state=${state}`,
        cookies: { oauth_state: state },
      });
      expect(failed.statusCode).toBe(401);
      expect(failed.json()).toEqual({ detail: "Falha na autenticacao Google" });

      stubGoogle({}, { reject: true });
      const unreachable = await app.inject({
        method: "GET",
        url: `/auth/callback?code=abc&state=${state}`,
        cookies: { oauth_state: state },
      });
      expect(unreachable.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it("only marks cookies Secure when BASE_URL is https", async () => {
    stubGoogle({ email: "user@douravita.com.br", email_verified: true });
    config.baseUrl = "http://localhost:8844";
    const app = await buildTestServer();
    try {
      const start = await app.inject({ method: "GET", url: "/auth/google" });
      // LightMyRequest omits the flag entirely when it is absent.
      expect(start.cookies.find((c) => c.name === "oauth_state")?.secure ?? false).toBe(false);

      const state = stateCookie(start);
      const callback = await app.inject({
        method: "GET",
        url: `/auth/callback?code=abc&state=${state}`,
        cookies: { oauth_state: state },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.cookies.find((c) => c.name === "session")?.secure ?? false).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("compares state values in constant time and rejects different lengths", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch("", "abc")).toBe(false);
  });
});
