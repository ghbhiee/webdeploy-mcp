import { existsSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";

// shadow-utils (useradd, groupadd, usermod, ...) serializes writers with link
// locks whose file content is the PID of the holding process. A crashed holder
// leaves the file behind and every later invocation fails immediately with
// "cannot lock ...; try again later".
export const USER_DATABASE_LOCK_FILES = [
  "/etc/passwd.lock",
  "/etc/shadow.lock",
  "/etc/group.lock",
  "/etc/gshadow.lock",
  "/etc/subuid.lock",
  "/etc/subgid.lock",
];

export interface UserDatabaseLock {
  path: string;
  pid: number | null;
  alive: boolean;
  command: string | null;
}

export interface LockInspectionOptions {
  lockFiles?: string[];
  procRoot?: string;
}

export function parseLockFilePid(content: string): number | null {
  const match = /^\s*(\d{1,10})\s*$/.exec(content);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export async function inspectUserDatabaseLocks(
  options: LockInspectionOptions = {},
): Promise<UserDatabaseLock[]> {
  const procRoot = options.procRoot ?? "/proc";
  const locks: UserDatabaseLock[] = [];
  for (const path of options.lockFiles ?? USER_DATABASE_LOCK_FILES) {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const pid = parseLockFilePid(content);
    const alive = pid != null && existsSync(`${procRoot}/${pid}`);
    const command = alive
      ? await readFile(`${procRoot}/${pid}/comm`, "utf8")
          .then((value) => value.trim())
          .catch(() => null)
      : null;
    locks.push({ path, pid, alive, command });
  }
  return locks;
}

// Removes lock files whose holding process no longer exists. Locks held by a
// live process are never touched; a lock without a parseable PID could be
// mid-write, so it only counts as stale once it has stopped changing.
export async function removeStaleUserDatabaseLocks(
  options: LockInspectionOptions = {},
): Promise<{ removed: string[]; held: UserDatabaseLock[] }> {
  const removed: string[] = [];
  const held: UserDatabaseLock[] = [];
  for (const lock of await inspectUserDatabaseLocks(options)) {
    if (lock.alive) {
      held.push(lock);
      continue;
    }
    if (lock.pid == null) {
      const age = await stat(lock.path)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      if (age < 60_000) {
        held.push(lock);
        continue;
      }
    }
    try {
      await unlink(lock.path);
      removed.push(lock.path);
    } catch {
      // The owner released or replaced it concurrently; the retry sorts it out.
    }
  }
  return { removed, held };
}
