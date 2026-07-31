import { spawn } from "node:child_process";
import {
  redactText,
  removeStaleUserDatabaseLocks,
  type LockInspectionOptions,
  type UserDatabaseLock,
} from "@webdeploy/core";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onOutput?: (stream: "stdout" | "stderr", text: string) => Promise<void> | void;
    knownSecrets?: string[];
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs ?? 900_000);
    timeout.unref();
    const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = redactText(chunk.toString("utf8"), options.knownSecrets);
      if (stream === "stdout") stdout += text;
      else stderr += text;
      void options.onOutput?.(stream, text);
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const exitCode = code ?? (signal ? 128 : 1);
      if (exitCode !== 0) {
        const error = new Error(
          `${executable} exited with code ${exitCode}${signal ? ` (${signal})` : ""}: ${stderr.slice(-2000)}`,
        );
        Object.assign(error, { code: exitCode, stdout, stderr });
        reject(error);
      } else resolve({ code: exitCode, stdout, stderr });
    });
  });
}

// useradd/userdel serialize on the shadow-suite lock files (/etc/passwd.lock,
// /etc/.pwd.lock, ...). apt, unattended-upgrades, cloud-init, or a concurrent
// useradd can hold them briefly, and shadow-utils fails immediately instead of
// waiting, so treat lock contention as retryable.
const USER_DATABASE_LOCK_PATTERN =
  /cannot lock \/etc\/(?:passwd|shadow|group|gshadow|subuid|subgid)|existing lock file|lock file already in use|try again later/i;

export function isUserDatabaseLockError(error: unknown): boolean {
  const stderr = typeof (error as any)?.stderr === "string" ? (error as any).stderr : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return USER_DATABASE_LOCK_PATTERN.test(stderr) || USER_DATABASE_LOCK_PATTERN.test(message);
}

export async function runUserDatabaseCommand(
  executable: string,
  args: string[],
  options: Parameters<typeof runCommand>[2] & {
    maxAttempts?: number;
    retryDelayMs?: number;
  } & LockInspectionOptions = {},
): Promise<CommandResult> {
  const { maxAttempts = 15, retryDelayMs = 500, lockFiles, procRoot, ...commandOptions } = options;
  const lockOptions: LockInspectionOptions = {};
  if (lockFiles) lockOptions.lockFiles = lockFiles;
  if (procRoot) lockOptions.procRoot = procRoot;
  const removedStaleLocks: string[] = [];
  let heldLocks: UserDatabaseLock[] = [];
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runCommand(executable, args, commandOptions);
    } catch (error) {
      lastError = error;
      if (!isUserDatabaseLockError(error) || attempt === maxAttempts) break;
      // A lock that survives several retries has outlived any normal
      // shadow-utils run; clear lock files whose holder is dead so a crashed
      // process cannot block deployments forever. Live holders are never
      // touched — those get the backoff below.
      if (attempt >= 3) {
        const cleaned = await removeStaleUserDatabaseLocks(lockOptions).catch(() => null);
        if (cleaned) {
          heldLocks = cleaned.held;
          if (cleaned.removed.length) {
            removedStaleLocks.push(...cleaned.removed);
            continue;
          }
        }
      }
      const backoff = Math.min(retryDelayMs * 2 ** (attempt - 1), 15_000);
      await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * 250));
    }
  }
  if (isUserDatabaseLockError(lastError)) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    const liveHolders = heldLocks
      .filter((lock) => lock.alive)
      .map((lock) => `${lock.path} held by pid ${lock.pid}${lock.command ? ` (${lock.command})` : ""}`)
      .join("; ");
    throw new Error(
      `${executable} could not lock the system user database after ${maxAttempts} attempts. ` +
        (removedStaleLocks.length
          ? `Stale lock files were detected and removed automatically (${removedStaleLocks.join(", ")}), but locking still failed. `
          : "") +
        (liveHolders
          ? `A running process still holds the lock: ${liveHolders}. Wait for it to finish (for example an apt or unattended-upgrades run) and redeploy. `
          : "No stale lock file was found, so another process (apt, unattended-upgrades, cloud-init, or another useradd) is repeatedly acquiring the lock. ") +
        `Last error: ${detail}`,
    );
  }
  throw lastError;
}

export async function runAsUser(
  user: string,
  command: string,
  options: Parameters<typeof runCommand>[2] = {},
): Promise<CommandResult> {
  return runCommand("runuser", ["-u", user, "--", "/bin/bash", "-lc", command], options);
}
