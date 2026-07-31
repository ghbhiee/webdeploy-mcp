import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase, withTransaction } from "./db.js";

export async function migrate(
  connectionString: string,
  migrationsDirectory: string,
): Promise<void> {
  const database = createDatabase(connectionString);
  try {
    await database.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const exists = await database.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
        version,
      ]);
      if (exists.rowCount) continue;
      const sql = await readFile(resolve(migrationsDirectory, file), "utf8");
      // The runner registers the version itself so a migration file that
      // forgets its own INSERT cannot be re-applied forever; files that do
      // insert stay compatible via ON CONFLICT DO NOTHING. One transaction
      // per migration keeps apply-and-register atomic.
      await withTransaction(database, async (client) => {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING",
          [version],
        );
      });
    }
  } finally {
    await database.end();
  }
}
