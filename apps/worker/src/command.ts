import { spawn } from "node:child_process";
import { redactText } from "@webdeploy/core";

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

export async function runAsUser(
  user: string,
  command: string,
  options: Parameters<typeof runCommand>[2] = {},
): Promise<CommandResult> {
  return runCommand("runuser", ["-u", user, "--", "/bin/bash", "-lc", command], options);
}
