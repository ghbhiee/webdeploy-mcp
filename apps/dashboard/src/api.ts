export interface Session {
  authenticated: boolean;
  user?: { id: string; username: string; isAdmin: boolean; status: string };
  csrfToken?: string;
  mcpUrl?: string;
}

let csrfToken = "";

export function setCsrf(value?: string): void {
  csrfToken = value ?? "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("x-csrf-token", csrfToken);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Request failed with HTTP ${response.status}`);
  }
  return data as T;
}
