/**
 * Auth routes (app.py 1153-1222) with two hardening additions over the Python
 * original (both documented in docs/PORT-SPEC.md):
 *
 *  - the OAuth *state* nonce (login-CSRF protection): /auth/google sets a
 *    short-lived HttpOnly cookie and Google echoes it back on the callback;
 *  - `email_verified` from Google's userinfo is required, not just the domain
 *    suffix.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { createSession, verifySession } from "../auth.js";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { LOGIN_HTML } from "../templates/index.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Node's fetch has no default timeout (httpx did), so bound the Google calls. */
const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;
const GOOGLE_AUTH_FAILED = "Falha na autenticacao Google";
const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_STATE_MAX_AGE = 600;

/** Callback URL shared by the authorization request and the token exchange. */
export function callbackUrl(): string {
  return `${config.baseUrl}/auth/callback`;
}

/** True when the deployment is served over HTTPS (controls the Secure flag). */
function usesHttps(): boolean {
  return config.baseUrl.startsWith("https://");
}

export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: callbackUrl(),
    response_type: "code",
    scope: "openid email",
    prompt: "select_account",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Constant-time equality for the state nonce. */
export function statesMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** fetch with a bounded timeout; transport failures become a 502. */
async function fetchGoogle(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, "Falha na comunicacao com o Google");
  }
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/login", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(LOGIN_HTML);
  });

  app.get("/auth/google", async (_request, reply) => {
    const state = randomUUID();
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      path: "/auth",
      maxAge: OAUTH_STATE_MAX_AGE,
      httpOnly: true,
      secure: usesHttps(),
      sameSite: "lax",
    });
    return reply.redirect(googleAuthUrl(state), 302);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/auth/callback",
    async (request, reply) => {
      const code = request.query.code ?? "";
      const state = request.query.state ?? "";
      if (!code) {
        throw new HttpError(400, "Codigo OAuth ausente");
      }

      const expectedState = request.cookies?.[OAUTH_STATE_COOKIE] ?? "";
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/auth" });
      if (!expectedState || !statesMatch(state, expectedState)) {
        throw new HttpError(403, "Estado OAuth invalido");
      }

      const tokenResponse = await fetchGoogle(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: callbackUrl(),
          grant_type: "authorization_code",
        }).toString(),
      });
      // An error page (proxy/HTML) must not surface as a JSON parse crash.
      const tokenData = tokenResponse.ok
        ? ((await tokenResponse.json().catch(() => ({}))) as { access_token?: string })
        : {};

      if (!tokenData.access_token) {
        throw new HttpError(401, GOOGLE_AUTH_FAILED);
      }

      const userinfoResponse = await fetchGoogle(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userinfoResponse.ok) {
        throw new HttpError(401, GOOGLE_AUTH_FAILED);
      }
      const userinfo = (await userinfoResponse.json().catch(() => ({}))) as {
        email?: string;
        email_verified?: boolean;
      };

      if (userinfo.email_verified !== true) {
        throw new HttpError(403, "Email Google nao verificado");
      }

      const email = userinfo.email ?? "";
      if (!email.endsWith(`@${config.allowedDomain}`)) {
        throw new HttpError(403, `Acesso restrito a @${config.allowedDomain}`);
      }

      reply.setCookie("session", createSession(email), {
        path: "/",
        maxAge: config.sessionMaxAge,
        httpOnly: true,
        secure: usesHttps(),
        sameSite: "lax",
      });
      return reply.redirect("/", 302);
    },
  );

  app.get("/auth/logout", async (_request, reply) => {
    reply.clearCookie("session", { path: "/" });
    return reply.redirect("/auth/login", 302);
  });

  app.get("/api/me", async (request) => {
    const token = request.cookies?.session;
    return { email: verifySession(token) };
  });
}
