import type { FastifyReply, FastifyRequest } from "fastify";
import type { Actor, Config, Database } from "@webdeploy/core";
import { AppError, hashToken, randomToken } from "@webdeploy/core";

export interface SessionContext {
  id: string;
  actor: Actor;
  passkeyId: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function readSession(
  request: FastifyRequest,
  database: Database,
  config: Config,
): Promise<SessionContext | null> {
  const token = request.cookies[config.SESSION_COOKIE_NAME];
  if (!token) return null;
  const result = await database.query(
    `SELECT s.id,s.passkey_id,s.csrf_token,s.expires_at,
            u.id AS user_id,u.username,u.is_admin,u.status
     FROM web_sessions s
     JOIN users u ON u.id=s.user_id
     JOIN passkeys p ON p.id=s.passkey_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
       AND u.status='active' AND p.status='active'`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    actor: {
      id: row.user_id,
      username: row.username,
      isAdmin: row.is_admin,
      status: row.status,
    },
    passkeyId: row.passkey_id,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  };
}

export async function requireSession(
  request: FastifyRequest,
  database: Database,
  config: Config,
  requireCsrf = false,
): Promise<SessionContext> {
  const session = await readSession(request, database, config);
  if (!session)
    throw new AppError("AUTHENTICATION_REQUIRED", "Passkey authentication is required", 401);
  if (requireCsrf && request.headers["x-csrf-token"] !== session.csrfToken) {
    throw new AppError("CSRF_FAILED", "CSRF token is missing or invalid", 403);
  }
  return session;
}

export async function createSession(
  database: Database,
  config: Config,
  input: { userId: string; passkeyId: string; ip?: string; userAgent?: string },
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);
  await database.query(
    `INSERT INTO web_sessions
      (user_id,passkey_id,token_hash,csrf_token,ip,user_agent,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.userId,
      input.passkeyId,
      hashToken(token),
      csrfToken,
      input.ip ?? null,
      input.userAgent ?? null,
      expiresAt,
    ],
  );
  return { token, csrfToken, expiresAt };
}

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: new URL(config.PUBLIC_URL).protocol === "https:",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
}
