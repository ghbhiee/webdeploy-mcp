import { readFileSync } from "node:fs";
import { z } from "zod";
import { deriveMcpServerName } from "./mcp-install.js";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3847),
  PUBLIC_URL: z.string().url(),
  MCP_PUBLIC_URL: z.string().url().optional(),
  MCP_SERVER_NAME: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .optional(),
  DATABASE_URL: z.string().min(1),
  DATA_DIR: z.string().default("/var/lib/webdeploy"),
  CONFIG_DIR: z.string().default("/etc/webdeploy"),
  MASTER_KEY_FILE: z.string().default("/etc/webdeploy/master.key"),
  OIDC_JWKS_FILE: z.string().default("/etc/webdeploy/oidc-jwks.json"),
  SESSION_COOKIE_NAME: z.string().default("wd_session"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  TRUST_PROXY: booleanString,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(104_857_600),
  PORT_RANGE_START: z.coerce.number().int().min(1024).max(65534).default(41_000),
  PORT_RANGE_END: z.coerce.number().int().min(1025).max(65535).default(41_999),
  RELEASE_RETENTION_DEFAULT: z.coerce.number().int().min(1).max(50).default(5),
  ADMIN_SOCKET: z.string().default("/run/webdeploy/admin.sock"),
  NGINX_SITES_DIR: z.string().default("/etc/nginx/conf.d"),
  PM2_HOME: z.string().default("/var/lib/webdeploy/pm2"),
  RUNTIME_MANAGER: z.enum(["mise", "system"]).default("mise"),
});

export type Config = Omit<z.infer<typeof schema>, "MCP_PUBLIC_URL" | "MCP_SERVER_NAME"> & {
  MCP_PUBLIC_URL: string;
  MCP_SERVER_NAME: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  if (!parsed.MCP_PUBLIC_URL) parsed.MCP_PUBLIC_URL = parsed.PUBLIC_URL;
  if (!parsed.MCP_SERVER_NAME) parsed.MCP_SERVER_NAME = deriveMcpServerName(parsed.MCP_PUBLIC_URL);
  if (parsed.PORT_RANGE_START > parsed.PORT_RANGE_END) {
    throw new Error("PORT_RANGE_START must be less than or equal to PORT_RANGE_END");
  }
  return parsed as Config;
}

export function loadMasterKey(path: string): Buffer {
  const raw = readFileSync(path);
  const key = raw.toString("utf8").trim();
  const decoded = /^[A-Za-z0-9+/]+=*$/.test(key) ? Buffer.from(key, "base64") : raw;
  if (decoded.length !== 32) {
    throw new Error(
      "MASTER_KEY_FILE must contain exactly 32 random bytes or their base64 encoding",
    );
  }
  return decoded;
}
