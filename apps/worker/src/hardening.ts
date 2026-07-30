import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { Database } from "@webdeploy/core";
import { runCommand, runUserDatabaseCommand } from "./command.js";

export const PROJECT_USERS_GROUP = "webdeploy-projects";

const SSHD_DROPIN_DIR = "/etc/ssh/sshd_config.d";
const SSHD_DROPIN = `${SSHD_DROPIN_DIR}/60-webdeploy-projects.conf`;
// A nologin shell blocks interactive logins but not SFTP (internal-sftp) or
// ssh -N port forwarding once a build script plants an authorized_keys file in
// its own home directory. DenyGroups rejects the users at authentication.
const SSHD_DROPIN_CONTENT = `# Managed by WebDeploy MCP. Do not edit; the worker rewrites this file.
DenyGroups ${PROJECT_USERS_GROUP}
`;

export async function ensureProjectUsersGroup(): Promise<void> {
  const exists = await runCommand("getent", ["group", PROJECT_USERS_GROUP]).then(
    () => true,
    () => false,
  );
  if (!exists) await runUserDatabaseCommand("groupadd", ["--system", PROJECT_USERS_GROUP]);
}

export async function ensureUserInProjectsGroup(osUser: string): Promise<void> {
  const groups = await runCommand("id", ["-nG", osUser]);
  if (groups.stdout.trim().split(/\s+/).includes(PROJECT_USERS_GROUP)) return;
  await runUserDatabaseCommand("usermod", ["-aG", PROJECT_USERS_GROUP, osUser]);
}

export async function enforceSshLockdown(database: Database): Promise<void> {
  await ensureProjectUsersGroup();
  const result = await database.query("SELECT os_user FROM projects WHERE os_user IS NOT NULL");
  for (const row of result.rows) {
    await ensureUserInProjectsGroup(row.os_user).catch((error) =>
      console.error(`Unable to add ${row.os_user} to ${PROJECT_USERS_GROUP}`, error),
    );
  }
  if (!existsSync(SSHD_DROPIN_DIR)) return;
  const current = await readFile(SSHD_DROPIN, "utf8").catch(() => "");
  if (current === SSHD_DROPIN_CONTENT) return;
  await writeFile(SSHD_DROPIN, SSHD_DROPIN_CONTENT, { mode: 0o644 });
  try {
    await runCommand("sshd", ["-t"], { timeoutMs: 30_000 });
  } catch (error) {
    // Never risk locking the operator out with a configuration sshd rejects.
    await rm(SSHD_DROPIN, { force: true });
    console.error("sshd -t rejected the WebDeploy DenyGroups drop-in; it was removed", error);
    return;
  }
  await runCommand("systemctl", ["reload", "ssh"], { timeoutMs: 30_000 }).catch(() =>
    runCommand("systemctl", ["reload", "sshd"], { timeoutMs: 30_000 }).catch(() => undefined),
  );
}
