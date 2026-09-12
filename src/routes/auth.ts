/** Auth routes (app.py 1153-1222). */
import type { FastifyInstance } from "fastify";

import { createSession, verifySession } from "../auth.js";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { LOGIN_HTML } from "../templates/index.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export function googleAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: `${config.baseUrl}/auth/callback`,
    response_type: "code",
    scope: "openid email",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/login", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(LOGIN_HTML);
  });

  app.get("/auth/google", async (_request, reply) => {
    return reply.redirect(googleAuthUrl(), 302);
  });

  app.get<{ Querystring: { code?: string } }>("/auth/callback", async (request, reply) => {
    const code = request.query.code ?? "";
    if (!code) {
      throw new HttpError(400, "Codigo OAuth ausente");
    }

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: `${config.baseUrl}/auth/callback`,
        grant_type: "authorization_code",
      }).toString(),
    });
    const tokenData = (await tokenResponse.json()) as { access_token?: string };

    if (!tokenData.access_token) {
      throw new HttpError(401, "Falha na autenticacao Google");
    }

    const userinfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userinfo = (await userinfoResponse.json()) as { email?: string };

    const email = userinfo.email ?? "";
    if (!email.endsWith(`@${config.allowedDomain}`)) {
      throw new HttpError(403, `Acesso restrito a @${config.allowedDomain}`);
    }

    reply.setCookie("session", createSession(email), {
      path: "/",
      maxAge: config.sessionMaxAge,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
    return reply.redirect("/", 302);
  });

  app.get("/auth/logout", async (_request, reply) => {
    reply.clearCookie("session", { path: "/" });
    return reply.redirect("/auth/login", 302);
  });

  app.get("/api/me", async (request) => {
    const token = request.cookies?.session;
    return { email: verifySession(token) };
  });
}
