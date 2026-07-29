import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Nginx shared-domain helper", () => {
  it("adds the include only to the HTTPS virtual host and stores backups off-path", () => {
    const root = mkdtempSync(join(tmpdir(), "webdeploy-nginx-"));
    temporaryDirectories.push(root);
    const enabled = join(root, "sites-enabled");
    mkdirSync(enabled);
    const vhost = join(enabled, "shared.example.com");
    writeFileSync(
      vhost,
      `server {
  listen 80;
  server_name shared.example.com;
}
server {
  listen 443 ssl;
  server_name shared.example.com;
  client_max_body_size 200m;
}
`,
    );
    const include = join(root, "snippets", "webdeploy-control.conf").replaceAll("\\", "/");
    const result = spawnSync(
      pythonCommand(),
      [
        resolve("installer/configure-nginx-path.py"),
        "--nginx-root",
        root,
        "--domain",
        "shared.example.com",
        "--path",
        "/webdeploy",
        "--include",
        include,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const updated = readFileSync(vhost, "utf8");
    expect(updated.match(/Managed by WebDeploy MCP/g)).toHaveLength(1);
    expect(updated.indexOf("Managed by WebDeploy MCP")).toBeGreaterThan(updated.indexOf("443 ssl"));
    expect(
      readFileSync(join(root, "webdeploy-backups", "shared.example.com.webdeploy.bak"), "utf8"),
    ).toContain("client_max_body_size 200m");
  });
});

function pythonCommand(): string {
  return spawnSync("python3", ["--version"]).status === 0 ? "python3" : "python";
}
