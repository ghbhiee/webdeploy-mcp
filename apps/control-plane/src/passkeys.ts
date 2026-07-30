import type { FastifyInstance } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  AppError,
  createMcpInstallCatalog,
  randomToken,
  withTransaction,
  writeAudit,
  type Config,
  type Database,
} from "@webdeploy/core";
import { createSession, clearSessionCookie, readSession, setSessionCookie } from "./session.js";

interface AuthDependencies {
  database: Database;
  config: Config;
}

export async function registerPasskeyRoutes(
  app: FastifyInstance,
  { database, config }: AuthDependencies,
): Promise<void> {
  const rpID = new URL(config.PUBLIC_URL).hostname;
  const expectedOrigin = new URL(config.PUBLIC_URL).origin;

  app.post(
    "/api/auth/register/options",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const body = request.body as { email?: string };
      const email = body.email?.trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw new AppError("INVALID_EMAIL", "Enter a valid email address");
      }
      let user = (await database.query("SELECT * FROM users WHERE lower(email)=lower($1)", [email]))
        .rows[0];
      if (!user) {
        user = (
          await database.query(
            `INSERT INTO users(username,email,webauthn_user_id)
             VALUES($1,$2,$3) RETURNING *`,
            [email, email, Buffer.from(randomToken(32), "base64url")],
          )
        ).rows[0];
      }
      const credentials = await database.query(
        "SELECT credential_id,transports FROM passkeys WHERE user_id=$1 AND status!='revoked'",
        [user.id],
      );
      const options = await generateRegistrationOptions({
        rpName: "WebDeploy MCP",
        rpID,
        userName: user.username,
        userDisplayName: user.username,
        userID: new Uint8Array(user.webauthn_user_id),
        attestationType: "none",
        timeout: 60_000,
        excludeCredentials: credentials.rows.map((row) => ({
          id: row.credential_id,
          transports: row.transports,
        })),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      });
      const challenge = await database.query(
        `INSERT INTO auth_challenges(user_id,kind,challenge,expires_at)
         VALUES($1,'registration',$2,now()+interval '10 minutes') RETURNING id`,
        [user.id, options.challenge],
      );
      return { challengeId: challenge.rows[0].id, options };
    },
  );

  app.post(
    "/api/auth/register/verify",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const body = request.body as { challengeId?: string; response?: any; name?: string };
      const challenge = (
        await database.query(
          `UPDATE auth_challenges SET consumed_at=now()
           WHERE id=$1 AND kind='registration' AND consumed_at IS NULL AND expires_at>now()
           RETURNING *`,
          [body.challengeId],
        )
      ).rows[0];
      if (!challenge)
        throw new AppError("CHALLENGE_INVALID", "Registration challenge expired", 400);
      const verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        throw new AppError("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed", 400);
      }
      const info = verification.registrationInfo;
      const requestCode = `WDP-${randomToken(9).toUpperCase()}`;
      const result = await withTransaction(database, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('webdeploy-first-admin'))");
        const passkeyCount = await client.query("SELECT count(*)::int AS count FROM passkeys");
        const firstAdministrator = passkeyCount.rows[0].count === 0;
        const enrollment = await client.query(
          `INSERT INTO passkey_enrollment_requests
           (user_id,request_code,requested_ip,requested_user_agent,expires_at,status,reviewed_at)
           VALUES($1,$2,$3,$4,now()+interval '7 days',$5::passkey_status,
             CASE WHEN $5::passkey_status='active'::passkey_status THEN now() ELSE NULL END)
           RETURNING id`,
          [
            challenge.user_id,
            requestCode,
            request.ip,
            request.headers["user-agent"] ?? null,
            firstAdministrator ? "active" : "pending",
          ],
        );
        await client.query(
          `INSERT INTO passkeys
            (user_id,enrollment_request_id,credential_id,public_key,counter,transports,
             device_type,backed_up,status,name)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            challenge.user_id,
            enrollment.rows[0].id,
            info.credential.id,
            Buffer.from(info.credential.publicKey),
            info.credential.counter,
            info.credential.transports ?? [],
            info.credentialDeviceType,
            info.credentialBackedUp,
            firstAdministrator ? "active" : "pending",
            body.name?.trim() || null,
          ],
        );
        if (firstAdministrator) {
          await client.query(
            `UPDATE users SET status='active',is_admin=true,approved_at=now(),updated_at=now()
             WHERE id=$1`,
            [challenge.user_id],
          );
        }
        return { enrollmentId: enrollment.rows[0].id, firstAdministrator };
      });
      await writeAudit(database, {
        actorUserId: challenge.user_id,
        action: result.firstAdministrator
          ? "passkey.enrollment.bootstrap_approved"
          : "passkey.enrollment.requested",
        targetType: "passkey_enrollment",
        targetId: result.enrollmentId,
        metadata: { requestCode, firstAdministrator: result.firstAdministrator },
        ip: request.ip,
      });
      if (result.firstAdministrator) {
        return { status: "active", firstAdministrator: true };
      }
      return {
        status: "pending",
        requestCode,
        approvalCommand: `webdeploy auth approve-passkey ${requestCode}`,
      };
    },
  );

  app.post(
    "/api/auth/login/options",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request) => {
      const body = request.body as { email?: string; identifier?: string };
      const email = (body.email ?? body.identifier)?.trim().toLowerCase();
      if (!email) throw new AppError("EMAIL_REQUIRED", "Email is required");
      const user = (
        await database.query(
          `SELECT * FROM users
           WHERE lower(email)=lower($1) AND status='active'`,
          [email],
        )
      ).rows[0];
      if (!user) throw new AppError("LOGIN_FAILED", "No active account matches that email", 401);
      const passkeys = await database.query(
        "SELECT credential_id,transports FROM passkeys WHERE user_id=$1 AND status='active'",
        [user.id],
      );
      if (!passkeys.rowCount)
        throw new AppError("LOGIN_FAILED", "No active passkey is available", 401);
      const options = await generateAuthenticationOptions({
        rpID,
        timeout: 60_000,
        userVerification: "required",
        allowCredentials: passkeys.rows.map((row) => ({
          id: row.credential_id,
          transports: row.transports,
        })),
      });
      const challenge = await database.query(
        `INSERT INTO auth_challenges(user_id,kind,challenge,expires_at)
         VALUES($1,'authentication',$2,now()+interval '10 minutes') RETURNING id`,
        [user.id, options.challenge],
      );
      return { challengeId: challenge.rows[0].id, options };
    },
  );

  app.post(
    "/api/auth/login/verify",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = request.body as { challengeId?: string; response?: any };
      const challenge = (
        await database.query(
          `UPDATE auth_challenges SET consumed_at=now()
           WHERE id=$1 AND kind='authentication' AND consumed_at IS NULL AND expires_at>now()
           RETURNING *`,
          [body.challengeId],
        )
      ).rows[0];
      if (!challenge)
        throw new AppError("CHALLENGE_INVALID", "Authentication challenge expired", 400);
      const passkey = (
        await database.query(
          `SELECT * FROM passkeys
           WHERE user_id=$1 AND credential_id=$2 AND status='active'`,
          [challenge.user_id, body.response?.id],
        )
      ).rows[0];
      if (!passkey) throw new AppError("LOGIN_FAILED", "Passkey is not active", 401);
      const verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credential_id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: Number(passkey.counter),
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
      if (!verification.verified)
        throw new AppError("LOGIN_FAILED", "Passkey verification failed", 401);
      await database.query("UPDATE passkeys SET counter=$2,last_used_at=now() WHERE id=$1", [
        passkey.id,
        verification.authenticationInfo.newCounter,
      ]);
      const sessionInput: {
        userId: string;
        passkeyId: string;
        ip?: string;
        userAgent?: string;
      } = {
        userId: challenge.user_id,
        passkeyId: passkey.id,
        ip: request.ip,
      };
      if (request.headers["user-agent"]) sessionInput.userAgent = request.headers["user-agent"];
      const session = await createSession(database, config, sessionInput);
      setSessionCookie(reply, config, session.token, session.expiresAt);
      await writeAudit(database, {
        actorUserId: challenge.user_id,
        action: "session.created",
        targetType: "session",
        ip: request.ip,
      });
      return { authenticated: true, csrfToken: session.csrfToken };
    },
  );

  app.get("/api/auth/session", async (request) => {
    const session = await readSession(request, database, config);
    const mcpInstall = createMcpInstallCatalog(config.MCP_PUBLIC_URL, config.MCP_SERVER_NAME);
    return session
      ? {
          authenticated: true,
          user: session.actor,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
          mcpUrl: mcpInstall.mcpUrl,
          mcpInstall,
        }
      : { authenticated: false, mcpUrl: mcpInstall.mcpUrl, mcpInstall };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = await readSession(request, database, config);
    if (session) {
      await database.query("UPDATE web_sessions SET revoked_at=now() WHERE id=$1", [session.id]);
    }
    clearSessionCookie(reply, config);
    return { ok: true };
  });
}
