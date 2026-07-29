import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { deriveMcpServerName } from "../../packages/core/src/mcp-install";

const externalBaseUrl = (process.env.TEST_BASE_URL ?? "http://localhost:3847").replace(/\/+$/, "");
const externalBasePath = new URL(externalBaseUrl).pathname.replace(/\/+$/, "");

function publicPath(path: string): string {
  return `${externalBasePath}${path.startsWith("/") ? path : `/${path}`}` || "/";
}

async function addVirtualPasskey(context: BrowserContext) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return page;
}

function cli(...args: string[]): string {
  const sshHost = process.env.TEST_CLI_SSH_HOST;
  if (sshHost) {
    const envFile = process.env.TEST_CLI_ENV_FILE ?? "/etc/webdeploy/webdeploy.env";
    const cliPath = process.env.TEST_CLI_PATH ?? "/opt/webdeploy/current/apps/cli/dist/index.js";
    return execFileSync(
      "ssh",
      [sshHost, "env", `WEBDEPLOY_ENV_FILE=${envFile}`, "node", cliPath, ...args],
      { encoding: "utf8" },
    );
  }
  return execFileSync(process.execPath, ["apps/cli/dist/index.js", ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
}

function ssh(...args: string[]): string {
  const sshHost = process.env.TEST_CLI_SSH_HOST;
  if (!sshHost) throw new Error("TEST_CLI_SSH_HOST is required for server deployment tests");
  return execFileSync("ssh", [sshHost, ...args], { encoding: "utf8" });
}

async function mcpTool(
  request: APIRequestContext,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const response = await request.post(publicPath("/mcp"), {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    data: {
      jsonrpc: "2.0",
      id: `${name}-${Date.now()}`,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  expect(body.error, JSON.stringify(body)).toBeUndefined();
  expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
  return body.result?.structuredContent;
}

async function waitForDeployment(
  request: APIRequestContext,
  accessToken: string,
  deploymentId: string,
  terminalStatus: "succeeded" | "failed",
): Promise<any> {
  await expect
    .poll(
      async () => {
        const result = await mcpTool(request, accessToken, "get_deployment_status", {
          deploymentId,
        });
        return result.deployment.status;
      },
      { timeout: 65_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(terminalStatus);
  return (await mcpTool(request, accessToken, "get_deployment_status", { deploymentId }))
    .deployment;
}

async function waitForCurrentRelease(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
  releaseId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await mcpTool(request, accessToken, "get_project", { projectId });
        return result.project.currentReleaseId;
      },
      { timeout: 65_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(releaseId);
}

async function patchProjectSettings(
  page: Page,
  projectId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const response = await page.evaluate(
    async ({ id, body }) => {
      const session = await fetch(`${basePath}/api/auth/session`).then((result) => result.json());
      const result = await fetch(`${basePath}/api/projects/${id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify(body),
      });
      return { status: result.status, text: await result.text() };
    },
    { id: projectId, body: settings, basePath: externalBasePath },
  );
  expect(response.status, response.text).toBe(200);
}

async function runServerDeploymentScenarios(input: {
  request: APIRequestContext;
  page: Page;
  accessToken: string;
  staticProjectId: string;
}): Promise<void> {
  const { request, page, accessToken, staticProjectId } = input;
  const suffix = Date.now();
  const staticHostname = `static-${suffix}.webdeploy-e2e.invalid`;
  const dynamicHostname = `node-${suffix}.webdeploy-e2e.invalid`;
  const pm2Home = process.env.TEST_PM2_HOME ?? "/var/lib/webdeploy-test/pm2";
  const workerService = process.env.TEST_WORKER_SERVICE ?? "webdeploy-test-worker";
  let dynamicProjectId: string | undefined;
  let dynamicProjectName: string | undefined;

  try {
    await mcpTool(request, accessToken, "set_custom_domain", {
      projectId: staticProjectId,
      hostname: staticHostname,
    });
    const staticDeployment = await mcpTool(request, accessToken, "deploy_inline_files", {
      projectId: staticProjectId,
      files: [{ path: "index.html", content: "<h1>static-release-v1</h1>" }],
    });
    const staticResult = await waitForDeployment(
      request,
      accessToken,
      staticDeployment.deploymentId,
      "succeeded",
    );
    expect(staticResult.releaseId).toBeTruthy();
    expect(
      ssh(
        "curl",
        "-fsS",
        "--resolve",
        `${staticHostname}:80:127.0.0.1`,
        `http://${staticHostname}/`,
      ),
    ).toContain("static-release-v1");

    dynamicProjectName = `Node Deployment E2E ${suffix}`;
    const created = await mcpTool(request, accessToken, "create_project", {
      name: dynamicProjectName,
      type: "node",
    });
    dynamicProjectId = created.project.id;
    await page.goto(publicPath(`/projects/${dynamicProjectId}/setup`));
    await patchProjectSettings(page, dynamicProjectId, {
      startCommand: "node server.js",
      healthCheckPath: "/health",
    });
    await mcpTool(request, accessToken, "set_custom_domain", {
      projectId: dynamicProjectId,
      hostname: dynamicHostname,
    });

    const serverSource = (version: string, healthStatus = 200) => `
const http = require("node:http");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT);
http.createServer((request, response) => {
  if (request.url === "/env-check") {
    const leaked = ["DATABASE_URL", "MASTER_KEY_FILE", "OIDC_JWKS_FILE"].some(
      (name) => process.env[name],
    );
    response.end(leaked ? "platform-environment-leaked" : "isolated-environment");
    return;
  }
  response.statusCode = request.url === "/health" ? ${healthStatus} : 200;
  response.end("${version}");
}).listen(port, host);
`;
    const deployVersion = async (version: string, healthStatus = 200) => {
      const queued = await mcpTool(request, accessToken, "deploy_inline_files", {
        projectId: dynamicProjectId,
        files: [{ path: "server.js", content: serverSource(version, healthStatus) }],
      });
      return queued.deploymentId as string;
    };
    const curlDynamic = (path = "/") =>
      ssh(
        "curl",
        "-fsS",
        "--resolve",
        `${dynamicHostname}:80:127.0.0.1`,
        `http://${dynamicHostname}${path}`,
      );
    const curlDynamicEventually = () => {
      try {
        return curlDynamic();
      } catch {
        return "";
      }
    };

    const v1DeploymentId = await deployVersion("node-release-v1");
    const v1 = await waitForDeployment(request, accessToken, v1DeploymentId, "succeeded");
    expect(curlDynamic()).toContain("node-release-v1");
    expect(curlDynamic("/env-check")).toBe("isolated-environment");

    const v2DeploymentId = await deployVersion("node-release-v2");
    const v2 = await waitForDeployment(request, accessToken, v2DeploymentId, "succeeded");
    expect(curlDynamic()).toContain("node-release-v2");

    const failedDeploymentId = await deployVersion("node-broken-v3", 503);
    await expect
      .poll(
        async () => {
          const result = await mcpTool(request, accessToken, "get_deployment_status", {
            deploymentId: failedDeploymentId,
          });
          return result.deployment.status;
        },
        { timeout: 20_000, intervals: [250, 500, 1_000] },
      )
      .toBe("health_checking");
    expect(curlDynamic()).toContain("node-release-v2");
    const failed = await waitForDeployment(request, accessToken, failedDeploymentId, "failed");
    expect(failed.errorCode).toBe("DEPLOYMENT_FAILED");
    await waitForCurrentRelease(request, accessToken, dynamicProjectId, v2.releaseId);
    expect(curlDynamic()).toContain("node-release-v2");

    await mcpTool(request, accessToken, "rollback_release", {
      projectId: dynamicProjectId,
      releaseId: v1.releaseId,
    });
    await waitForCurrentRelease(request, accessToken, dynamicProjectId, v1.releaseId);
    await expect.poll(curlDynamicEventually, { timeout: 30_000 }).toContain("node-release-v1");

    await mcpTool(request, accessToken, "restart_project", { projectId: dynamicProjectId });
    await expect.poll(curlDynamicEventually, { timeout: 30_000 }).toContain("node-release-v1");

    const processName = `wdp-${dynamicProjectId.replaceAll("-", "").slice(0, 12)}-${String(
      v1.releaseId,
    )
      .replaceAll("-", "")
      .slice(0, 8)}`;
    ssh("env", `PM2_HOME=${pm2Home}`, "pm2", "delete", processName);
    expect(() => curlDynamic()).toThrow();
    ssh("systemctl", "restart", workerService);
    await expect.poll(curlDynamicEventually, { timeout: 45_000 }).toContain("node-release-v1");
  } finally {
    if (dynamicProjectId && dynamicProjectName) {
      await mcpTool(request, accessToken, "delete_project", {
        projectId: dynamicProjectId,
        confirmName: dynamicProjectName,
      }).catch(() => undefined);
    }
    await mcpTool(request, accessToken, "delete_project", {
      projectId: staticProjectId,
      confirmName: "Passkey Test Site",
    }).catch(() => undefined);
  }
}

async function register(page: Page, username: string): Promise<string> {
  await page.goto(publicPath("/register"));
  await page.getByLabel("Username").fill(username);
  await page.getByRole("button", { name: "Register Passkey" }).click();
  await expect(page.getByText("Passkey registered")).toBeVisible();
  return (await page
    .getByText(/Request code:/)
    .locator("strong")
    .textContent())!;
}

async function login(page: Page, username: string) {
  await page.goto(publicPath("/login"));
  await page.getByLabel("Username or email").fill(username);
  await page.getByRole("button", { name: "Continue with Passkey" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
}

async function startCallbackServer() {
  let resolveCallback!: (url: URL) => void;
  const callback = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("OAuth callback received");
    resolveCallback(new URL(request.url ?? "/", `http://${request.headers.host}`));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    callback,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function codexArgs() {
  const endpoint = process.env.TEST_BASE_URL;
  const name = process.env.TEST_CODEX_MCP_NAME ?? "webdeploy_e2e";
  return [
    "-c",
    `mcp_servers.${name}.url="${endpoint}/mcp"`,
    "-c",
    `mcp_servers.${name}.oauth_resource="${endpoint}/mcp"`,
    "-c",
    `mcp_servers.${name}.required=true`,
  ];
}

function codexCommand() {
  return [
    process.execPath,
    [
      process.env.TEST_CODEX_CLI_PATH ??
        resolve(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js"),
    ],
  ] as const;
}

async function startCodexLogin() {
  const name = process.env.TEST_CODEX_MCP_NAME ?? "webdeploy_e2e";
  const [command, prefix] = codexCommand();
  const child = spawn(
    command,
    [
      ...prefix,
      ...codexArgs(),
      "mcp",
      "login",
      name,
      "--scopes",
      "openid,profile,platform:read,projects:write,deployments:write,offline_access",
    ],
    {
      cwd: process.env.TEST_CODEX_PROJECT_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let resolveAuthorize!: (url: string) => void;
  const authorizeUrl = new Promise<string>((resolvePromise) => {
    resolveAuthorize = resolvePromise;
  });
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/https?:\/\/\S+\/oauth\/authorize\S*/);
    if (match) resolveAuthorize(match[0]);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const completed = new Promise<string>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`codex mcp login exited ${code}: ${output}`));
    });
  });
  return { authorizeUrl, completed };
}

async function runCodex(args: string[]): Promise<string> {
  const [command, prefix] = codexCommand();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      cwd: process.env.TEST_CODEX_PROJECT_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise(output);
      else reject(new Error(`codex exited ${code}: ${output}`));
    });
  });
}

test("Passkey approval, authorization, OAuth PKCE, and MCP tools", async ({ browser, request }) => {
  const username = `admin-${Date.now()}`;
  const context = await browser.newContext();
  const page = await addVirtualPasskey(context);
  const requestCode = await register(page, username);

  const pendingLogin = await request.post(publicPath("/api/auth/login/options"), {
    data: { identifier: username },
  });
  expect(pendingLogin.status()).toBe(401);

  cli("auth", "approve-passkey", requestCode);
  const userList = cli("users", "list");
  expect(userList).toContain(username);

  await login(page, username);
  await expect(page.getByRole("heading", { name: "Install WebDeploy MCP" })).toBeVisible();
  const mcpUrl = `${externalBaseUrl}/mcp`;
  const mcpName = deriveMcpServerName(externalBaseUrl);
  await expect(
    page.getByText(`codex mcp add ${mcpName} --url ${mcpUrl}`, { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Agent", { exact: true }).selectOption("claude");
  await expect(
    page.getByText(`claude mcp add --transport http --scope user ${mcpName} ${mcpUrl}`, {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Installation method", { exact: true }).selectOption("prompt");
  await expect(
    page.getByText("Install WebDeploy MCP in this Claude Code session.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Download ${mcpName}-claude-prompt.txt` }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: `Download ${mcpName}-claude-prompt.txt` }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(`${mcpName}-claude-prompt.txt`);
  const publicSession = await request.get(publicPath("/api/auth/session"));
  const publicSessionBody = await publicSession.json();
  expect(publicSessionBody.mcpUrl).toBe(mcpUrl);
  expect(publicSessionBody.mcpInstall.serverName).toBe(mcpName);
  expect(publicSessionBody.mcpInstall.agents).toHaveLength(3);

  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("Passkey Test Site");
  await page
    .getByLabel("Create a project")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Passkey Test Site" })).toBeVisible();
  const projectId = page.url().match(/projects\/([0-9a-f-]+)/)?.[1];
  expect(projectId).toBeTruthy();
  await page.evaluate(
    async ({ id, basePath }) => {
      const session = await fetch(`${basePath}/api/auth/session`).then((response) =>
        response.json(),
      );
      await fetch(`${basePath}/api/projects/${id}/environment/E2E_SECRET`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({ kind: "secret", value: "must-never-leak-71f05e" }),
      });
    },
    { id: projectId!, basePath: externalBasePath },
  );

  const callbackServer = await startCallbackServer();
  const clientRegistration = await request.post(publicPath("/oauth/register"), {
    data: {
      client_name: "WebDeploy E2E",
      application_type: "native",
      redirect_uris: [callbackServer.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  const clientRegistrationBody = await clientRegistration.text();
  expect(clientRegistration.ok(), clientRegistrationBody).toBeTruthy();
  const client = JSON.parse(clientRegistrationBody);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(18).toString("base64url");
  const authorize = new URL(publicPath("/oauth/authorize"), new URL(externalBaseUrl).origin);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: callbackServer.redirectUri,
    scope: "openid profile platform:read projects:write deployments:write offline_access",
    resource: `${externalBaseUrl}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  await page.goto(authorize.toString());
  const approve = page.getByRole("button", { name: "Approve" });
  await expect(approve).toBeVisible({ timeout: 15_000 });
  await approve.click();
  const callback = await callbackServer.callback;
  await callbackServer.close();
  expect(callback.searchParams.get("state")).toBe(state);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const tokenResponse = await request.post(publicPath("/oauth/token"), {
    form: {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: callbackServer.redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
    },
  });
  expect(tokenResponse.ok()).toBeTruthy();
  const tokens = await tokenResponse.json();
  expect(tokens.access_token).toBeTruthy();

  const initialize = await request.post(publicPath("/mcp"), {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1.0.0" },
      },
    },
  });
  expect(initialize.ok()).toBeTruthy();
  const tools = await request.post(publicPath("/mcp"), {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
    },
    data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  const toolBody = await tools.json();
  expect(toolBody.result.tools.map((tool: any) => tool.name)).toEqual(
    expect.arrayContaining(["create_project", "deploy_inline_files", "rollback_release"]),
  );
  const getProject = await request.post(publicPath("/mcp"), {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
    },
    data: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_project", arguments: { projectId } },
    },
  });
  const projectBody = await getProject.json();
  expect(JSON.stringify(projectBody)).toContain("E2E_SECRET");
  expect(JSON.stringify(projectBody)).not.toContain("must-never-leak-71f05e");
  if (process.env.TEST_SERVER_DEPLOYMENTS === "1") {
    test.setTimeout(300_000);
    await runServerDeploymentScenarios({
      request,
      page,
      accessToken: tokens.access_token,
      staticProjectId: projectId!,
    });
  }
  await context.close();
});

test("an isolated Codex session can install, authenticate, and use the MCP server", async ({
  browser,
}) => {
  test.skip(process.env.TEST_CODEX_SESSION !== "1");
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await addVirtualPasskey(context);
  const username = `e2e-codex-${Date.now()}`;
  const requestCode = await register(page, username);
  cli("auth", "approve-passkey", requestCode);
  await login(page, username);

  const oauthLogin = await startCodexLogin();
  await page.goto(await oauthLogin.authorizeUrl);
  await page.getByRole("button", { name: "Approve" }).click();
  await oauthLogin.completed;

  try {
    const name = process.env.TEST_CODEX_MCP_NAME ?? "webdeploy_e2e";
    const output = await runCodex([
      ...codexArgs(),
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox",
      "read-only",
      `Call the ${name} platform_status and list_projects tools. Do not use the shell. Report the status and project count.`,
    ]);
    expect(output).toContain(name);
    expect(output.toLowerCase()).toContain("status");
  } finally {
    const name = process.env.TEST_CODEX_MCP_NAME ?? "webdeploy_e2e";
    await runCodex([...codexArgs(), "mcp", "logout", name]);
    await context.close();
  }
});

test("rejected Passkeys cannot authenticate", async ({ browser, request }) => {
  const username = `rejected-${Date.now()}`;
  const context = await browser.newContext();
  const page = await addVirtualPasskey(context);
  const requestCode = await register(page, username);
  cli("auth", "reject-passkey", requestCode);
  const response = await request.post(publicPath("/api/auth/login/options"), {
    data: { identifier: username },
  });
  expect(response.status()).toBe(401);
  await context.close();
});
