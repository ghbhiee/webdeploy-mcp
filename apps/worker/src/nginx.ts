import { existsSync } from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Config } from "@webdeploy/core";
import { runCommand } from "./command.js";

export function renderNginxProject(input: {
  hostname: string;
  projectId: string;
  type: "static" | "node" | "python";
  currentPath: string;
  port?: number | null;
  spaFallback: boolean;
}): string {
  const header = `# Managed by WebDeploy MCP for project ${input.projectId}\n`;
  if (input.type === "static") {
    const fallback = input.spaFallback
      ? "try_files $uri $uri/ /index.html;"
      : "try_files $uri $uri/ =404;";
    return `${header}server {
    listen 80;
    listen [::]:80;
    server_name ${input.hostname};
    root ${input.currentPath.replaceAll("\\", "/")};
    index index.html;
    location / {
        ${fallback}
    }
    location ~ /\\. {
        deny all;
    }
}
`;
  }
  if (!input.port) throw new Error("Dynamic project requires an allocated port");
  return `${header}server {
    listen 80;
    listen [::]:80;
    server_name ${input.hostname};
    location / {
        proxy_pass http://127.0.0.1:${input.port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
`;
}

export async function activateNginxConfig(
  config: Config,
  projectId: string,
  hostname: string,
  content: string,
): Promise<void> {
  await assertNoServerNameConflict(config.NGINX_SITES_DIR, projectId, hostname);
  const target = resolve(config.NGINX_SITES_DIR, `webdeploy-project-${projectId}.conf`);
  const candidate = `${target}.candidate`;
  const previous = `${target}.previous`;
  const hadExisting = existsSync(target);
  if (hadExisting) await writeFile(previous, await readFile(target));
  await writeFile(candidate, content, { mode: 0o644 });
  await rename(candidate, target);
  try {
    await runCommand("nginx", ["-t"], { timeoutMs: 30_000 });
    await runCommand("systemctl", ["reload", "nginx"], { timeoutMs: 30_000 });
    if (existsSync(previous)) await rm(previous);
  } catch (error) {
    if (hadExisting && existsSync(previous)) await rename(previous, target);
    else if (existsSync(target)) await rm(target);
    await runCommand("nginx", ["-t"], { timeoutMs: 30_000 }).catch(() => undefined);
    throw error;
  }
}

export async function removeNginxConfig(config: Config, projectId: string): Promise<void> {
  const target = resolve(config.NGINX_SITES_DIR, `webdeploy-project-${projectId}.conf`);
  if (!existsSync(target)) return;
  await rm(target);
  await runCommand("nginx", ["-t"], { timeoutMs: 30_000 });
  await runCommand("systemctl", ["reload", "nginx"], { timeoutMs: 30_000 });
}

async function assertNoServerNameConflict(
  sitesDirectory: string,
  projectId: string,
  hostname: string,
): Promise<void> {
  const files = await readdir(sitesDirectory, { withFileTypes: true });
  const ownName = `webdeploy-project-${projectId}.conf`;
  const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\bserver_name\\s+[^;]*\\b${escaped}\\b`, "i");
  for (const file of files) {
    if (!file.isFile() || file.name === ownName || file.name.endsWith(".candidate")) continue;
    const path = resolve(sitesDirectory, file.name);
    const contents = await readFile(path, "utf8").catch(() => "");
    if (pattern.test(contents)) {
      throw new Error(`Nginx server_name ${hostname} already exists in ${basename(path)}`);
    }
  }
}
