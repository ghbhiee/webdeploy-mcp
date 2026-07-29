import type { Database } from "@webdeploy/core";

export function createOidcAdapter(database: Database): any {
  return class PostgreSqlAdapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: Record<string, any>, expiresIn: number): Promise<void> {
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
      await database.query(
        `INSERT INTO oauth_objects(model,id,payload,grant_id,user_code,uid,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(model,id) DO UPDATE SET
           payload=excluded.payload,grant_id=excluded.grant_id,user_code=excluded.user_code,
           uid=excluded.uid,expires_at=excluded.expires_at,consumed_at=NULL`,
        [
          this.model,
          id,
          JSON.stringify(payload),
          payload.grantId ?? null,
          payload.userCode ?? null,
          payload.uid ?? null,
          expiresAt,
        ],
      );
    }

    async find(id: string): Promise<Record<string, any> | undefined> {
      const result = await database.query(
        `SELECT payload,consumed_at FROM oauth_objects
         WHERE model=$1 AND id=$2 AND (expires_at IS NULL OR expires_at>now())`,
        [this.model, id],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return row.consumed_at ? { ...row.payload, consumed: true } : row.payload;
    }

    async findByUserCode(userCode: string): Promise<Record<string, any> | undefined> {
      return this.findBy("user_code", userCode);
    }

    async findByUid(uid: string): Promise<Record<string, any> | undefined> {
      return this.findBy("uid", uid);
    }

    private async findBy(column: "user_code" | "uid", value: string): Promise<any> {
      const result = await database.query(
        `SELECT payload,consumed_at FROM oauth_objects
         WHERE model=$1 AND ${column}=$2 AND (expires_at IS NULL OR expires_at>now())`,
        [this.model, value],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return row.consumed_at ? { ...row.payload, consumed: true } : row.payload;
    }

    async destroy(id: string): Promise<void> {
      await database.query("DELETE FROM oauth_objects WHERE model=$1 AND id=$2", [this.model, id]);
    }

    async consume(id: string): Promise<void> {
      await database.query("UPDATE oauth_objects SET consumed_at=now() WHERE model=$1 AND id=$2", [
        this.model,
        id,
      ]);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await database.query("DELETE FROM oauth_objects WHERE grant_id=$1", [grantId]);
    }
  };
}
