import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectUserDatabaseLocks,
  parseLockFilePid,
  removeStaleUserDatabaseLocks,
} from "../../packages/core/src/system-locks";

function scratch(): { lockDir: string; procRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "wdp-locks-"));
  const procRoot = join(root, "proc");
  mkdirSync(procRoot, { recursive: true });
  return { lockDir: root, procRoot };
}

describe("lock file PID parsing", () => {
  it.each([
    ["1234", 1234],
    [" 42\n", 42],
    ["", null],
    ["abc", null],
    ["12 34", null],
    ["-5", null],
    ["0", null],
  ])("parses %j as %o", (content, expected) => {
    expect(parseLockFilePid(content as string)).toBe(expected);
  });
});

describe("user database lock inspection and cleanup", () => {
  it("removes locks whose holding process is dead", async () => {
    const { lockDir, procRoot } = scratch();
    const lock = join(lockDir, "group.lock");
    writeFileSync(lock, "424242\n");
    const { removed, held } = await removeStaleUserDatabaseLocks({
      lockFiles: [lock],
      procRoot,
    });
    expect(removed).toEqual([lock]);
    expect(held).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });

  it("never touches a lock held by a live process", async () => {
    const { lockDir, procRoot } = scratch();
    const lock = join(lockDir, "passwd.lock");
    writeFileSync(lock, "999");
    mkdirSync(join(procRoot, "999"));
    writeFileSync(join(procRoot, "999", "comm"), "apt.systemd.daily\n");
    const { removed, held } = await removeStaleUserDatabaseLocks({
      lockFiles: [lock],
      procRoot,
    });
    expect(removed).toEqual([]);
    expect(held).toMatchObject([
      { path: lock, pid: 999, alive: true, command: "apt.systemd.daily" },
    ]);
    expect(existsSync(lock)).toBe(true);
  });

  it("keeps a fresh unparseable lock but removes an old one", async () => {
    const { lockDir, procRoot } = scratch();
    const fresh = join(lockDir, "shadow.lock");
    const old = join(lockDir, "gshadow.lock");
    writeFileSync(fresh, "garbage");
    writeFileSync(old, "garbage");
    const past = (Date.now() - 3_600_000) / 1000;
    utimesSync(old, past, past);
    const { removed } = await removeStaleUserDatabaseLocks({
      lockFiles: [fresh, old],
      procRoot,
    });
    expect(removed).toEqual([old]);
    expect(existsSync(fresh)).toBe(true);
  });

  it("skips missing lock files entirely", async () => {
    const { lockDir, procRoot } = scratch();
    const locks = await inspectUserDatabaseLocks({
      lockFiles: [join(lockDir, "does-not-exist.lock")],
      procRoot,
    });
    expect(locks).toEqual([]);
  });
});
