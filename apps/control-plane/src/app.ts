import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import {
  AppError,
  DeploymentService,
  PageService,
  ProjectService,
  createDatabase,
  loadConfig,
  loadMasterKey,
  type Config,
} from "@webdeploy/core";
import { registerPasskeyRoutes } from "./passkeys.js";
import { createOAuthRuntime } from "./oauth.js";
import { registerMcpRoute } from "./mcp.js";
import { registerPagesRoutes } from "./pages-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerAdminRoutes } from "./admin-routes.js";

export async function buildApp(config: Config = loadConfig()) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers.set-cookie",
          "*.token",
          "*.secret",
          "*.password",
          "*.value",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: Math.min(config.MAX_UPLOAD_BYTES, 2 * 1024 * 1024),
  });
  const database = createDatabase(config.DATABASE_URL);
  const masterKey = loadMasterKey(config.MASTER_KEY_FILE);
  const projects = new ProjectService(database, masterKey, config.RELEASE_RETENTION_DEFAULT);
  const deployments = new DeploymentService(database, projects);
  const pages = new PageService(database, config.DATA_DIR);

  await app.register(cookie);
  await app.register(formbody);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        frameAncestors: ["'none'"],
        // OAuth native-app redirects can leave the origin after a same-origin
        // consent form submission, so the default form-action 'self' is too
        // restrictive for the redirect chain.
        formAction: null,
        // Native OAuth clients legitimately redirect to an HTTP loopback
        // listener. HSTS protects deployed HTTPS origins without breaking it.
        upgradeInsecureRequests: null,
      },
    },
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.MAX_UPLOAD_BYTES },
  });

  // Fastify snapshots the active error handler when each route is registered.
  // Register ours first so AppError responses keep the dashboard's stable
  // { error: { code, message } } contract instead of Fastify's default shape.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    request.log.error(error);
    const statusCode = (error as any).statusCode ?? 500;
    return reply.code(statusCode).send({
      error: {
        code: "INTERNAL_ERROR",
        message: statusCode >= 500 ? "Internal server error" : (error as Error).message,
      },
    });
  });

  app.get("/healthz", async () => {
    await database.query("SELECT 1");
    return { status: "ok", version: "0.1.16" };
  });

  await registerPasskeyRoutes(app, { database, config });
  registerProjectRoutes(app, { database, config, projects, deployments });
  await registerPagesRoutes(app, { config, pages });
  registerAdminRoutes(app, database, config);
  const oauth = await createOAuthRuntime(app, database, config);
  registerMcpRoute(app, { database, config, projects, deployments, pages, oauth });

  const dashboardRoot =
    process.env.DASHBOARD_DIST ?? resolve(process.cwd(), "apps", "dashboard", "dist");
  if (existsSync(dashboardRoot)) {
    await app.register(fastifyStatic, { root: dashboardRoot, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/mcp") {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } });
      }
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    await database.end();
  });
  return app;
}
