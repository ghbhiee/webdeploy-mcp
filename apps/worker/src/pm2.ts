import type { Config } from "@webdeploy/core";
import { runCommand } from "./command.js";
import { projectProcessName } from "./paths.js";

function pm2Environment(config: Config, environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...environment, PM2_HOME: config.PM2_HOME };
}

export async function startReleaseProcess(input: {
  config: Config;
  projectId: string;
  releaseId: string;
  osUser: string;
  cwd: string;
  startCommand: string;
  environment: NodeJS.ProcessEnv;
  knownSecrets: string[];
}): Promise<string> {
  const name = projectProcessName(input.projectId, input.releaseId);
  await runCommand(
    "pm2",
    [
      "start",
      "/bin/bash",
      "--name",
      name,
      "--uid",
      input.osUser,
      "--gid",
      input.osUser,
      "--cwd",
      input.cwd,
      "--time",
      "--",
      "-lc",
      input.startCommand,
    ],
    {
      env: pm2Environment(input.config, input.environment),
      timeoutMs: 60_000,
      knownSecrets: input.knownSecrets,
    },
  );
  return name;
}

export async function stopReleaseProcess(
  config: Config,
  projectId: string,
  releaseId: string,
): Promise<void> {
  await runCommand("pm2", ["delete", projectProcessName(projectId, releaseId)], {
    env: pm2Environment(config),
    timeoutMs: 30_000,
  }).catch(() => undefined);
}

export async function restartReleaseProcess(
  config: Config,
  projectId: string,
  releaseId: string,
  environment: NodeJS.ProcessEnv,
  knownSecrets: string[],
): Promise<void> {
  await runCommand("pm2", ["restart", projectProcessName(projectId, releaseId), "--update-env"], {
    env: pm2Environment(config, environment),
    timeoutMs: 60_000,
    knownSecrets,
  });
}
