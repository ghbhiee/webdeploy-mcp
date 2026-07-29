import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "./db.js";

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
      const version = file.split("_", 1)[0]!;
      const exists = await database.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
        version,
      ]);
      if (exists.rowCount) continue;
      const sql = await readFile(resolve(migrationsDirectory, file), "utf8");
      await database.query(sql);
    }
  } finally {
    await database.end();
  }
}
