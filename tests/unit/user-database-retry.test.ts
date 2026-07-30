import { describe, expect, it } from "vitest";
import {
  isUserDatabaseLockError,
  runUserDatabaseCommand,
} from "../../apps/worker/src/command";

describe("system user database lock handling", () => {
  it.each([
    "useradd: cannot lock /etc/passwd; try again later.",
    "useradd: cannot lock /etc/shadow; try again later.",
    "userdel: cannot lock /etc/group; try again later.",
    "useradd: existing lock file /etc/passwd.lock without a PID",
  ])("treats %s as retryable", (stderr) => {
    expect(isUserDatabaseLockError(Object.assign(new Error(stderr), { stderr }))).toBe(true);
  });

  it("does not retry unrelated failures", () => {
    const error = Object.assign(new Error("useradd: user 'wdp-x' already exists"), {
      stderr: "useradd: user 'wdp-x' already exists",
    });
    expect(isUserDatabaseLockError(error)).toBe(false);
  });

  it("retries lock failures until the command succeeds", async () => {
    const marker = `${process.env.TMPDIR ?? "/tmp"}/wdp-lock-test-${process.pid}`;
    // Fails with a lock-style message once, then succeeds on the retry.
    const script = `if [ -e "${marker}" ]; then rm -f "${marker}"; echo "cannot lock /etc/passwd; try again later." >&2; exit 1; fi; echo ok`;
    await runUserDatabaseCommand("bash", ["-c", `touch "${marker}"; exit 0`]);
    const result = await runUserDatabaseCommand("bash", ["-c", script], { retryDelayMs: 1 });
    expect(result.stdout.trim()).toBe("ok");
  });

  it("surfaces a diagnostic error after exhausting retries", async () => {
    await expect(
      runUserDatabaseCommand(
        "bash",
        ["-c", 'echo "cannot lock /etc/passwd; try again later." >&2; exit 1'],
        { maxAttempts: 2, retryDelayMs: 1 },
      ),
    ).rejects.toThrow(/stale lock file/);
  });
});
