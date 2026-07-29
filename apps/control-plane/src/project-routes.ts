import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import {
  AppError,
  DeploymentService,
  ProjectService,
  randomToken,
  type Config,
  type Database,
} from "@webdeploy/core";
import { requireSession } from "./session.js";

export function registerProjectRoutes(
  app: FastifyInstance,
  dependencies: {
    database: Database;
    config: Config;
    projects: ProjectService;
    deployments: DeploymentService;
  },
): void {
  const { database, config, projects, deployments } = dependencies;
  app.post("/api/webhooks/projects/:projectId", async (request) => {
    const projectId = (request.params as any).projectId;
    const signature = String(request.headers["x-webdeploy-signature"] ?? "");
    const payload = JSON.stringify(request.body ?? {});
    const webhook = await projects.authenticateWebhook(projectId, payload, signature);
    return {
      deploymentId: await deployments.create(webhook.actor, projectId, {
        sourceKind: "git",
        sourceSpec: {
          url: webhook.gitUrl,
          ref: (request.body as any)?.ref || webhook.gitRef,
        },
      }),
    };
  });
  app.get("/api/projects", async (request) => {
    const { actor } = await requireSession(request, database, config);
    return { projects: await projects.list(actor) };
  });
  app.post("/api/projects", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    return {
      project: await projects.create(actor, request.body as any),
    };
  });
  app.get("/api/projects/:projectId", async (request) => {
    const { actor } = await requireSession(request, database, config);
    const projectId = (request.params as any).projectId;
    return {
      project: await projects.get(actor, projectId),
      environment: await projects.listEnvironment(actor, projectId),
      releases: await deployments.releases(actor, projectId),
    };
  });
  app.patch("/api/projects/:projectId", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    return {
      project: await projects.update(actor, (request.params as any).projectId, request.body as any),
    };
  });
  app.post("/api/projects/:projectId/transfer", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    const body = request.body as { ownerId: string };
    await projects.transfer(actor, (request.params as any).projectId, body.ownerId);
    return { ok: true };
  });
  app.post("/api/projects/:projectId/webhook-secret", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    return {
      secret: await projects.rotateWebhookSecret(actor, (request.params as any).projectId),
    };
  });
  app.post("/api/projects/:projectId/domain", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    const body = request.body as { hostname: string };
    return {
      hostname: await projects.setDomain(actor, (request.params as any).projectId, body.hostname),
    };
  });
  app.put("/api/projects/:projectId/environment/:name", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    const params = request.params as any;
    const body = request.body as { value: string; kind: "plain" | "secret" };
    await projects.setEnvironment(actor, params.projectId, {
      name: params.name,
      value: body.value,
      kind: body.kind,
    });
    return { ok: true };
  });
  app.delete("/api/projects/:projectId/environment/:name", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    const params = request.params as any;
    await projects.deleteEnvironment(actor, params.projectId, params.name);
    return { ok: true };
  });
  app.post("/api/projects/:projectId/deploy", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    const projectId = (request.params as any).projectId;
    const body = request.body as any;
    return {
      deploymentId: await deployments.create(actor, projectId, {
        sourceKind: body.sourceKind,
        sourceSpec: body.sourceSpec,
      }),
    };
  });
  app.post("/api/projects/:projectId/upload", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    const projectId = (request.params as any).projectId;
    await projects.get(actor, projectId);
    const part = await request.file({ limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) throw new AppError("UPLOAD_REQUIRED", "Choose a ZIP, TAR, or TAR.GZ archive");
    if (!/\.(zip|tar|tar\.gz|tgz)$/i.test(part.filename)) {
      throw new AppError("ARCHIVE_TYPE_INVALID", "Only ZIP, TAR, TAR.GZ, and TGZ are accepted");
    }
    const uploadDirectory = resolve(config.DATA_DIR, "uploads");
    await mkdir(uploadDirectory, { recursive: true });
    const extension = part.filename.toLowerCase().endsWith(".tar.gz")
      ? ".tar.gz"
      : part.filename.slice(part.filename.lastIndexOf("."));
    const storedPath = resolve(uploadDirectory, `${randomToken(24)}${extension}`);
    await pipeline(part.file, createWriteStream(storedPath, { flags: "wx", mode: 0o600 }));
    return {
      deploymentId: await deployments.create(actor, projectId, {
        sourceKind: "archive",
        sourceSpec: { path: storedPath, originalName: part.filename },
      }),
    };
  });
  app.get("/api/deployments/:deploymentId", async (request) => {
    const { actor } = await requireSession(request, database, config);
    return { deployment: await deployments.get(actor, (request.params as any).deploymentId) };
  });
  app.get("/api/deployments/:deploymentId/logs", async (request) => {
    const { actor } = await requireSession(request, database, config);
    const query = request.query as any;
    return {
      logs: await deployments.logs(
        actor,
        (request.params as any).deploymentId,
        Number(query.afterId ?? 0),
        Number(query.limit ?? 500),
      ),
    };
  });
  app.post("/api/projects/:projectId/releases/:releaseId/rollback", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    const params = request.params as any;
    return { operationId: await deployments.rollback(actor, params.projectId, params.releaseId) };
  });
  app.post("/api/projects/:projectId/restart", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    return { operationId: await deployments.restart(actor, (request.params as any).projectId) };
  });
  app.delete("/api/projects/:projectId", async (request) => {
    const { actor } = await requireSession(request, database, config, true);
    return { operationId: await projects.queueDelete(actor, (request.params as any).projectId) };
  });
}
