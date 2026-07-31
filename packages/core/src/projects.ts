import { domainToASCII } from "node:url";
import { resolve4, resolve6 } from "node:dns/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database, DatabaseClient } from "./db.js";
import { withTransaction } from "./db.js";
import { AppError, assertFound } from "./errors.js";
import { requireAdmin, requireProjectAccess } from "./authorization.js";
import { decryptValue, encryptValue, randomToken } from "./crypto.js";
import { writeAudit } from "./audit.js";
import type { Actor, ProjectSettings, ProjectType } from "./types.js";

export interface ProjectRecord {
  id: string;
  ownerId: string;
  ownerUsername: string;
  name: string;
  slug: string;
  type: ProjectType;
  status: string;
  currentReleaseId: string | null;
  primaryHostname: string | null;
  primaryDomainVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  settings: ProjectSettings;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function mapProject(row: any): ProjectRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerUsername: row.owner_username,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    currentReleaseId: row.current_release_id,
    primaryHostname: row.primary_hostname,
    primaryDomainVerified: Boolean(row.primary_domain_verified_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settings: {
      gitUrl: row.git_url,
      gitRef: row.git_ref,
      installCommand: row.install_command,
      buildCommand: row.build_command,
      outputDirectory: row.output_directory,
      startCommand: row.start_command,
      servicePort: row.service_port,
      healthCheckPath: row.health_check_path,
      spaFallback: row.spa_fallback,
      nodeVersion: row.node_version,
      pythonVersion: row.python_version,
      autoDeploy: row.auto_deploy,
      releaseRetention: row.release_retention,
    },
  };
}

const SELECT_PROJECT = `
  SELECT p.*, u.username AS owner_username, s.*, pd.hostname AS primary_hostname
  FROM projects p
  JOIN users u ON u.id = p.owner_id
  JOIN project_settings s ON s.project_id = p.id
  LEFT JOIN LATERAL (
    SELECT hostname, verified_at AS primary_domain_verified_at FROM project_domains
    WHERE project_id = p.id AND is_primary = true
    LIMIT 1
  ) pd ON true
`;

export class ProjectService {
  constructor(
    private readonly database: Database,
    private readonly masterKey: Buffer,
    private readonly defaultRetention = 5,
    private readonly publicUrl = "http://localhost",
  ) {}

  async list(actor: Actor): Promise<ProjectRecord[]> {
    const result = actor.isAdmin
      ? await this.database.query(`${SELECT_PROJECT} ORDER BY p.created_at DESC`)
      : await this.database.query(
          `${SELECT_PROJECT} WHERE p.owner_id = $1 ORDER BY p.created_at DESC`,
          [actor.id],
        );
    return result.rows.map(mapProject);
  }

  async get(actor: Actor, projectId: string): Promise<ProjectRecord> {
    const result = await this.database.query(`${SELECT_PROJECT} WHERE p.id = $1`, [projectId]);
    const project = assertFound(result.rows[0], "Project not found");
    requireProjectAccess(actor, project.owner_id);
    return mapProject(project);
  }

  async create(actor: Actor, input: { name: string; type?: ProjectType }): Promise<ProjectRecord> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 120) {
      throw new AppError("INVALID_NAME", "Project name must contain 1 to 120 characters");
    }
    const baseSlug = slugify(name) || "project";
    const projectId = await withTransaction(this.database, async (client) => {
      let slug = baseSlug;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const exists = await client.query("SELECT 1 FROM projects WHERE slug = $1", [slug]);
        if (!exists.rowCount) break;
        slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;
      }
      const project = await client.query(
        `INSERT INTO projects(owner_id, name, slug, type)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [actor.id, name, slug, input.type ?? "static"],
      );
      const id = project.rows[0].id as string;
      await client.query(
        `INSERT INTO project_settings(project_id, release_retention)
         VALUES ($1, $2)`,
        [id, this.defaultRetention],
      );
      return id;
    });
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "project.create",
      targetType: "project",
      targetId: projectId,
      metadata: { name, type: input.type ?? "static" },
    });
    return this.get(actor, projectId);
  }

  async update(
    actor: Actor,
    projectId: string,
    input: Partial<ProjectSettings> & { name?: string; type?: ProjectType },
  ): Promise<ProjectRecord> {
    const current = await this.get(actor, projectId);
    const nextName = input.name?.trim() ?? current.name;
    if (!nextName || nextName.length > 120)
      throw new AppError("INVALID_NAME", "Invalid project name");
    const settings = { ...current.settings, ...input };
    validateRelativeDirectory(settings.outputDirectory);
    validateHealthPath(settings.healthCheckPath);
    if (
      settings.servicePort != null &&
      (!Number.isInteger(settings.servicePort) ||
        settings.servicePort < 1024 ||
        settings.servicePort > 65535)
    ) {
      throw new AppError("INVALID_SERVICE_PORT", "Service port must be between 1024 and 65535");
    }
    await withTransaction(this.database, async (client) => {
      await client.query(
        `UPDATE projects SET name = $2, type = $3, updated_at = now() WHERE id = $1`,
        [projectId, nextName, input.type ?? current.type],
      );
      await client.query(
        `UPDATE project_settings SET
          git_url=$2, git_ref=$3, install_command=$4, build_command=$5,
          output_directory=$6, start_command=$7, service_port=$8,
          health_check_path=$9, spa_fallback=$10, node_version=$11,
          python_version=$12, auto_deploy=$13, release_retention=$14,
          updated_at=now()
         WHERE project_id=$1`,
        [
          projectId,
          settings.gitUrl ?? null,
          settings.gitRef,
          settings.installCommand ?? null,
          settings.buildCommand ?? null,
          settings.outputDirectory ?? null,
          settings.startCommand ?? null,
          settings.servicePort ?? null,
          settings.healthCheckPath,
          settings.spaFallback,
          settings.nodeVersion ?? null,
          settings.pythonVersion ?? null,
          settings.autoDeploy,
          settings.releaseRetention,
        ],
      );
    });
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "project.update",
      targetType: "project",
      targetId: projectId,
      metadata: { fields: Object.keys(input) },
    });
    return this.get(actor, projectId);
  }

  private async verifyDomainDns(hostname: string): Promise<boolean> {
    const platformHost = new URL(this.publicUrl).hostname;
    const [domainAddresses, platformAddresses] = await Promise.all([
      resolveAddresses(hostname),
      resolveAddresses(platformHost),
    ]);
    return addressSetsOverlap(domainAddresses, platformAddresses);
  }

  async verifyDomain(
    actor: Actor,
    projectId: string,
  ): Promise<{ hostname: string; verified: boolean; platformHost: string }> {
    const project = await this.get(actor, projectId);
    if (!project.primaryHostname) {
      throw new AppError("DOMAIN_NOT_CONFIGURED", "Set a custom domain first");
    }
    const verified = await this.verifyDomainDns(project.primaryHostname);
    await this.database.query(
      "UPDATE project_domains SET verified_at=$3 WHERE project_id=$1 AND hostname=$2",
      [projectId, project.primaryHostname, verified ? new Date() : null],
    );
    return {
      hostname: project.primaryHostname,
      verified,
      platformHost: new URL(this.publicUrl).hostname,
    };
  }

  async setDomain(actor: Actor, projectId: string, hostnameInput: string): Promise<string> {
    const project = await this.get(actor, projectId);
    requireProjectAccess(actor, project.ownerId);
    const hostname = domainToASCII(hostnameInput.trim().toLowerCase().replace(/\.$/, ""));
    if (
      !hostname ||
      hostname.length > 253 ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        hostname,
      )
    ) {
      throw new AppError("INVALID_DOMAIN", "A valid fully-qualified domain name is required");
    }
    const verified = await this.verifyDomainDns(hostname).catch(() => false);
    await withTransaction(this.database, async (client) => {
      await client.query("UPDATE project_domains SET is_primary=false WHERE project_id=$1", [
        projectId,
      ]);
      await client.query(
        `INSERT INTO project_domains(project_id, hostname, is_primary, verified_at)
         VALUES($1,$2,true,$3)
         ON CONFLICT(hostname) DO UPDATE SET project_id=$1, is_primary=true, verified_at=$3`,
        [projectId, hostname, verified ? new Date() : null],
      );
    });
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "project.domain.set",
      targetType: "project",
      targetId: projectId,
      metadata: { hostname, verified },
    });
    return hostname;
  }

  async rotateWebhookSecret(actor: Actor, projectId: string): Promise<string> {
    await this.get(actor, projectId);
    const secret = randomToken(32);
    const encrypted = encryptValue(secret, this.masterKey);
    await this.database.query(
      `UPDATE project_settings SET webhook_secret_ciphertext=$2,webhook_secret_nonce=$3,
       webhook_secret_auth_tag=$4,webhook_secret_key_version=$5,updated_at=now()
       WHERE project_id=$1`,
      [projectId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
    );
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "project.webhook_secret.rotate",
      targetType: "project",
      targetId: projectId,
    });
    return secret;
  }

  async authenticateWebhook(
    projectId: string,
    payload: string,
    signature: string,
  ): Promise<{
    actor: Actor;
    gitUrl: string;
    gitRef: string;
  }> {
    const result = await this.database.query(
      `SELECT p.owner_id,u.username,u.status,s.git_url,s.git_ref,s.auto_deploy,
              s.webhook_secret_ciphertext,s.webhook_secret_nonce,
              s.webhook_secret_auth_tag,s.webhook_secret_key_version
       FROM projects p
       JOIN users u ON u.id=p.owner_id
       JOIN project_settings s ON s.project_id=p.id
       WHERE p.id=$1`,
      [projectId],
    );
    const row = assertFound(result.rows[0], "Project not found");
    if (
      row.status !== "active" ||
      !row.auto_deploy ||
      !row.git_url ||
      !row.webhook_secret_ciphertext
    ) {
      throw new AppError("WEBHOOK_DISABLED", "Automatic deployment webhook is not enabled", 403);
    }
    const secret = decryptValue(
      {
        ciphertext: row.webhook_secret_ciphertext,
        nonce: row.webhook_secret_nonce,
        authTag: row.webhook_secret_auth_tag,
        keyVersion: row.webhook_secret_key_version,
      },
      this.masterKey,
    );
    const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("hex"));
    const supplied = Buffer.from(signature.replace(/^sha256=/, "").toLowerCase());
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature", 401);
    }
    return {
      actor: {
        id: row.owner_id,
        username: row.username,
        isAdmin: false,
        status: row.status,
      },
      gitUrl: row.git_url,
      gitRef: row.git_ref,
    };
  }

  async listEnvironment(actor: Actor, projectId: string): Promise<Array<Record<string, unknown>>> {
    await this.get(actor, projectId);
    const result = await this.database.query(
      `SELECT name, kind, true AS is_set, updated_at
       FROM environment_variables WHERE project_id=$1 ORDER BY name`,
      [projectId],
    );
    return result.rows.map((row) => ({
      name: row.name,
      kind: row.kind,
      isSet: row.is_set,
      updatedAt: row.updated_at,
    }));
  }

  async setEnvironment(
    actor: Actor,
    projectId: string,
    input: { name: string; value: string; kind: "plain" | "secret" },
  ): Promise<void> {
    await this.get(actor, projectId);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.name)) {
      throw new AppError("INVALID_ENV_NAME", "Invalid environment variable name");
    }
    const encrypted = encryptValue(input.value, this.masterKey);
    await this.database.query(
      `INSERT INTO environment_variables
        (project_id,name,kind,ciphertext,nonce,auth_tag,key_version,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(project_id,name) DO UPDATE SET
        kind=excluded.kind,ciphertext=excluded.ciphertext,nonce=excluded.nonce,
        auth_tag=excluded.auth_tag,key_version=excluded.key_version,
        updated_by=excluded.updated_by,updated_at=now()`,
      [
        projectId,
        input.name,
        input.kind,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        encrypted.keyVersion,
        actor.id,
      ],
    );
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "project.environment.set",
      targetType: "project",
      targetId: projectId,
      metadata: { name: input.name, kind: input.kind },
    });
  }

  async deleteEnvironment(actor: Actor, projectId: string, name: string): Promise<void> {
    await this.get(actor, projectId);
    await this.database.query("DELETE FROM environment_variables WHERE project_id=$1 AND name=$2", [
      projectId,
      name,
    ]);
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "project.environment.delete",
      targetType: "project",
      targetId: projectId,
      metadata: { name },
    });
  }

  async transfer(actor: Actor, projectId: string, newOwnerId: string): Promise<void> {
    requireAdmin(actor);
    const owner = await this.database.query(
      "SELECT id FROM users WHERE id=$1 AND status='active'",
      [newOwnerId],
    );
    assertFound(owner.rows[0], "New owner not found or inactive");
    await this.database.query("UPDATE projects SET owner_id=$2, updated_at=now() WHERE id=$1", [
      projectId,
      newOwnerId,
    ]);
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "project.transfer",
      targetType: "project",
      targetId: projectId,
      metadata: { newOwnerId },
    });
  }

  async queueDelete(actor: Actor, projectId: string): Promise<string> {
    await this.get(actor, projectId);
    const result = await this.database.query(
      `INSERT INTO project_operations(project_id,requested_by,kind)
       VALUES($1,$2,'delete') RETURNING id`,
      [projectId, actor.id],
    );
    return result.rows[0].id;
  }

  async getDatabase(actor: Actor, projectId: string): Promise<ProjectDatabaseRecord | null> {
    await this.get(actor, projectId);
    const result = await this.database.query(
      `SELECT db_name, status, error_message, provisioned_at
       FROM project_databases WHERE project_id=$1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      dbName: row.db_name,
      status: row.status,
      errorMessage: row.error_message,
      provisionedAt: row.provisioned_at,
    };
  }

  async queueDatabaseProvision(actor: Actor, projectId: string): Promise<string> {
    await this.get(actor, projectId);
    const identifier = `wdp_${projectId.replaceAll("-", "").slice(0, 12)}`;
    return withTransaction(this.database, async (client) => {
      const existing = await client.query(
        "SELECT status FROM project_databases WHERE project_id=$1 FOR UPDATE",
        [projectId],
      );
      const status = existing.rows[0]?.status;
      if (status === "provisioned") {
        throw new AppError(
          "DATABASE_ALREADY_PROVISIONED",
          "This project already has a database; DATABASE_URL is set as a secret environment variable",
        );
      }
      if (status === "provisioning") {
        throw new AppError("DATABASE_PROVISIONING", "Database provisioning is already queued");
      }
      await client.query(
        `INSERT INTO project_databases(project_id, db_name, db_role, status)
         VALUES($1,$2,$2,'provisioning')
         ON CONFLICT(project_id) DO UPDATE SET status='provisioning', error_message=NULL`,
        [projectId, identifier],
      );
      const operation = await client.query(
        `INSERT INTO project_operations(project_id,requested_by,kind)
         VALUES($1,$2,'db_provision') RETURNING id`,
        [projectId, actor.id],
      );
      return operation.rows[0].id as string;
    }).then(async (operationId) => {
      await writeAudit(this.database, {
        actorUserId: actor.id,
        action: "project.database.provision",
        targetType: "project",
        targetId: projectId,
        metadata: { dbName: identifier },
      });
      return operationId;
    });
  }
}

export interface ProjectDatabaseRecord {
  dbName: string;
  status: "provisioning" | "provisioned" | "failed";
  errorMessage: string | null;
  provisionedAt: Date | null;
}

export async function getProjectForWorker(
  client: Database | DatabaseClient,
  projectId: string,
): Promise<any> {
  const result = await client.query(`${SELECT_PROJECT} WHERE p.id=$1`, [projectId]);
  return assertFound(result.rows[0], "Project not found");
}

export async function resolveAddresses(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => [] as string[]),
    resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

export function addressSetsOverlap(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return false;
  const rightSet = new Set(right);
  return left.some((address) => rightSet.has(address));
}

function validateRelativeDirectory(value: string | null | undefined): void {
  if (!value) return;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("..")) {
    throw new AppError("INVALID_OUTPUT_DIRECTORY", "Output directory must be a safe relative path");
  }
}

function validateHealthPath(value: string): void {
  if (!value.startsWith("/") || value.includes("://") || value.includes("\0")) {
    throw new AppError("INVALID_HEALTH_PATH", "Health check path must begin with /");
  }
}
