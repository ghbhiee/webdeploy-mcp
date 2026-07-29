import type { Database } from "./db.js";
import { withTransaction } from "./db.js";
import { AppError, assertFound } from "./errors.js";
import { requireProjectAccess } from "./authorization.js";
import { writeAudit } from "./audit.js";
import type { Actor, SourceKind } from "./types.js";
import { ProjectService } from "./projects.js";

export interface DeploymentRequest {
  sourceKind: SourceKind;
  sourceSpec: Record<string, unknown>;
}

export class DeploymentService {
  constructor(
    private readonly database: Database,
    private readonly projects: ProjectService,
  ) {}

  async create(actor: Actor, projectId: string, request: DeploymentRequest): Promise<string> {
    const project = await this.projects.get(actor, projectId);
    requireProjectAccess(actor, project.ownerId);
    validateSource(request);
    const id = await withTransaction(this.database, async (client) => {
      const deployment = await client.query(
        `INSERT INTO deployments(project_id,requested_by,source_kind,source_spec)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [projectId, actor.id, request.sourceKind, JSON.stringify(request.sourceSpec)],
      );
      const deploymentId = deployment.rows[0].id as string;
      await client.query("INSERT INTO deployment_jobs(deployment_id) VALUES($1)", [deploymentId]);
      return deploymentId;
    });
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "deployment.create",
      targetType: "deployment",
      targetId: id,
      metadata: { projectId, sourceKind: request.sourceKind },
    });
    return id;
  }

  async get(actor: Actor, deploymentId: string): Promise<Record<string, unknown>> {
    const result = await this.database.query(
      `SELECT d.*, p.owner_id FROM deployments d JOIN projects p ON p.id=d.project_id WHERE d.id=$1`,
      [deploymentId],
    );
    const row = assertFound(result.rows[0], "Deployment not found");
    requireProjectAccess(actor, row.owner_id);
    return {
      id: row.id,
      projectId: row.project_id,
      sourceKind: row.source_kind,
      status: row.status,
      releaseId: row.release_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
    };
  }

  async logs(
    actor: Actor,
    deploymentId: string,
    afterId = 0,
    limit = 500,
  ): Promise<Array<Record<string, unknown>>> {
    await this.get(actor, deploymentId);
    const result = await this.database.query(
      `SELECT id,stream,message,created_at FROM deployment_logs
       WHERE deployment_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
      [deploymentId, Math.max(0, afterId), Math.min(1000, Math.max(1, limit))],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      stream: row.stream,
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  async releases(actor: Actor, projectId: string): Promise<Array<Record<string, unknown>>> {
    await this.projects.get(actor, projectId);
    const result = await this.database.query(
      `SELECT r.id,r.sequence,r.port,r.source_revision,r.status,r.activated_at,r.created_at,
              d.id AS deployment_id
       FROM releases r JOIN deployments d ON d.id=r.deployment_id
       WHERE r.project_id=$1 ORDER BY r.sequence DESC`,
      [projectId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sequence: Number(row.sequence),
      port: row.port,
      sourceRevision: row.source_revision,
      status: row.status,
      activatedAt: row.activated_at,
      createdAt: row.created_at,
      deploymentId: row.deployment_id,
    }));
  }

  async rollback(actor: Actor, projectId: string, releaseId: string): Promise<string> {
    await this.projects.get(actor, projectId);
    const release = await this.database.query(
      "SELECT id FROM releases WHERE id=$1 AND project_id=$2 AND status IN ('active','inactive')",
      [releaseId, projectId],
    );
    assertFound(release.rows[0], "Release not found or not eligible for rollback");
    return this.queueOperation(actor, projectId, "rollback", releaseId);
  }

  async restart(actor: Actor, projectId: string): Promise<string> {
    const project = await this.projects.get(actor, projectId);
    if (project.type === "static") {
      throw new AppError(
        "STATIC_RESTART_NOT_REQUIRED",
        "Static projects do not have a process to restart",
      );
    }
    return this.queueOperation(actor, projectId, "restart");
  }

  private async queueOperation(
    actor: Actor,
    projectId: string,
    kind: "restart" | "rollback",
    releaseId?: string,
  ): Promise<string> {
    const result = await this.database.query(
      `INSERT INTO project_operations(project_id,requested_by,kind,target_release_id)
       VALUES($1,$2,$3,$4) RETURNING id`,
      [projectId, actor.id, kind, releaseId ?? null],
    );
    const id = result.rows[0].id as string;
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: `project.${kind}.queued`,
      targetType: "project",
      targetId: projectId,
      metadata: { operationId: id, releaseId },
    });
    return id;
  }
}

function validateSource(request: DeploymentRequest): void {
  if (request.sourceKind === "git") {
    const url = String(request.sourceSpec.url ?? "");
    if (!/^(https:\/\/|ssh:\/\/|git@)/.test(url)) {
      throw new AppError("INVALID_GIT_URL", "Git URL must use HTTPS or SSH");
    }
  } else if (request.sourceKind === "archive") {
    const path = String(request.sourceSpec.path ?? "");
    if (!path) throw new AppError("INVALID_ARCHIVE", "Archive upload reference is required");
  } else {
    const files = request.sourceSpec.files;
    if (!Array.isArray(files) || files.length === 0 || files.length > 100) {
      throw new AppError("INVALID_INLINE_FILES", "Inline deployments require 1 to 100 files");
    }
    let total = 0;
    for (const file of files as Array<any>) {
      if (
        typeof file.path !== "string" ||
        file.path.startsWith("/") ||
        file.path.includes("..") ||
        file.path.includes("\\")
      ) {
        throw new AppError("INVALID_INLINE_PATH", "Inline file paths must be safe relative paths");
      }
      total += Buffer.byteLength(
        String(file.content ?? ""),
        file.encoding === "base64" ? "base64" : "utf8",
      );
    }
    if (total > 1_048_576) {
      throw new AppError("INLINE_FILES_TOO_LARGE", "Inline deployments are limited to 1 MiB");
    }
  }
}
