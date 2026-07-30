import type { FastifyInstance } from "fastify";
import { AppError, requireAdmin, writeAudit, type Config, type Database } from "@webdeploy/core";
import { requireSession } from "./session.js";

export function registerAdminRoutes(
  app: FastifyInstance,
  database: Database,
  config: Config,
): void {
  const admin = async (request: any, csrf = false) => {
    const session = await requireSession(request, database, config, csrf);
    requireAdmin(session.actor);
    return session;
  };

  app.get("/api/admin/users", async (request) => {
    await admin(request);
    const users = await database.query(
      `SELECT id,username,email,status,is_admin,created_at,approved_at,disabled_at
       FROM users ORDER BY created_at DESC`,
    );
    return { users: users.rows };
  });
  app.get("/api/admin/passkeys/pending", async (request) => {
    await admin(request);
    const pending = await database.query(
      `SELECT r.id,r.request_code,r.created_at,r.expires_at,u.id AS user_id,u.email,
              u.status AS user_status,p.name AS passkey_name
       FROM passkey_enrollment_requests r
       JOIN users u ON u.id=r.user_id
       LEFT JOIN passkeys p ON p.enrollment_request_id=r.id
       WHERE r.status='pending' AND r.expires_at>now() ORDER BY r.created_at`,
    );
    return { pending: pending.rows };
  });
  app.post("/api/admin/passkeys/:requestCode/approve", async (request) => {
    const session = await admin(request, true);
    const requestCode = (request.params as any).requestCode;
    const enrollment = (
      await database.query(
        `UPDATE passkey_enrollment_requests
         SET status='active',reviewed_by=$2,reviewed_at=now()
         WHERE request_code=$1 AND status='pending' AND expires_at>now()
         RETURNING id,user_id`,
        [requestCode, session.actor.id],
      )
    ).rows[0];
    if (!enrollment) throw new AppError("REQUEST_NOT_FOUND", "Pending request not found", 404);
    await database.query("UPDATE passkeys SET status='active' WHERE enrollment_request_id=$1", [
      enrollment.id,
    ]);
    await database.query(
      `UPDATE users SET status='active',approved_at=now(),approved_by=$2,updated_at=now()
       WHERE id=$1`,
      [enrollment.user_id, session.actor.id],
    );
    await writeAudit(database, {
      actorUserId: session.actor.id,
      action: "passkey.enrollment.approved",
      targetType: "passkey_enrollment",
      targetId: enrollment.id,
    });
    return { ok: true };
  });
  app.post("/api/admin/passkeys/:requestCode/reject", async (request) => {
    const session = await admin(request, true);
    const requestCode = (request.params as any).requestCode;
    const enrollment = (
      await database.query(
        `UPDATE passkey_enrollment_requests
         SET status='rejected',reviewed_by=$2,reviewed_at=now()
         WHERE request_code=$1 AND status='pending' AND expires_at>now()
         RETURNING id,user_id`,
        [requestCode, session.actor.id],
      )
    ).rows[0];
    if (!enrollment) throw new AppError("REQUEST_NOT_FOUND", "Pending request not found", 404);
    await database.query("UPDATE passkeys SET status='rejected' WHERE enrollment_request_id=$1", [
      enrollment.id,
    ]);
    await writeAudit(database, {
      actorUserId: session.actor.id,
      action: "passkey.enrollment.rejected",
      targetType: "passkey_enrollment",
      targetId: enrollment.id,
    });
    return { ok: true };
  });
  app.post("/api/admin/users/:userId/disable", async (request) => {
    const session = await admin(request, true);
    const userId = (request.params as any).userId;
    if (userId === session.actor.id)
      throw new AppError("SELF_DISABLE_DENIED", "Cannot disable yourself");
    await database.query(
      "UPDATE users SET status='disabled',disabled_at=now(),updated_at=now() WHERE id=$1",
      [userId],
    );
    await revokeUserSecurityState(database, userId);
    await writeAudit(database, {
      actorUserId: session.actor.id,
      action: "user.disabled",
      targetType: "user",
      targetId: userId,
    });
    return { ok: true };
  });
  app.post("/api/admin/users/:userId/admin", async (request) => {
    const session = await admin(request, true);
    const userId = (request.params as any).userId;
    const body = request.body as { enabled: boolean };
    if (userId === session.actor.id && !body.enabled) {
      throw new AppError("SELF_ADMIN_REMOVAL_DENIED", "Cannot remove your own administrator role");
    }
    await database.query("UPDATE users SET is_admin=$2,updated_at=now() WHERE id=$1", [
      userId,
      body.enabled,
    ]);
    await writeAudit(database, {
      actorUserId: session.actor.id,
      action: body.enabled ? "user.admin.granted" : "user.admin.removed",
      targetType: "user",
      targetId: userId,
    });
    return { ok: true };
  });
  app.get("/api/admin/users/:userId/passkeys", async (request) => {
    await admin(request);
    const result = await database.query(
      `SELECT id,name,status,device_type,backed_up,last_used_at,created_at,revoked_at
       FROM passkeys WHERE user_id=$1 ORDER BY created_at DESC`,
      [(request.params as any).userId],
    );
    return { passkeys: result.rows };
  });
  app.post("/api/admin/passkeys/:passkeyId/revoke", async (request) => {
    const session = await admin(request, true);
    const passkeyId = (request.params as any).passkeyId;
    const passkey = (
      await database.query(
        `UPDATE passkeys SET status='revoked',revoked_at=now()
         WHERE id=$1 AND status!='revoked' RETURNING user_id`,
        [passkeyId],
      )
    ).rows[0];
    if (!passkey) throw new AppError("PASSKEY_NOT_FOUND", "Passkey not found", 404);
    await database.query(
      "UPDATE web_sessions SET revoked_at=now() WHERE passkey_id=$1 AND revoked_at IS NULL",
      [passkeyId],
    );
    await database.query("DELETE FROM oauth_objects WHERE payload->>'accountId'=$1", [
      passkey.user_id,
    ]);
    await writeAudit(database, {
      actorUserId: session.actor.id,
      action: "passkey.revoked",
      targetType: "passkey",
      targetId: passkeyId,
    });
    return { ok: true };
  });
}

export async function revokeUserSecurityState(database: Database, userId: string): Promise<void> {
  await database.query(
    "UPDATE web_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
    [userId],
  );
  await database.query("DELETE FROM oauth_objects WHERE payload->>'accountId'=$1", [userId]);
}
