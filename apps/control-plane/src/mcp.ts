import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  AppError,
  DeploymentService,
  ProjectService,
  type Config,
  type Database,
} from "@webdeploy/core";
import type { OAuthRuntime } from "./oauth.js";

export function registerMcpRoute(
  app: FastifyInstance,
  dependencies: {
    database: Database;
    config: Config;
    projects: ProjectService;
    deployments: DeploymentService;
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
  },
  actor: any,
  scopes: Set<string>,
): McpServer {
  const server = new McpServer(
    { name: dependencies.config.MCP_SERVER_NAME, version: "0.1.5" },
    {
      instructions:
        "Use get_project before mutating a project. Deployment tools never accept environment variable values. Direct users to the returned settingsUrl for secrets and advanced configuration. Confirm before delete_project or rollback_release.",
    },
  );
  const read = () => requireScope(scopes, "platform:read");
  const projectWrite = () => requireScope(scopes, "projects:write");
  const deploymentWrite = () => requireScope(scopes, "deployments:write");
  const result = (data: Record<string, unknown>, text: string) => ({
    structuredContent: data,
    content: [{ type: "text" as const, text }],
  });

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
        { status: "ok", version: "0.1.5", authenticatedUser: actor.username },
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
          settingsUrl: `${dependencies.config.PUBLIC_URL}/projects/${projectId}/setup`,
        },
        `Project ${project.name} is ${project.status}.`,
      );
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: "Create a project and return its Passkey-protected Dashboard settings URL.",
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        type: z.enum(["static", "node", "python"]).default("static"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, type }) => {
      projectWrite();
      const project = await dependencies.projects.create(actor, { name, type });
      const settingsUrl = `${dependencies.config.PUBLIC_URL}/projects/${project.id}/setup`;
      return result(
        { project, settingsUrl },
        `Created ${project.name}. Continue setup at ${settingsUrl}`,
      );
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
        throw new AppError("GIT_NOT_CONFIGURED", "Configure a Git URL in the Dashboard first");
      }
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
      return result({ deployment }, `Deployment status is ${deployment.status}.`);
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
        "Return the Passkey-protected Dashboard URL for advanced settings and environment variables.",
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

  return server;
}

function requireScope(scopes: Set<string>, scope: string): void {
  if (!scopes.has(scope))
    throw new AppError("SCOPE_REQUIRED", `OAuth scope ${scope} is required`, 403);
}
