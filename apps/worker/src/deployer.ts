import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  decryptValue,
  getProjectForWorker,
  redactText,
  withTransaction,
  type Config,
  type Database,
} from "@webdeploy/core";
import { assertSafeArchiveEntry, projectProcessName, safeChild } from "./paths.js";
import { runAsUser, runCommand, runUserDatabaseCommand } from "./command.js";
import {
  PROJECT_USERS_GROUP,
  ensureProjectUsersGroup,
  ensureUserInProjectsGroup,
} from "./hardening.js";
import { dropProjectDatabase, provisionProjectDatabase } from "./databases.js";
import {
  activateAppNginxConfig,
  activateNginxConfig,
  removeAppNginxConfig,
  removeNginxConfig,
  renderNginxAppLocation,
  renderNginxProject,
} from "./nginx.js";
import { restartReleaseProcess, startReleaseProcess, stopReleaseProcess } from "./pm2.js";

export class Deployer {
  constructor(
    private readonly database: Database,
    private readonly config: Config,
    private readonly masterKey: Buffer,
    private readonly workerId: string,
  ) {}

  async runDeployment(deploymentId: string): Promise<void> {
    const deployment = (
      await this.database.query("SELECT * FROM deployments WHERE id=$1", [deploymentId])
    ).rows[0];
    if (!deployment) throw new Error("Deployment disappeared");
    const project = await getProjectForWorker(this.database, deployment.project_id);
    const oldReleaseId = project.current_release_id as string | null;
    let releaseId: string | undefined;
    try {
      await this.status(deploymentId, "preparing");
      const { osUser, projectRoot } = await this.ensureProjectUser(project);
      const release = await this.database.query(
        `INSERT INTO releases(project_id,deployment_id,path,status)
         VALUES($1,$2,'pending','candidate') RETURNING id`,
        [project.id, deploymentId],
      );
      const createdReleaseId = release.rows[0]?.id as string | undefined;
      if (!createdReleaseId) throw new Error("Unable to create release record");
      releaseId = createdReleaseId;
      const releaseRoot = safeChild(projectRoot, "releases", createdReleaseId);
      await this.database.query("UPDATE releases SET path=$2 WHERE id=$1", [
        createdReleaseId,
        releaseRoot,
      ]);
      await mkdir(releaseRoot, { recursive: true, mode: 0o750 });
      await runCommand("chown", ["-R", `${osUser}:${osUser}`, releaseRoot]);

      await this.status(deploymentId, "fetching");
      const revision = await this.prepareSource(deployment, releaseRoot, osUser);
      const env = await this.loadEnvironment(project.id);
      const runtime = this.runtimeCommandPrefix(project);
      if (project.install_command) {
        await this.status(deploymentId, "installing");
        await this.runBuildCommand(
          osUser,
          releaseRoot,
          `${runtime}${project.install_command}`,
          env,
          deploymentId,
        );
      }
      if (project.build_command) {
        await this.status(deploymentId, "building");
        await this.runBuildCommand(
          osUser,
          releaseRoot,
          `${runtime}${project.build_command}`,
          env,
          deploymentId,
        );
      }

      let port: number | null = null;
      if (project.type === "static") {
        const outputPath = safeChild(releaseRoot, project.output_directory || ".");
        const stats = await lstat(outputPath).catch(() => null);
        if (!stats?.isDirectory())
          throw new Error("Configured static output directory does not exist");
        const entries = await readdir(outputPath);
        if (!entries.length) throw new Error("Static output directory is empty");
        await this.grantNginxReadAccess(projectRoot, releaseRoot, outputPath);
        await this.status(deploymentId, "health_checking");
      } else {
        if (!project.start_command) throw new Error("Dynamic project requires a start command");
        port = await this.allocatePort(project.id, createdReleaseId, project.service_port);
        await this.status(deploymentId, "starting_candidate");
        await startReleaseProcess({
          config: this.config,
          projectId: project.id,
          releaseId: createdReleaseId,
          osUser,
          cwd: releaseRoot,
          startCommand: `${runtime}${project.start_command}`,
          environment: this.applicationEnvironment(osUser, projectRoot, port, env.values),
          knownSecrets: env.secrets,
        });
        await this.status(deploymentId, "health_checking");
        await waitForHealth(port, project.health_check_path, 45_000);
      }

      await this.status(deploymentId, "activating");
      await this.activateRelease(project, createdReleaseId, releaseRoot, port);
      await withTransaction(this.database, async (client) => {
        if (oldReleaseId) {
          await client.query("UPDATE releases SET status='inactive',stopped_at=now() WHERE id=$1", [
            oldReleaseId,
          ]);
        }
        await client.query(
          `UPDATE releases SET status='active',port=$2,source_revision=$3,activated_at=now()
           WHERE id=$1`,
          [createdReleaseId, port, revision],
        );
        await client.query(
          "UPDATE projects SET current_release_id=$2,status='active',updated_at=now() WHERE id=$1",
          [project.id, createdReleaseId],
        );
        await client.query(
          `UPDATE deployments SET status='succeeded',release_id=$2,finished_at=now()
           WHERE id=$1`,
          [deploymentId, createdReleaseId],
        );
        await client.query("DELETE FROM deployment_jobs WHERE deployment_id=$1", [deploymentId]);
      });
      if (oldReleaseId && project.type !== "static") {
        await stopReleaseProcess(this.config, project.id, oldReleaseId);
      }
      await this.pruneReleases(project.id, createdReleaseId, project.release_retention);
      await this.log(deploymentId, "system", `Release ${createdReleaseId} activated successfully.`);
    } catch (error) {
      if (releaseId) {
        await stopReleaseProcess(this.config, project.id, releaseId).catch(() => undefined);
        await this.database.query("DELETE FROM project_ports WHERE release_id=$1", [releaseId]);
        await this.database.query("UPDATE releases SET status='failed' WHERE id=$1", [releaseId]);
      }
      const message = redactText(error instanceof Error ? error.message : String(error));
      await this.database.query(
        `UPDATE deployments SET status='failed',error_code='DEPLOYMENT_FAILED',
          error_message=$2,finished_at=now() WHERE id=$1`,
        [deploymentId, message.slice(0, 4000)],
      );
      await this.database.query("DELETE FROM deployment_jobs WHERE deployment_id=$1", [
        deploymentId,
      ]);
      await this.log(deploymentId, "system", `Deployment failed: ${message}`);
      throw error;
    }
  }

  async runOperation(operationId: string): Promise<void> {
    const operation = (
      await this.database.query("SELECT * FROM project_operations WHERE id=$1", [operationId])
    ).rows[0];
    if (!operation) return;
    const project = await getProjectForWorker(this.database, operation.project_id);
    try {
      await this.database.query(
        "UPDATE project_operations SET status='running',started_at=now() WHERE id=$1",
        [operationId],
      );
      if (operation.kind === "restart") await this.restartProject(project);
      else if (operation.kind === "rollback") {
        await this.rollbackProject(project, operation.target_release_id);
      } else if (operation.kind === "db_provision") {
        await provisionProjectDatabase(this.database, this.config, this.masterKey, project);
      } else await this.deleteProject(project);
      await this.database.query(
        "UPDATE project_operations SET status='succeeded',finished_at=now() WHERE id=$1",
        [operationId],
      );
    } catch (error) {
      await this.database.query(
        `UPDATE project_operations SET status='failed',error_message=$2,finished_at=now()
         WHERE id=$1`,
        [
          operationId,
          redactText(error instanceof Error ? error.message : String(error)).slice(0, 4000),
        ],
      );
      throw error;
    }
  }

  async reconcileActiveProjects(): Promise<void> {
    const result = await this.database.query(
      `SELECT p.id FROM projects p
       JOIN releases r ON r.id=p.current_release_id
       WHERE p.type!='static' AND p.status='active'`,
    );
    for (const row of result.rows) {
      const project = await getProjectForWorker(this.database, row.id);
      const name = projectProcessName(project.id, project.current_release_id);
      const list = await runCommand("pm2", ["jlist"], {
        env: { ...process.env, PM2_HOME: this.config.PM2_HOME },
      }).catch(() => ({ stdout: "[]", stderr: "", code: 1 }));
      const processes = JSON.parse(list.stdout || "[]") as Array<any>;
      if (!processes.some((item) => item.name === name)) {
        await this.restartProject(project, true);
      }
    }
  }

  private async prepareSource(
    deployment: any,
    releaseRoot: string,
    osUser: string,
  ): Promise<string | null> {
    const source = deployment.source_spec;
    if (deployment.source_kind === "git") {
      await rm(releaseRoot, { recursive: true, force: true });
      await runCommand(
        "git",
        ["clone", "--no-checkout", "--filter=blob:none", source.url, releaseRoot],
        {
          timeoutMs: 300_000,
          onOutput: (stream, text) => this.log(deployment.id, stream, text),
        },
      );
      await runCommand("chown", ["-R", `${osUser}:${osUser}`, releaseRoot]);
      await runAsUser(osUser, `git checkout --detach --force ${shellQuote(source.ref || "main")}`, {
        cwd: releaseRoot,
        timeoutMs: 120_000,
        onOutput: (stream, text) => this.log(deployment.id, stream, text),
      });
      const revision = await runAsUser(osUser, "git rev-parse HEAD", { cwd: releaseRoot });
      return revision.stdout.trim();
    }
    if (deployment.source_kind === "archive") {
      await this.extractArchive(source.path, releaseRoot, osUser, deployment.id);
      return null;
    }
    for (const file of source.files as Array<any>) {
      assertSafeArchiveEntry(file.path);
      const path = safeChild(releaseRoot, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content,
        { mode: 0o640 },
      );
    }
    await runCommand("chown", ["-R", `${osUser}:${osUser}`, releaseRoot]);
    return null;
  }

  private async extractArchive(
    archivePath: string,
    releaseRoot: string,
    osUser: string,
    deploymentId: string,
  ): Promise<void> {
    const lower = archivePath.toLowerCase();
    const zip = lower.endsWith(".zip");
    const listing = zip
      ? await runCommand("unzip", ["-Z1", archivePath], { timeoutMs: 30_000 })
      : await runCommand("tar", ["-tf", archivePath], { timeoutMs: 30_000 });
    for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean))
      assertSafeArchiveEntry(entry);
    const args = zip
      ? ["-q", archivePath, "-d", releaseRoot]
      : ["-xf", archivePath, "-C", releaseRoot, "--no-same-owner", "--no-same-permissions"];
    await runCommand(zip ? "unzip" : "tar", args, {
      timeoutMs: 300_000,
      onOutput: (stream, text) => this.log(deploymentId, stream, text),
    });
    await this.rejectEscapingSymlinks(releaseRoot);
    await runCommand("chown", ["-R", `${osUser}:${osUser}`, releaseRoot]);
    await rm(archivePath, { force: true });
  }

  private async rejectEscapingSymlinks(root: string): Promise<void> {
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await readlink(path).catch(() => "");
          if (target.startsWith("/") || target.includes(".."))
            throw new Error("Archive contains unsafe symlink");
        } else if (entry.isDirectory()) await visit(path);
      }
    };
    await visit(root);
  }

  private async ensureProjectUser(project: any): Promise<{ osUser: string; projectRoot: string }> {
    const osUser = project.os_user || `wdp-${project.id.replaceAll("-", "").slice(0, 12)}`;
    const projectsRoot = safeChild(this.config.DATA_DIR, "projects");
    const projectRoot = safeChild(this.config.DATA_DIR, "projects", project.id);
    await mkdir(safeChild(projectRoot, "releases"), { recursive: true, mode: 0o750 });
    // Project users and Nginx need traversal, but must not be able to list other project IDs.
    await chmod(projectsRoot, 0o711);
    if (!project.os_user) {
      const exists = await runCommand("id", ["-u", osUser]).then(
        () => true,
        () => false,
      );
      if (!exists) {
        await ensureProjectUsersGroup();
        await runUserDatabaseCommand("useradd", [
          "--system",
          "--user-group",
          "--groups",
          PROJECT_USERS_GROUP,
          "--home-dir",
          projectRoot,
          "--shell",
          "/usr/sbin/nologin",
          osUser,
        ]);
      }
      await runCommand("chown", ["-R", `${osUser}:${osUser}`, projectRoot]);
      await chmod(projectRoot, 0o750);
      await this.database.query("UPDATE projects SET os_user=$2 WHERE id=$1", [project.id, osUser]);
    }
    // Users created by earlier releases predate the SSH deny group.
    await ensureUserInProjectsGroup(osUser);
    return { osUser, projectRoot };
  }

  private async loadEnvironment(projectId: string): Promise<{
    values: NodeJS.ProcessEnv;
    secrets: string[];
  }> {
    const result = await this.database.query(
      `SELECT name,kind,ciphertext,nonce,auth_tag,key_version
       FROM environment_variables WHERE project_id=$1`,
      [projectId],
    );
    const values: NodeJS.ProcessEnv = {};
    const secrets: string[] = [];
    for (const row of result.rows) {
      const value = decryptValue(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authTag: row.auth_tag,
          keyVersion: row.key_version,
        },
        this.masterKey,
      );
      values[row.name] = value;
      if (row.kind === "secret") secrets.push(value);
    }
    return { values, secrets };
  }

  private async grantNginxReadAccess(
    projectRoot: string,
    releaseRoot: string,
    outputPath: string,
  ): Promise<void> {
    const releasesRoot = safeChild(projectRoot, "releases");
    // Supported Debian and Ubuntu installations run Nginx workers as www-data.
    // Only the published static output and its traversal path are shared with that group.
    await runCommand("chgrp", ["www-data", projectRoot, releasesRoot, releaseRoot]);
    await runCommand("chmod", ["g+rx", projectRoot, releasesRoot, releaseRoot]);
    await runCommand("chgrp", ["-R", "www-data", outputPath]);
    await runCommand("chmod", ["-R", "g+rX", outputPath]);
  }

  private runtimeCommandPrefix(project: any): string {
    if (this.config.RUNTIME_MANAGER !== "mise") return "";
    const tools = [
      project.node_version ? `node@${shellQuote(project.node_version)}` : "",
      project.python_version ? `python@${shellQuote(project.python_version)}` : "",
    ].filter(Boolean);
    return tools.length ? `mise exec ${tools.join(" ")} -- ` : "";
  }

  private applicationEnvironment(
    osUser: string,
    projectRoot: string,
    port: number,
    values: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    return {
      ...values,
      HOME: projectRoot,
      USER: osUser,
      LOGNAME: osUser,
      SHELL: "/bin/bash",
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
    };
  }

  private async runBuildCommand(
    osUser: string,
    cwd: string,
    command: string,
    environment: { values: NodeJS.ProcessEnv; secrets: string[] },
    deploymentId: string,
  ): Promise<void> {
    await runAsUser(osUser, command, {
      cwd,
      env: { ...process.env, ...environment.values },
      timeoutMs: 900_000,
      knownSecrets: environment.secrets,
      onOutput: (stream, text) => this.log(deploymentId, stream, text),
    });
  }

  private async allocatePort(
    projectId: string,
    releaseId: string,
    preferredPort?: number | null,
  ): Promise<number> {
    return withTransaction(this.database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(937421)");
      if (
        preferredPort &&
        preferredPort >= this.config.PORT_RANGE_START &&
        preferredPort <= this.config.PORT_RANGE_END
      ) {
        const preferred = await client.query(
          "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM project_ports WHERE port=$1)",
          [preferredPort],
        );
        if (preferred.rowCount) {
          await client.query(
            "INSERT INTO project_ports(port,project_id,release_id) VALUES($1,$2,$3)",
            [preferredPort, projectId, releaseId],
          );
          return preferredPort;
        }
      }
      const result = await client.query(
        `SELECT candidate FROM generate_series($1::int,$2::int) candidate
         WHERE NOT EXISTS (SELECT 1 FROM project_ports WHERE port=candidate)
         ORDER BY candidate LIMIT 1`,
        [this.config.PORT_RANGE_START, this.config.PORT_RANGE_END],
      );
      const port = result.rows[0]?.candidate;
      if (!port) throw new Error("No deployment ports are available");
      await client.query("INSERT INTO project_ports(port,project_id,release_id) VALUES($1,$2,$3)", [
        port,
        projectId,
        releaseId,
      ]);
      return Number(port);
    });
  }

  private async activateRelease(
    project: any,
    releaseId: string,
    releaseRoot: string,
    port: number | null,
  ): Promise<void> {
    const projectRoot = safeChild(this.config.DATA_DIR, "projects", project.id);
    const current = safeChild(projectRoot, "current");
    const candidate = safeChild(projectRoot, `.current-${releaseId}`);
    const staticRoot = safeChild(releaseRoot, project.output_directory || ".");
    if (project.type === "static") {
      await symlink(staticRoot, candidate, "dir");
      await rename(candidate, current);
    }
    const appContent = renderNginxAppLocation({
      appBasePath: this.config.APP_BASE_PATH,
      slug: project.slug,
      projectId: project.id,
      type: project.type,
      currentPath: current,
      port,
      spaFallback: project.spa_fallback,
    });
    await activateAppNginxConfig(this.config, project.id, appContent);
    const domain = (
      await this.database.query(
        "SELECT hostname FROM project_domains WHERE project_id=$1 AND is_primary=true",
        [project.id],
      )
    ).rows[0]?.hostname;
    if (domain) {
      const content = renderNginxProject({
        hostname: domain,
        projectId: project.id,
        type: project.type,
        currentPath: current,
        port,
        spaFallback: project.spa_fallback,
      });
      await activateNginxConfig(this.config, project.id, domain, content);
    }
  }

  private async restartProject(project: any, reconcile = false): Promise<void> {
    if (project.type === "static" || !project.current_release_id) return;
    const env = await this.loadEnvironment(project.id);
    const release = (
      await this.database.query("SELECT * FROM releases WHERE id=$1", [project.current_release_id])
    ).rows[0];
    if (!release) throw new Error("Active release not found");
    const projectRoot = dirname(dirname(release.path));
    const applicationEnvironment = this.applicationEnvironment(
      project.os_user,
      projectRoot,
      release.port,
      env.values,
    );
    if (reconcile) {
      await startReleaseProcess({
        config: this.config,
        projectId: project.id,
        releaseId: release.id,
        osUser: project.os_user,
        cwd: release.path,
        startCommand: `${this.runtimeCommandPrefix(project)}${project.start_command}`,
        environment: applicationEnvironment,
        knownSecrets: env.secrets,
      });
    } else {
      await restartReleaseProcess({
        config: this.config,
        projectId: project.id,
        releaseId: project.current_release_id,
        osUser: project.os_user,
        cwd: release.path,
        startCommand: `${this.runtimeCommandPrefix(project)}${project.start_command}`,
        environment: applicationEnvironment,
        knownSecrets: env.secrets,
      });
    }
  }

  private async rollbackProject(project: any, releaseId: string): Promise<void> {
    const release = (
      await this.database.query(
        "SELECT * FROM releases WHERE id=$1 AND project_id=$2 AND status IN ('active','inactive')",
        [releaseId, project.id],
      )
    ).rows[0];
    if (!release) throw new Error("Rollback release not found");
    const oldReleaseId = project.current_release_id;
    if (project.type !== "static") {
      const env = await this.loadEnvironment(project.id);
      await startReleaseProcess({
        config: this.config,
        projectId: project.id,
        releaseId,
        osUser: project.os_user,
        cwd: release.path,
        startCommand: `${this.runtimeCommandPrefix(project)}${project.start_command}`,
        environment: this.applicationEnvironment(
          project.os_user,
          dirname(dirname(release.path)),
          release.port,
          env.values,
        ),
        knownSecrets: env.secrets,
      });
      await waitForHealth(release.port, project.health_check_path, 45_000);
    }
    await this.activateRelease(project, releaseId, release.path, release.port);
    await withTransaction(this.database, async (client) => {
      await client.query("UPDATE releases SET status='inactive' WHERE id=$1", [oldReleaseId]);
      await client.query(
        "UPDATE releases SET status='active',activated_at=now(),stopped_at=NULL WHERE id=$1",
        [releaseId],
      );
      await client.query("UPDATE projects SET current_release_id=$2,updated_at=now() WHERE id=$1", [
        project.id,
        releaseId,
      ]);
    });
    if (oldReleaseId && project.type !== "static") {
      await stopReleaseProcess(this.config, project.id, oldReleaseId);
    }
  }

  private async deleteProject(project: any): Promise<void> {
    const releases = await this.database.query("SELECT id FROM releases WHERE project_id=$1", [
      project.id,
    ]);
    for (const release of releases.rows) {
      await stopReleaseProcess(this.config, project.id, release.id);
    }
    await removeAppNginxConfig(this.config, project.id);
    await removeNginxConfig(this.config, project.id);
    await dropProjectDatabase(this.database, project.id);
    const projectRoot = safeChild(this.config.DATA_DIR, "projects", project.id);
    if (existsSync(projectRoot)) await rm(projectRoot, { recursive: true, force: true });
    if (project.os_user) {
      await runUserDatabaseCommand("userdel", [project.os_user]).catch(() => undefined);
    }
    await this.database.query("DELETE FROM projects WHERE id=$1", [project.id]);
  }

  private async pruneReleases(
    projectId: string,
    currentReleaseId: string,
    retention: number,
  ): Promise<void> {
    const stale = await this.database.query(
      `SELECT id,path FROM releases WHERE project_id=$1 AND id!=$2 AND status='inactive'
       ORDER BY sequence DESC OFFSET $3`,
      [projectId, currentReleaseId, Math.max(0, retention - 1)],
    );
    for (const release of stale.rows) {
      await stopReleaseProcess(this.config, projectId, release.id);
      const root = safeChild(this.config.DATA_DIR, "projects", projectId);
      const path = safeChild(root, "releases", release.id);
      if (release.path === path && existsSync(path))
        await rm(path, { recursive: true, force: true });
      await this.database.query("DELETE FROM releases WHERE id=$1", [release.id]);
    }
  }

  private async status(deploymentId: string, status: string): Promise<void> {
    await this.database.query(
      `UPDATE deployments SET status=$2,
       started_at=CASE WHEN started_at IS NULL THEN now() ELSE started_at END WHERE id=$1`,
      [deploymentId, status],
    );
    await this.log(deploymentId, "system", `State: ${status}`);
  }

  private async log(
    deploymentId: string,
    stream: "system" | "stdout" | "stderr",
    message: string,
  ): Promise<void> {
    const text = redactText(message).slice(0, 64_000);
    if (!text) return;
    await this.database.query(
      "INSERT INTO deployment_logs(deployment_id,stream,message) VALUES($1,$2,$3)",
      [deploymentId, stream, text],
    );
  }
}

async function waitForHealth(port: number, healthPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
        signal: AbortSignal.timeout(3_000),
        redirect: "manual",
      });
      if (response.status >= 200 && response.status < 400) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Health check timed out: ${lastError}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
