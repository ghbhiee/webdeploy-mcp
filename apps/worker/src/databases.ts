import { encryptValue, randomToken, type Config, type Database } from "@webdeploy/core";
import { runCommand } from "./command.js";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function assertIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return value;
}

function platformPostgresPort(config: Config): number {
  try {
    const url = new URL(config.DATABASE_URL);
    if (url.port) return Number(url.port);
  } catch {
    // Fall through to the default port.
  }
  return 5432;
}

async function psqlAsPostgres(sql: string, database?: string): Promise<void> {
  const args = ["-u", "postgres", "--", "psql", "-v", "ON_ERROR_STOP=1", "-X", "-q"];
  if (database) args.push("-d", database);
  args.push("-c", sql);
  await runCommand("runuser", args, { timeoutMs: 60_000 });
}

export async function provisionProjectDatabase(
  database: Database,
  config: Config,
  masterKey: Buffer,
  project: { id: string },
): Promise<void> {
  const row = (
    await database.query("SELECT db_name, db_role FROM project_databases WHERE project_id=$1", [
      project.id,
    ])
  ).rows[0];
  if (!row) throw new Error("No database provisioning request found for this project");
  const dbName = assertIdentifier(row.db_name);
  const dbRole = assertIdentifier(row.db_role);
  const password = randomToken(24);
  try {
    await psqlAsPostgres(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${dbRole}') THEN
          CREATE ROLE ${dbRole} LOGIN;
        END IF;
      END $$;`,
    );
    await psqlAsPostgres(
      `ALTER ROLE ${dbRole} LOGIN PASSWORD '${password}' NOCREATEDB NOCREATEROLE NOSUPERUSER;`,
    );
    const exists = await runCommand(
      "runuser",
      [
        "-u",
        "postgres",
        "--",
        "psql",
        "-X",
        "-t",
        "-A",
        "-c",
        `SELECT 1 FROM pg_database WHERE datname='${dbName}'`,
      ],
      { timeoutMs: 60_000 },
    );
    if (!exists.stdout.trim()) {
      await psqlAsPostgres(`CREATE DATABASE ${dbName} OWNER ${dbRole};`);
    }
    await psqlAsPostgres(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC;`);
    await psqlAsPostgres(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${dbRole};`);
    await psqlAsPostgres(`ALTER SCHEMA public OWNER TO ${dbRole};`, dbName);

    const url = `postgresql://${dbRole}:${password}@127.0.0.1:${platformPostgresPort(config)}/${dbName}`;
    const encrypted = encryptValue(url, masterKey);
    await database.query(
      `INSERT INTO environment_variables
        (project_id,name,kind,ciphertext,nonce,auth_tag,key_version)
       VALUES($1,'DATABASE_URL','secret',$2,$3,$4,$5)
       ON CONFLICT(project_id,name) DO UPDATE SET
        kind='secret',ciphertext=excluded.ciphertext,nonce=excluded.nonce,
        auth_tag=excluded.auth_tag,key_version=excluded.key_version,updated_at=now()`,
      [project.id, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
    );
    await database.query(
      `UPDATE project_databases SET status='provisioned', error_message=NULL,
       provisioned_at=now() WHERE project_id=$1`,
      [project.id],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.query(
      "UPDATE project_databases SET status='failed', error_message=$2 WHERE project_id=$1",
      [project.id, message.slice(0, 2000)],
    );
    throw error;
  }
}

export async function dropProjectDatabase(database: Database, projectId: string): Promise<void> {
  const row = (
    await database.query("SELECT db_name, db_role FROM project_databases WHERE project_id=$1", [
      projectId,
    ])
  ).rows[0];
  if (!row) return;
  const dbName = assertIdentifier(row.db_name);
  const dbRole = assertIdentifier(row.db_role);
  await psqlAsPostgres(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
  await psqlAsPostgres(`DROP ROLE IF EXISTS ${dbRole};`);
  await database.query("DELETE FROM project_databases WHERE project_id=$1", [projectId]);
}
