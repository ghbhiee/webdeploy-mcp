import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

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
  return execFileSync(process.execPath, ["apps/cli/dist/index.js", ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
}

async function register(page: Page, username: string): Promise<string> {
  await page.goto("/register");
  await page.getByLabel("Username").fill(username);
  await page.getByRole("button", { name: "Register Passkey" }).click();
  await expect(page.getByText("Passkey registered")).toBeVisible();
  return (await page
    .getByText(/Request code:/)
    .locator("strong")
    .textContent())!;
}

async function login(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(username);
  await page.getByRole("button", { name: "Continue with Passkey" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
}

test("Passkey approval, authorization, OAuth PKCE, and MCP tools", async ({ browser, request }) => {
  const username = `admin-${Date.now()}`;
  const context = await browser.newContext();
  const page = await addVirtualPasskey(context);
  const requestCode = await register(page, username);

  const pendingLogin = await request.post("/api/auth/login/options", {
    data: { identifier: username },
  });
  expect(pendingLogin.status()).toBe(401);

  cli("auth", "approve-passkey", requestCode);
  const userList = cli("users", "list");
  expect(userList).toContain(username);

  await login(page, username);
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
    async ({ id }) => {
      const session = await fetch("/api/auth/session").then((response) => response.json());
      await fetch(`/api/projects/${id}/environment/E2E_SECRET`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({ kind: "secret", value: "must-never-leak-71f05e" }),
      });
    },
    { id: projectId! },
  );

  const clientRegistration = await request.post("/oauth/register", {
    data: {
      client_name: "WebDeploy E2E",
      application_type: "native",
      redirect_uris: ["http://127.0.0.1:9876/callback"],
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
  const authorize = new URL("/oauth/authorize", process.env.TEST_BASE_URL);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:9876/callback",
    scope: "openid profile platform:read projects:write deployments:write offline_access",
    resource: `${process.env.TEST_BASE_URL}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  await page.route("http://127.0.0.1:9876/callback**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "OAuth callback received" }),
  );
  await page.goto(authorize.toString());
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/127\.0\.0\.1:9876\/callback/).catch(() => undefined);
  const callback = new URL(page.url());
  expect(callback.searchParams.get("state")).toBe(state);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const tokenResponse = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: "http://127.0.0.1:9876/callback",
      client_id: client.client_id,
      code_verifier: verifier,
    },
  });
  expect(tokenResponse.ok()).toBeTruthy();
  const tokens = await tokenResponse.json();
  expect(tokens.access_token).toBeTruthy();

  const initialize = await request.post("/mcp", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
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
  const tools = await request.post("/mcp", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  const toolBody = await tools.json();
  expect(toolBody.result.tools.map((tool: any) => tool.name)).toEqual(
    expect.arrayContaining(["create_project", "deploy_inline_files", "rollback_release"]),
  );
  const getProject = await request.post("/mcp", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
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
  await context.close();
});

test("rejected Passkeys cannot authenticate", async ({ browser, request }) => {
  const username = `rejected-${Date.now()}`;
  const context = await browser.newContext();
  const page = await addVirtualPasskey(context);
  const requestCode = await register(page, username);
  cli("auth", "reject-passkey", requestCode);
  const response = await request.post("/api/auth/login/options", {
    data: { identifier: username },
  });
  expect(response.status()).toBe(401);
  await context.close();
});
