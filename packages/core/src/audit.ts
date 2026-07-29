import type { Database } from "./db.js";
import { redactObject } from "./redaction.js";

export async function writeAudit(
  database: Database,
  event: {
    actorUserId?: string | null;
    actorSystemUid?: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO audit_events
      (actor_user_id, actor_system_uid, action, target_type, target_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.actorUserId ?? null,
      event.actorSystemUid ?? null,
      event.action,
      event.targetType,
      event.targetId ?? null,
      JSON.stringify(redactObject(event.metadata ?? {})),
      event.ip ?? null,
    ],
  );
}
