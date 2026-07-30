#!/usr/bin/env node
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import type { McpAgentId, McpInstallMethodId } from "@webdeploy/core";

const envFile = process.env.WEBDEPLOY_ENV_FILE ?? "/etc/webdeploy/webdeploy.env";
if (existsSync(envFile)) loadEnvFile(envFile);

const {
  AppError,
  createDatabase,
  createMcpInstallCatalog,
  loadConfig,
  renderMcpInstallGuide,
  writeAudit,
} = await import("@webdeploy/core");
const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
const program = new Command()
  .name("webdeploy")
  .description("Administer a local WebDeploy MCP installation")
  .version("0.1.9");

program
  .command("status")
  .description("Show service and database status")
  .action(async () => {
    const db = await database.query("SELECT now() AS server_time");
    const control = await commandOk("pm2", ["describe", "webdeploy-control"], pm2Env());
    const worker = await commandOk("systemctl", ["is-active", "--quiet", "webdeploy-worker"]);
    printRows([
      { component: "database", status: db.rowCount ? "ok" : "unavailable" },
      { component: "control-plane", status: control ? "running" : "stopped" },
      { component: "worker", status: worker ? "running" : "stopped" },
    ]);
  });

program
  .command("start")
  .description("Start WebDeploy services")
  .action(async () => {
    await run("pm2", ["start", resolve(config.CONFIG_DIR, "ecosystem.config.cjs")], pm2Env());
    await run("systemctl", ["start", "webdeploy-worker"]);
    console.log("WebDeploy services started.");
  });
program
  .command("stop")
  .description("Stop WebDeploy services")
  .action(async () => {
    await run("systemctl", ["stop", "webdeploy-worker"]);
    await run("pm2", ["stop", "webdeploy-control"], pm2Env());
    console.log("WebDeploy services stopped.");
  });
program
  .command("restart")
  .description("Restart WebDeploy services")
  .action(async () => {
    await run("pm2", ["restart", "webdeploy-control", "--update-env"], pm2Env());
    await run("systemctl", ["restart", "webdeploy-worker"]);
    console.log("WebDeploy services restarted.");
  });
program
  .command("logs")
  .description("Follow control-plane logs")
  .option("-n, --lines <number>", "Number of previous lines", "100")
  .action(async ({ lines }) => {
    await run(
      "pm2",
      ["logs", "webdeploy-control", "--lines", String(Number(lines))],
      pm2Env(),
      true,
    );
  });

program
  .command("doctor")
  .description("Check required software and configuration")
  .action(async () => {
    const checks = [
      ["node", ["--version"]],
      ["pm2", ["--version"]],
      ["nginx", ["-v"]],
      ["git", ["--version"]],
      ["certbot", ["--version"]],
      ["psql", ["--version"]],
      ["mise", ["--version"]],
    ] as const;
    const rows: Array<Record<string, string>> = [];
    for (const [name, args] of checks) {
      rows.push({ check: name, status: (await commandOk(name, [...args])) ? "ok" : "missing" });
    }
    rows.push({
      check: "master key",
      status: existsSync(config.MASTER_KEY_FILE) ? "ok" : "missing",
    });
    rows.push({ check: "OIDC JWKS", status: existsSync(config.OIDC_JWKS_FILE) ? "ok" : "missing" });
    rows.push({
      check: "database",
      status: (await database.query("SELECT 1")).rowCount ? "ok" : "failed",
    });
    printRows(rows);
    if (rows.some((row) => row.status !== "ok")) process.exitCode = 1;
  });

program
  .command("mcp")
  .description("Show copy-ready MCP installation instructions")
  .option("-a, --agent <agent>", "Agent: codex, claude, or generic")
  .option("-m, --method <method>", "Method: command, prompt, or manual")
  .option("-o, --output <file>", "Also save the instructions to a file")
  .option("--raw", "Print only the copyable content; requires --agent")
  .addHelpText(
    "after",
    `
Examples:
  webdeploy mcp
  webdeploy mcp --agent codex --method command
  webdeploy mcp --agent claude --method prompt --output claude-mcp.txt
  webdeploy mcp --agent generic --method manual --raw`,
  )
  .action(async (options: { agent?: string; method?: string; output?: string; raw?: boolean }) => {
    const agents = new Set<McpAgentId>(["codex", "claude", "generic"]);
    const methods = new Set<McpInstallMethodId>(["command", "prompt", "manual"]);
    if (options.agent && !agents.has(options.agent as McpAgentId)) {
      throw new Error("--agent must be codex, claude, or generic.");
    }
    if (options.method && !methods.has(options.method as McpInstallMethodId)) {
      throw new Error("--method must be command, prompt, or manual.");
    }
    if (options.raw && !options.agent) throw new Error("--raw requires --agent.");

    const selection: {
      agent?: McpAgentId;
      method?: McpInstallMethodId;
      raw?: boolean;
    } = {};
    if (options.agent) selection.agent = options.agent as McpAgentId;
    if (options.method) selection.method = options.method as McpInstallMethodId;
    if (options.raw) selection.raw = true;
    const guide = renderMcpInstallGuide(
      createMcpInstallCatalog(config.MCP_PUBLIC_URL, config.MCP_SERVER_NAME),
      selection,
    );
    process.stdout.write(guide);
    if (options.output) {
      const destination = resolve(options.output);
      await writeFile(destination, guide, { encoding: "utf8", mode: 0o644 });
      console.log(`Saved MCP installation instructions to ${destination}`);
    }
  });

const auth = program.command("auth").description("Manage pending Passkey enrollment");
auth.command("list-pending").action(async () => {
  const result = await database.query(
    `SELECT r.request_code,u.username,u.email,r.created_at,r.expires_at
     FROM passkey_enrollment_requests r JOIN users u ON u.id=r.user_id
     WHERE r.status='pending' AND r.expires_at>now() ORDER BY r.created_at`,
  );
  printRows(result.rows);
});
auth
  .command("approve-passkey <request-code>")
  .description("Approve a pending Passkey enrollment")
  .action(async (requestCode) => reviewEnrollment(requestCode, true));
auth
  .command("reject-passkey <request-code>")
  .description("Reject a pending Passkey enrollment")
  .action(async (requestCode) => reviewEnrollment(requestCode, false));

const users = program.command("users").description("Manage users");
users.command("list").action(async () => {
  const result = await database.query(
    "SELECT id,username,email,status,is_admin,created_at FROM users ORDER BY created_at",
  );
  printRows(result.rows);
});
users.command("disable <user-id>").action(async (userId) => {
  await database.query("UPDATE users SET status='disabled',disabled_at=now() WHERE id=$1", [
    userId,
  ]);
  await revokeUserState(userId);
  await audit("user.disabled", "user", userId);
  console.log(`Disabled user ${userId}.`);
});
users.command("set-admin <user-id>").action(async (userId) => {
  await database.query(
    "UPDATE users SET is_admin=true,status='active',updated_at=now() WHERE id=$1",
    [userId],
  );
  await audit("user.admin.granted", "user", userId);
  console.log(`Granted administrator access to ${userId}.`);
});
users.command("remove-admin <user-id>").action(async (userId) => {
  const count = await database.query(
    "SELECT count(*)::int AS count FROM users WHERE is_admin=true AND status='active'",
  );
  const target = await database.query("SELECT is_admin FROM users WHERE id=$1", [userId]);
  if (target.rows[0]?.is_admin && count.rows[0].count <= 1) {
    throw new AppError("LAST_ADMIN", "Cannot remove the last active administrator");
  }
  await database.query("UPDATE users SET is_admin=false,updated_at=now() WHERE id=$1", [userId]);
  await audit("user.admin.removed", "user", userId);
  console.log(`Removed administrator access from ${userId}.`);
});

const passkeys = program.command("passkeys").description("Manage Passkeys");
passkeys.command("list <user-id>").action(async (userId) => {
  const result = await database.query(
    `SELECT id,name,status,device_type,backed_up,last_used_at,created_at
     FROM passkeys WHERE user_id=$1 ORDER BY created_at`,
    [userId],
  );
  printRows(result.rows);
});
passkeys.command("revoke <passkey-id>").action(async (passkeyId) => {
  const key = (
    await database.query(
      `UPDATE passkeys SET status='revoked',revoked_at=now()
       WHERE id=$1 RETURNING user_id`,
      [passkeyId],
    )
  ).rows[0];
  if (!key) throw new AppError("PASSKEY_NOT_FOUND", "Passkey not found", 404);
  await database.query("UPDATE web_sessions SET revoked_at=now() WHERE passkey_id=$1", [passkeyId]);
  await database.query("DELETE FROM oauth_objects WHERE payload->>'accountId'=$1", [key.user_id]);
  await audit("passkey.revoked", "passkey", passkeyId);
  console.log(`Revoked Passkey ${passkeyId}.`);
});

const projects = program.command("projects").description("Inspect projects");
projects.command("list").action(async () => {
  const result = await database.query(
    `SELECT p.id,p.name,p.slug,p.type,p.status,u.username AS owner,p.created_at
     FROM projects p JOIN users u ON u.id=p.owner_id ORDER BY p.created_at`,
  );
  printRows(result.rows);
});
projects.command("restart <project-id>").action(async (projectId) => {
  const owner = await database.query("SELECT owner_id FROM projects WHERE id=$1", [projectId]);
  if (!owner.rows[0]) throw new AppError("PROJECT_NOT_FOUND", "Project not found", 404);
  const operation = await database.query(
    `INSERT INTO project_operations(project_id,requested_by,kind)
     VALUES($1,$2,'restart') RETURNING id`,
    [projectId, owner.rows[0].owner_id],
  );
  console.log(`Queued restart ${operation.rows[0].id}.`);
});

program
  .command("backup [output]")
  .description("Create a database and configuration backup")
  .action(async (output) => {
    const destination = resolve(
      output ?? `webdeploy-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`,
    );
    const temporary = `${destination}.work`;
    await run("mkdir", ["-p", temporary]);
    await run("pg_dump", [
      "--format=custom",
      "--file",
      resolve(temporary, "database.dump"),
      config.DATABASE_URL,
    ]);
    await run("tar", [
      "-czf",
      destination,
      "-C",
      temporary,
      ".",
      "-C",
      "/",
      config.CONFIG_DIR.replace(/^\//, ""),
    ]);
    await run("rm", ["-rf", temporary]);
    console.log(
      `Backup created at ${destination}. Protect it: it includes encrypted data and keys.`,
    );
  });
program
  .command("restore <backup>")
  .requiredOption("--confirm", "Confirm destructive restore")
  .action(async (backup) => {
    console.log(
      `Restore is intentionally offline. Stop services, then run installer/restore.sh ${resolve(backup)}.`,
    );
  });
program.command("update").action(() => runScript("update.sh"));
program.command("uninstall").action(() => runScript("uninstall.sh"));

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.end();
}

async function reviewEnrollment(requestCode: string, approve: boolean): Promise<void> {
  const status = approve ? "active" : "rejected";
  const enrollment = (
    await database.query(
      `UPDATE passkey_enrollment_requests SET status=$2,reviewed_at=now()
       WHERE request_code=$1 AND status='pending' AND expires_at>now()
       RETURNING id,user_id`,
      [requestCode, status],
    )
  ).rows[0];
  if (!enrollment) throw new AppError("REQUEST_NOT_FOUND", "Pending request not found", 404);
  await database.query("UPDATE passkeys SET status=$2 WHERE enrollment_request_id=$1", [
    enrollment.id,
    status,
  ]);
  if (approve) {
    await database.query(
      "UPDATE users SET status='active',approved_at=now(),updated_at=now() WHERE id=$1",
      [enrollment.user_id],
    );
  }
  await audit(
    approve ? "passkey.enrollment.approved" : "passkey.enrollment.rejected",
    "passkey_enrollment",
    enrollment.id,
  );
  console.log(`${approve ? "Approved" : "Rejected"} ${requestCode}.`);
}

async function revokeUserState(userId: string): Promise<void> {
  await database.query("UPDATE web_sessions SET revoked_at=now() WHERE user_id=$1", [userId]);
  await database.query("DELETE FROM oauth_objects WHERE payload->>'accountId'=$1", [userId]);
}

async function audit(action: string, targetType: string, targetId: string): Promise<void> {
  await writeAudit(database, {
    actorSystemUid: process.env.SUDO_USER ?? process.env.USER ?? "local-admin",
    action,
    targetType,
    targetId,
  });
}

function pm2Env(): NodeJS.ProcessEnv {
  return { ...process.env, PM2_HOME: config.PM2_HOME };
}

async function commandOk(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await run(command, args, env);
    return true;
  } catch {
    return false;
  }
}

function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  inherit = false,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${executable} failed: ${stderr.trim()}`)),
    );
  });
}

async function runScript(name: string): Promise<void> {
  const script = resolve(config.CONFIG_DIR, name);
  if (!existsSync(script)) throw new Error(`Installer script not found: ${script}`);
  await run("bash", [script], process.env, true);
}

function printRows(rows: Array<Record<string, unknown>>): void {
  if (!rows.length) console.log("No records.");
  else console.table(rows);
}
