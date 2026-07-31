import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  AppError,
  DeploymentService,
  PageService,
  ProjectService,
  pageSitePublicUrl,
  type Config,
  type Database,
  type ProjectRecord,
} from "@webdeploy/core";
import type { OAuthRuntime } from "./oauth.js";

export function registerMcpRoute(
  app: FastifyInstance,
  dependencies: {
    database: Database;
    config: Config;
    projects: ProjectService;
    deployments: DeploymentService;
    pages: PageService;
    oauth: OAuthRuntime;
  },
): void {
  app.all("/mcp", async (request, reply) => {
    let authenticated;
    try {
      authenticated = await dependencies.oauth.authenticateBearer(request);
    } catch (error) {
      reply.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${dependencies.config.MCP_PUBLIC_URL}/.well-known/oauth-protected-resource", scope="platform:read"`,
      );
      throw error;
    }
    const actor = authenticated.actor;
    const scopes = new Set(String(authenticated.token.scope ?? "").split(/\s+/));
    const server = createMcpServer(dependencies, actor, scopes);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    reply.hijack();
    await server.connect(transport as any);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}

function createMcpServer(
  dependencies: {
    config: Config;
    projects: ProjectService;
    deployments: DeploymentService;
    pages: PageService;
  },
  actor: any,
  scopes: Set<string>,
): McpServer {
  const server = new McpServer(
    { name: dependencies.config.MCP_SERVER_NAME, version: "0.1.14" },
    {
      instructions:
        "The full deployment lifecycle is available here: create_project (optionally with settings), configure_project for runtime configuration, set_environment_variables, a deploy tool, then poll get_deployment_status until it reaches a terminal state. Never require the user to open the Dashboard to finish a deployment — it is the owner's read view and manual override, not part of the flow. After a successful deployment always tell the user the public URL (returned by get_deployment_status; configure one with set_custom_domain if missing). Use get_project before mutating a project. Use kind=secret for sensitive environment values; offer the settingsUrl only when the user prefers to enter a secret themselves. Confirm with the user before delete_project or rollback_release. For one-off static pages, prefer publish_page (the built-in Pages site of this account) instead of creating a project per page.",
    },
  );
  const read = () => requireScope(scopes, "platform:read");
  const projectWrite = () => requireScope(scopes, "projects:write");
  const deploymentWrite = () => requireScope(scopes, "deployments:write");
  const result = (data: Record<string, unknown>, text: string) => ({
    structuredContent: data,
    content: [{ type: "text" as const, text }],
  });
  const publicUrl = (project: ProjectRecord) =>
    project.primaryHostname ? `https://${project.primaryHostname}` : null;
  const readiness = (project: ProjectRecord): string => {
    const notes: string[] = [];
    if (project.type !== "static" && !project.settings.startCommand) {
      notes.push("not deployable yet: set startCommand with configure_project");
    }
    if (!project.primaryHostname) {
      notes.push("no public URL yet: set one with set_custom_domain");
    }
    return notes.length ? ` (${notes.join("; ")})` : "";
  };
  const assertDeployable = (project: ProjectRecord) => {
    if (project.type !== "static" && !project.settings.startCommand) {
      throw new AppError(
        "START_COMMAND_REQUIRED",
        `A ${project.type} project needs a start command before it can deploy. Set it with configure_project (startCommand, and usually installCommand and healthCheckPath).`,
      );
    }
  };
  const settingsShape = {
    gitUrl: z.string().min(1).nullish(),
    gitRef: z.string().min(1).optional(),
    installCommand: z.string().min(1).max(2000).nullish(),
    buildCommand: z.string().min(1).max(2000).nullish(),
    outputDirectory: z.string().min(1).max(500).nullish(),
    startCommand: z.string().min(1).max(2000).nullish(),
    servicePort: z.number().int().min(1024).max(65535).nullish(),
    healthCheckPath: z.string().min(1).max(500).optional(),
    spaFallback: z.boolean().optional(),
    nodeVersion: z.string().min(1).max(50).nullish(),
    pythonVersion: z.string().min(1).max(50).nullish(),
    autoDeploy: z.boolean().optional(),
    releaseRetention: z.number().int().min(1).max(50).optional(),
  };
  const definedEntries = <T extends Record<string, unknown>>(
    input: T,
  ): { [K in keyof T]?: Exclude<T[K], undefined> } =>
    Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
      [K in keyof T]?: Exclude<T[K], undefined>;
    };

  server.registerTool(
    "platform_status",
    {
      title: "Get platform status",
      description: "Check whether the WebDeploy control plane is operating.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      read();
      return result(
        { status: "ok", version: "0.1.14", authenticatedUser: actor.username },
        "WebDeploy MCP is operating normally.",
      );
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List projects accessible to the authenticated user.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      read();
      const projects = await dependencies.projects.list(actor);
      return result({ projects }, `Found ${projects.length} accessible projects.`);
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Get project metadata and non-secret settings.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId }) => {
      read();
      const project = await dependencies.projects.get(actor, projectId);
      const environment = await dependencies.projects.listEnvironment(actor, projectId);
      return result(
        {
          project,
          environment,
          publicUrl: publicUrl(project),
          settingsUrl: `${dependencies.config.PUBLIC_URL}/projects/${projectId}/setup`,
        },
        `Project ${project.name} is ${project.status}${readiness(project)}.`,
      );
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description:
        "Create a project, optionally applying runtime settings (git source, install/build/start commands, health check) in the same call.",
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        type: z.enum(["static", "node", "python"]).default("static"),
        ...settingsShape,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, type, ...settings }) => {
      projectWrite();
      let project = await dependencies.projects.create(actor, { name, type });
      const changes = definedEntries(settings);
      if (Object.keys(changes).length > 0) {
        project = await dependencies.projects.update(actor, project.id, changes);
      }
      return result(
        { project, publicUrl: publicUrl(project) },
        `Created ${project.name}${readiness(project)}.`,
      );
    },
  );

  server.registerTool(
    "configure_project",
    {
      title: "Configure project",
      description:
        "Update a project's runtime settings: git source, install/build/start commands, output directory, service port, health check path, SPA fallback, runtime versions, auto-deploy, and release retention. Pass only the fields to change; pass null to clear a field. Changes apply on the next deployment.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        name: z.string().min(1).max(120).optional(),
        type: z.enum(["static", "node", "python"]).optional(),
        ...settingsShape,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId, ...input }) => {
      projectWrite();
      const changes = definedEntries(input);
      if (Object.keys(changes).length === 0) {
        throw new AppError("NO_CHANGES", "Pass at least one field to change");
      }
      const project = await dependencies.projects.update(actor, projectId, changes);
      return result(
        { project, publicUrl: publicUrl(project) },
        `Updated ${Object.keys(changes).join(", ")} on ${project.name}${readiness(project)}. Deploy to apply.`,
      );
    },
  );

  server.registerTool(
    "set_environment_variables",
    {
      title: "Set environment variables",
      description:
        "Create or update environment variables for a project. Use kind=secret for credentials and tokens; values are encrypted at rest and never readable back through any API. Changes apply on the next deployment or restart.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        variables: z
          .array(
            z.object({
              name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
              value: z.string().max(10000),
              kind: z.enum(["plain", "secret"]).default("plain"),
            }),
          )
          .min(1)
          .max(50),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId, variables }) => {
      projectWrite();
      for (const variable of variables) {
        await dependencies.projects.setEnvironment(actor, projectId, variable);
      }
      const names = variables.map((variable) => variable.name);
      return result(
        { set: names },
        `Set ${names.join(", ")}. Deploy or restart the project to apply.`,
      );
    },
  );

  server.registerTool(
    "delete_environment_variable",
    {
      title: "Delete environment variable",
      description: "Delete one environment variable from a project.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        name: z.string().min(1).max(128),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectId, name }) => {
      projectWrite();
      await dependencies.projects.deleteEnvironment(actor, projectId, name);
      return result({ deleted: name }, `Deleted ${name}. Deploy or restart the project to apply.`);
    },
  );

  server.registerTool(
    "deploy_project",
    {
      title: "Deploy configured project",
      description:
        "Deploy a project from the Git repository already saved in its Dashboard settings.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId }) => {
      deploymentWrite();
      const project = await dependencies.projects.get(actor, projectId);
      if (!project.settings.gitUrl) {
        throw new AppError(
          "GIT_NOT_CONFIGURED",
          "Set the project's gitUrl with configure_project first, or use deploy_from_git",
        );
      }
      assertDeployable(project);
      const deploymentId = await dependencies.deployments.create(actor, projectId, {
        sourceKind: "git",
        sourceSpec: { url: project.settings.gitUrl, ref: project.settings.gitRef },
      });
      return result({ deploymentId, status: "queued" }, `Deployment ${deploymentId} was queued.`);
    },
  );

  server.registerTool(
    "deploy_from_git",
    {
      title: "Deploy from Git",
      description:
        "Deploy a project from an HTTPS or SSH Git repository and optional branch, tag, or commit.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        url: z.string().min(1),
        ref: z.string().min(1).default("main"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, url, ref }) => {
      deploymentWrite();
      assertDeployable(await dependencies.projects.get(actor, projectId));
      const deploymentId = await dependencies.deployments.create(actor, projectId, {
        sourceKind: "git",
        sourceSpec: { url, ref },
      });
      return result({ deploymentId, status: "queued" }, `Deployment ${deploymentId} was queued.`);
    },
  );

  server.registerTool(
    "deploy_inline_files",
    {
      title: "Deploy inline files",
      description:
        "Deploy up to 100 small website files totaling no more than 1 MiB. Never include secrets.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              content: z.string(),
              encoding: z.enum(["utf8", "base64"]).default("utf8"),
            }),
          )
          .min(1)
          .max(100),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, files }) => {
      deploymentWrite();
      assertDeployable(await dependencies.projects.get(actor, projectId));
      const deploymentId = await dependencies.deployments.create(actor, projectId, {
        sourceKind: "inline",
        sourceSpec: { files },
      });
      return result({ deploymentId, status: "queued" }, `Deployment ${deploymentId} was queued.`);
    },
  );

  server.registerTool(
    "get_deployment_status",
    {
      title: "Get deployment status",
      description: "Get the current state and result of a deployment.",
      inputSchema: z.object({ deploymentId: z.string().uuid() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ deploymentId }) => {
      read();
      const deployment = await dependencies.deployments.get(actor, deploymentId);
      if (deployment.status !== "succeeded") {
        return result({ deployment }, `Deployment status is ${deployment.status}.`);
      }
      const project = await dependencies.projects.get(actor, deployment.projectId as string);
      const url = publicUrl(project);
      return result(
        { deployment, publicUrl: url },
        url
          ? `Deployment succeeded. ${project.name} is live at ${url} — tell the user this URL.`
          : `Deployment succeeded, but ${project.name} has no domain yet. Use set_custom_domain, then tell the user the URL.`,
      );
    },
  );

  server.registerTool(
    "get_deployment_logs",
    {
      title: "Get deployment logs",
      description: "Read redacted deployment logs. Environment variable values are never returned.",
      inputSchema: z.object({
        deploymentId: z.string().uuid(),
        afterId: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ deploymentId, afterId, limit }) => {
      read();
      const logs = await dependencies.deployments.logs(actor, deploymentId, afterId, limit);
      return result({ logs }, `Returned ${logs.length} log entries.`);
    },
  );

  server.registerTool(
    "list_releases",
    {
      title: "List releases",
      description: "List retained releases for a project.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId }) => {
      read();
      const releases = await dependencies.deployments.releases(actor, projectId);
      return result({ releases }, `Found ${releases.length} releases.`);
    },
  );

  server.registerTool(
    "rollback_release",
    {
      title: "Rollback release",
      description: "Atomically make a retained successful release active.",
      inputSchema: z.object({ projectId: z.string().uuid(), releaseId: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ projectId, releaseId }) => {
      deploymentWrite();
      const operationId = await dependencies.deployments.rollback(actor, projectId, releaseId);
      return result({ operationId, status: "queued" }, `Rollback ${operationId} was queued.`);
    },
  );

  server.registerTool(
    "restart_project",
    {
      title: "Restart project",
      description: "Restart the active dynamic project process under PM2.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId }) => {
      deploymentWrite();
      const operationId = await dependencies.deployments.restart(actor, projectId);
      return result({ operationId, status: "queued" }, `Restart ${operationId} was queued.`);
    },
  );

  server.registerTool(
    "get_project_settings_url",
    {
      title: "Get project settings URL",
      description:
        "Return the Passkey-protected Dashboard URL where the owner can review this project and manually override settings. Not required for deployment; every setting is also writable via configure_project and set_environment_variables.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId }) => {
      read();
      await dependencies.projects.get(actor, projectId);
      const settingsUrl = `${dependencies.config.PUBLIC_URL}/projects/${projectId}/setup`;
      return result({ settingsUrl }, `Open ${settingsUrl} to continue configuration.`);
    },
  );

  server.registerTool(
    "set_custom_domain",
    {
      title: "Set custom domain",
      description: "Set a project's primary domain. HTTPS issuance occurs after DNS validation.",
      inputSchema: z.object({ projectId: z.string().uuid(), hostname: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, hostname }) => {
      projectWrite();
      const normalized = await dependencies.projects.setDomain(actor, projectId, hostname);
      return result(
        { hostname: normalized, httpsStatus: "pending" },
        `Domain ${normalized} was saved. Complete DNS validation in the Dashboard.`,
      );
    },
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete project",
      description:
        "Queue deletion of a project, its processes, releases, domains, and encrypted settings.",
      inputSchema: z.object({ projectId: z.string().uuid(), confirmName: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ projectId, confirmName }) => {
      projectWrite();
      const project = await dependencies.projects.get(actor, projectId);
      if (confirmName !== project.name) {
        throw new AppError(
          "CONFIRMATION_MISMATCH",
          "confirmName must exactly match the project name",
        );
      }
      const operationId = await dependencies.projects.queueDelete(actor, projectId);
      return result({ operationId, status: "queued" }, `Deletion ${operationId} was queued.`);
    },
  );

  const siteSummary = (site: { slug: string; name: string; publishedAt: Date | null }) => ({
    slug: site.slug,
    name: site.name,
    publishedAt: site.publishedAt,
    publicUrl: pageSitePublicUrl(dependencies.config.PUBLIC_URL, site.slug),
  });
  const pagesApiUrl = `${dependencies.config.PUBLIC_URL.replace(/\/+$/, "")}/api/pages`;

  server.registerTool(
    "create_page_site",
    {
      title: "Create a Pages site",
      description:
        "Create a directory on the built-in static Pages service. Returns the public URL and a publish token (shown only once) for the token HTTP API.",
      inputSchema: z.object({ name: z.string().min(1).max(120).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      projectWrite();
      const { site, token } = await dependencies.pages.createSite(actor, { name });
      const summary = siteSummary(site);
      return result(
        { site: summary, publishToken: token, publishApiUrl: pagesApiUrl },
        `Created Pages site ${site.slug} at ${summary.publicUrl}. Store the publish token now; it is not shown again.`,
      );
    },
  );

  server.registerTool(
    "list_page_sites",
    {
      title: "List Pages sites",
      description: "List built-in static Pages sites accessible to the authenticated user.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      read();
      const sites = await dependencies.pages.listSites(actor);
      return result({ sites: sites.map(siteSummary) }, `Found ${sites.length} Pages sites.`);
    },
  );

  server.registerTool(
    "publish_page",
    {
      title: "Publish static page files",
      description:
        "Publish small static files to the built-in Pages service without creating a project. Omit siteSlug to use (or create) this account's default site. Set clean=true to replace the whole site.",
      inputSchema: z.object({
        siteSlug: z.string().min(1).max(48).optional(),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              content: z.string(),
              encoding: z.enum(["utf8", "base64"]).default("utf8"),
            }),
          )
          .min(1)
          .max(100),
        clean: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ siteSlug, files, clean }) => {
      deploymentWrite();
      const target = siteSlug
        ? { site: await dependencies.pages.getSite(actor, siteSlug), token: undefined }
        : await dependencies.pages.defaultSite(actor);
      const published = await dependencies.pages.publishFiles(target.site, files, { clean });
      const summary = siteSummary(target.site);
      return result(
        {
          site: summary,
          ...published,
          ...(target.token ? { publishToken: target.token, publishApiUrl: pagesApiUrl } : {}),
        },
        `Published ${published.fileCount} files to ${summary.publicUrl}` +
          (target.token
            ? ". A default Pages site was created; store the publish token now, it is not shown again."
            : "."),
      );
    },
  );

  server.registerTool(
    "rotate_page_token",
    {
      title: "Rotate a Pages publish token",
      description: "Invalidate the current publish token of a Pages site and return a new one.",
      inputSchema: z.object({ siteSlug: z.string().min(1).max(48) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ siteSlug }) => {
      projectWrite();
      const { site, token } = await dependencies.pages.rotateToken(actor, siteSlug);
      return result(
        { site: siteSummary(site), publishToken: token, publishApiUrl: pagesApiUrl },
        `Rotated the publish token for ${site.slug}. Store it now; it is not shown again.`,
      );
    },
  );

  server.registerTool(
    "delete_page_site",
    {
      title: "Delete a Pages site",
      description: "Delete a Pages site, its publish token, and all of its published files.",
      inputSchema: z.object({
        siteSlug: z.string().min(1).max(48),
        confirmSlug: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ siteSlug, confirmSlug }) => {
      projectWrite();
      if (confirmSlug !== siteSlug) {
        throw new AppError("CONFIRMATION_MISMATCH", "confirmSlug must exactly match siteSlug");
      }
      await dependencies.pages.deleteSite(actor, siteSlug);
      return result({ deleted: siteSlug }, `Deleted Pages site ${siteSlug}.`);
    },
  );

  return server;
}

function requireScope(scopes: Set<string>, scope: string): void {
  if (!scopes.has(scope))
    throw new AppError("SCOPE_REQUIRED", `OAuth scope ${scope} is required`, 403);
}
