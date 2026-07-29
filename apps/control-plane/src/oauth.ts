import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Provider } from "oidc-provider";
import { AppError, writeAudit, type Actor, type Config, type Database } from "@webdeploy/core";
import { createOidcAdapter } from "./oauth-adapter.js";
import { readSession } from "./session.js";

export interface OAuthRuntime {
  provider: any;
  authenticateBearer(request: FastifyRequest): Promise<{ actor: Actor; token: any }>;
}

export async function createOAuthRuntime(
  app: FastifyInstance,
  database: Database,
  config: Config,
): Promise<OAuthRuntime> {
  const jwks = loadJwks(config);
  const secureCookies = new URL(config.PUBLIC_URL).protocol === "https:";
  const provider = new Provider(config.PUBLIC_URL, {
    adapter: createOidcAdapter(database),
    jwks,
    clients: [],
    claims: { openid: ["sub"], email: ["email"], profile: ["preferred_username"] },
    cookies: {
      keys: [createHash("sha256").update(jwks.keys[0].d).digest("base64url")],
      long: { signed: true, httpOnly: true, sameSite: "lax", secure: secureCookies },
      short: { signed: true, httpOnly: true, sameSite: "lax", secure: secureCookies },
    },
    ttl: {
      AccessToken: config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      AuthorizationCode: 600,
      ClientCredentials: config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      Grant: 2_592_000,
      IdToken: 3_600,
      Interaction: 3_600,
      RefreshToken: config.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      Session: config.SESSION_TTL_SECONDS,
    },
    routes: {
      authorization: "/oauth/authorize",
      backchannelAuthentication: "/oauth/backchannel",
      codeVerification: "/oauth/device",
      deviceAuthorization: "/oauth/device/authorize",
      endSession: "/oauth/session",
      introspection: "/oauth/introspect",
      jwks: "/oauth/jwks",
      pushedAuthorizationRequest: "/oauth/request",
      registration: "/oauth/register",
      revocation: "/oauth/revoke",
      token: "/oauth/token",
      userinfo: "/oauth/userinfo",
    },
    features: {
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        allowFetch: async (_ctx: any, clientId: string) => isSafePublicHttpsUrl(clientId),
        allowClient: async (_ctx: any, client: any) =>
          Array.isArray(client.redirectUris) &&
          client.redirectUris.every((value: string) => value.startsWith("https://")),
      },
      devInteractions: { enabled: false },
      registration: {
        enabled: true,
        initialAccessToken: false,
      },
      registrationManagement: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => `${config.MCP_PUBLIC_URL}/mcp`,
        getResourceServerInfo: (_ctx: any, resource: string) => {
          if (resource !== `${config.MCP_PUBLIC_URL}/mcp`) throw new Error("invalid_target");
          return {
            scope:
              "openid profile email offline_access platform:read projects:write deployments:write",
            audience: `${config.MCP_PUBLIC_URL}/mcp`,
            accessTokenFormat: "opaque",
          };
        },
      },
      revocation: { enabled: true },
      introspection: { enabled: true },
      rpMetadataChoices: { enabled: true },
    },
    PKCE: { required: () => true },
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "platform:read",
      "projects:write",
      "deployments:write",
    ],
    interactions: {
      url: (_ctx: any, interaction: any) => `/oauth/interaction/${interaction.uid}`,
    },
    findAccount: async (_ctx: any, id: string) => {
      const user = (
        await database.query(
          "SELECT id,username,email FROM users WHERE id=$1 AND status='active'",
          [id],
        )
      ).rows[0];
      if (!user) return undefined;
      return {
        accountId: user.id,
        claims: () => ({
          sub: user.id,
          preferred_username: user.username,
          email: user.email,
          email_verified: Boolean(user.email),
        }),
      };
    },
  });

  provider.on("server_error", (error: Error) => app.log.error(error, "OAuth provider error"));

  registerProtectedResourceMetadata(app, config);
  registerInteractionRoutes(app, provider, database, config);
  registerProviderRoutes(app, provider);

  return {
    provider,
    async authenticateBearer(request) {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ")) {
        throw new AppError("OAUTH_REQUIRED", "OAuth bearer token is required", 401);
      }
      const tokenValue = authorization.slice(7);
      const token = await provider.AccessToken.find(tokenValue);
      if (!token || token.isExpired) {
        throw new AppError("TOKEN_INVALID", "Access token is invalid or expired", 401);
      }
      const user = (
        await database.query(
          "SELECT id,username,is_admin,status FROM users WHERE id=$1 AND status='active'",
          [token.accountId],
        )
      ).rows[0];
      if (!user) throw new AppError("ACCOUNT_INACTIVE", "The account is inactive", 401);
      if (token.resource && token.resource !== `${config.MCP_PUBLIC_URL}/mcp`) {
        throw new AppError(
          "TOKEN_AUDIENCE_INVALID",
          "Token is not valid for this MCP resource",
          401,
        );
      }
      return {
        actor: {
          id: user.id,
          username: user.username,
          isAdmin: user.is_admin,
          status: user.status,
        },
        token,
      };
    },
  };
}

function registerProtectedResourceMetadata(app: FastifyInstance, config: Config): void {
  const metadata = {
    resource: `${config.MCP_PUBLIC_URL}/mcp`,
    authorization_servers: [config.PUBLIC_URL],
    scopes_supported: ["platform:read", "projects:write", "deployments:write"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${config.PUBLIC_URL}/docs/mcp`,
  };
  app.get("/.well-known/oauth-protected-resource", async () => metadata);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => metadata);
}

function registerProviderRoutes(app: FastifyInstance, provider: any): void {
  const callback = provider.callback();
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    await callback(request.raw, reply.raw);
  };
  app.all("/.well-known/openid-configuration", handler);
  app.all("/.well-known/oauth-authorization-server", handler);
  app.all("/oauth/*", handler);
}

function registerInteractionRoutes(
  app: FastifyInstance,
  provider: any,
  database: Database,
  config: Config,
): void {
  app.get("/oauth/interaction/:uid", async (request, reply) => {
    const session = await readSession(request, database, config);
    const details = await provider.interactionDetails(request.raw, reply.raw);
    const uid = (request.params as any).uid;
    if (!session) {
      const returnTo = encodeURIComponent(`/oauth/interaction/${uid}`);
      return reply.redirect(`/login?returnTo=${returnTo}`);
    }
    const client = await provider.Client.find(details.params.client_id);
    const requestedScopes = String(details.params.scope ?? "")
      .split(/\s+/)
      .filter(Boolean);
    reply.type("text/html; charset=utf-8");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize WebDeploy MCP</title>
<style>body{font-family:system-ui;margin:0;background:#08111f;color:#e8eef8;display:grid;place-items:center;min-height:100vh}
main{width:min(560px,calc(100% - 32px));background:#111d30;border:1px solid #2a3c55;border-radius:18px;padding:28px}
button{padding:12px 18px;border:0;border-radius:9px;font-weight:700;cursor:pointer}.approve{background:#67e8b4;color:#062116}
.deny{background:#2c3b50;color:#fff}ul{line-height:1.8}.actions{display:flex;gap:12px}</style></head>
<body><main><p>Signed in as <strong>${escapeHtml(session.actor.username)}</strong></p>
<h1>Authorize ${escapeHtml(client?.clientName || client?.clientId || "MCP client")}</h1>
<p>This client requests:</p><ul>${requestedScopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")}</ul>
<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
<div class="actions"><button class="approve" name="decision" value="approve">Approve</button>
<button class="deny" name="decision" value="deny">Deny</button></div></form></main></body></html>`;
  });

  app.post("/oauth/interaction/:uid", async (request, reply) => {
    const session = await readSession(request, database, config);
    if (!session) return reply.redirect("/login");
    const body = request.body as { csrf?: string; decision?: string };
    if (body.csrf !== session.csrfToken)
      throw new AppError("CSRF_FAILED", "Invalid CSRF token", 403);
    const details = await provider.interactionDetails(request.raw, reply.raw);
    if (body.decision !== "approve") {
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        { error: "access_denied", error_description: "The resource owner denied the request" },
        { mergeWithLastSubmission: false },
      );
      return;
    }
    let grant = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
    if (!grant) {
      grant = new provider.Grant({
        accountId: session.actor.id,
        clientId: details.params.client_id,
      });
    }
    const scopes = String(details.params.scope ?? "")
      .split(/\s+/)
      .filter(Boolean);
    grant.addOIDCScope(scopes.join(" "));
    const resource = details.params.resource;
    if (resource) grant.addResourceScope(resource, scopes.join(" "));
    const grantId = await grant.save();
    await writeAudit(database, {
      actorUserId: session.actor.id,
      action: "oauth.consent.granted",
      targetType: "oauth_client",
      targetId: String(details.params.client_id),
      metadata: { scopes },
    });
    await provider.interactionFinished(
      request.raw,
      reply.raw,
      {
        login: {
          accountId: session.actor.id,
          acr: "urn:webauthn:passkey",
          amr: ["webauthn", "mfa"],
          remember: false,
        },
        consent: { grantId },
      },
      { mergeWithLastSubmission: true },
    );
  });
}

function loadJwks(config: Config): any {
  if (existsSync(config.OIDC_JWKS_FILE)) {
    const parsed = JSON.parse(readFileSync(config.OIDC_JWKS_FILE, "utf8"));
    if (!Array.isArray(parsed.keys) || !parsed.keys[0]?.d)
      throw new Error("OIDC JWKS lacks a private key");
    return parsed;
  }
  if (config.NODE_ENV === "production") {
    throw new Error(`OIDC_JWKS_FILE does not exist: ${config.OIDC_JWKS_FILE}`);
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  const keys = { keys: [{ ...jwk, kid: randomUUID(), use: "sig", alg: "RS256" }] };
  mkdirSync(dirname(config.OIDC_JWKS_FILE), { recursive: true });
  writeFileSync(config.OIDC_JWKS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function isSafePublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    return !(
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
