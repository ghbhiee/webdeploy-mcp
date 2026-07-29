import { describe, expect, it } from "vitest";
import { assertSafeArchiveEntry, projectProcessName, safeChild } from "../../apps/worker/src/paths";

describe("managed paths", () => {
  it("keeps release paths below their managed root", () => {
    expect(safeChild("/var/lib/webdeploy/projects/id", "releases", "release")).toContain(
      "releases",
    );
    expect(() => safeChild("/var/lib/webdeploy/projects/id", "..", "..", "etc")).toThrow(/escapes/);
  });

  it.each(["../secret", "/etc/passwd", "C:\\Windows\\system.ini", "ok/../../bad"])(
    "rejects unsafe archive member %s",
    (entry) => expect(() => assertSafeArchiveEntry(entry)).toThrow(),
  );

  it("creates bounded PM2 names", () => {
    const name = projectProcessName(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "11111111-2222-3333-4444-555555555555",
    );
    expect(name).toBe("wdp-aaaaaaaabbbb-11111111");
  });
});
