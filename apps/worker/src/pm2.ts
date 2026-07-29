import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "@webdeploy/core";
import { runCommand } from "./command.js";
import { projectProcessName } from "./paths.js";

function pm2CommandEnvironment(config: Config): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    PM2_HOME: config.PM2_HOME,
  };
}

interface ReleaseProcessInput {
  config: Config;
  projectId: string;
  releaseId: string;
  osUser: string;
  cwd: string;
  startCommand: string;
  environment: NodeJS.ProcessEnv;
  knownSecrets: string[];
}

export async function startReleaseProcess(input: ReleaseProcessInput): Promise<string> {
  const name = projectProcessName(input.projectId, input.releaseId);
  const ecosystemPath = resolve(input.config.CONFIG_DIR, `.pm2-${name}-${randomUUID()}.json`);
  await writeFile(
    ecosystemPath,
    JSON.stringify({
      apps: [
        {
          name,
          script: "/bin/bash",
          interpreter: "none",
          args: ["-lc", input.startCommand],
          uid: input.osUser,
          gid: input.osUser,
          cwd: input.cwd,
          time: true,
          env: input.environment,
        },
      ],
    }),
    { mode: 0o600 },
  );
  try {
    await runCommand("pm2", ["start", ecosystemPath, "--only", name], {
      env: pm2CommandEnvironment(input.config),
      timeoutMs: 60_000,
      knownSecrets: input.knownSecrets,
    });
  } finally {
    await rm(ecosystemPath, { force: true });
  }
  return name;
}

export async function stopReleaseProcess(
  config: Config,
  projectId: string,
  releaseId: string,
): Promise<void> {
  await runCommand("pm2", ["delete", projectProcessName(projectId, releaseId)], {
    env: pm2CommandEnvironment(config),
    timeoutMs: 30_000,
  }).catch(() => undefined);
}

export async function restartReleaseProcess(input: ReleaseProcessInput): Promise<void> {
  await stopReleaseProcess(input.config, input.projectId, input.releaseId);
  await startReleaseProcess(input);
}
