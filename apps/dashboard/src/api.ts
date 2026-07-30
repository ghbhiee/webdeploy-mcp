import { toPublicPath } from "./base-path";

export interface Session {
  authenticated: boolean;
  user?: { id: string; username: string; isAdmin: boolean; status: string };
  csrfToken?: string;
  mcpUrl?: string;
  mcpInstall?: McpInstallCatalog;
}

export interface McpInstallCatalog {
  serverName: string;
  mcpUrl: string;
  agents: McpInstallAgent[];
}

export interface McpInstallAgent {
  id: "codex" | "claude" | "generic";
  label: string;
  description: string;
  methods: McpInstallMethod[];
}

export interface McpInstallMethod {
  id: "command" | "prompt" | "manual";
  label: string;
  description: string;
  content: string;
  nextStep: string;
  fileName: string;
}

let csrfToken = "";

export function setCsrf(value?: string): void {
  csrfToken = value ?? "";
}

export function responseErrorMessage(data: unknown, status: number): string {
  if (typeof data !== "object" || data === null) {
    return `Request failed with HTTP ${status}`;
  }
  const body = data as { error?: { message?: unknown } | unknown; message?: unknown };
  if (
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  if (typeof body.message === "string") {
    return body.message;
  }
  return `Request failed with HTTP ${status}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("x-csrf-token", csrfToken);
  }
  const response = await fetch(toPublicPath(path), {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(responseErrorMessage(data, response.status));
  }
  return data as T;
}
