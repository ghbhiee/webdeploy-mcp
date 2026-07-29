import { hostname } from "node:os";
import { createDatabase, loadConfig, loadMasterKey } from "@webdeploy/core";
import { Deployer } from "./deployer.js";

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
const workerId = `${hostname()}-${process.pid}`;
const deployer = new Deployer(database, config, loadMasterKey(config.MASTER_KEY_FILE), workerId);
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

await deployer
  .reconcileActiveProjects()
  .catch((error) => console.error("Reconciliation failed", error));

while (!stopping) {
  const job = await claimJob();
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    continue;
  }
  try {
    if (job.type === "deployment") await deployer.runDeployment(job.targetId);
    else await deployer.runOperation(job.targetId);
  } catch (error) {
    console.error(`${job.type} ${job.targetId} failed`, error);
  }
}

await database.end();

async function claimJob(): Promise<{ type: "deployment" | "operation"; targetId: string } | null> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const deployment = await client.query(
      `SELECT j.id,j.deployment_id FROM deployment_jobs j
       WHERE j.available_at<=now() AND j.locked_at IS NULL
       ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (deployment.rowCount) {
      await client.query(
        `UPDATE deployment_jobs SET locked_at=now(),locked_by=$2,attempts=attempts+1 WHERE id=$1`,
        [deployment.rows[0].id, workerId],
      );
      await client.query("COMMIT");
      return { type: "deployment", targetId: deployment.rows[0].deployment_id };
    }
    const operation = await client.query(
      `SELECT id FROM project_operations
       WHERE status='queued' AND available_at<=now() AND locked_at IS NULL
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (operation.rowCount) {
      await client.query(`UPDATE project_operations SET locked_at=now(),locked_by=$2 WHERE id=$1`, [
        operation.rows[0].id,
        workerId,
      ]);
      await client.query("COMMIT");
      return { type: "operation", targetId: operation.rows[0].id };
    }
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
