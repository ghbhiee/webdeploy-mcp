import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const identity = process.env.BOOTSTRAP_ADMIN_IDENTITY;
if (!databaseUrl || !identity)
  throw new Error("DATABASE_URL and BOOTSTRAP_ADMIN_IDENTITY are required");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
await client.query(
  `INSERT INTO system_settings(key,value) VALUES('bootstrap_admin',$1)
   ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
  [JSON.stringify({ identity })],
);
await client.end();
