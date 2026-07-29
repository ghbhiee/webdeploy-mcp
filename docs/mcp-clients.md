# MCP client connections

WebDeploy exposes Streamable HTTP MCP at the configured `MCP_PUBLIC_URL` plus `/mcp`. It advertises
OAuth protected-resource metadata and an authorization server rooted at `PUBLIC_URL`.

The platform installer prints and saves these instructions. On an installed server, use:

```bash
webdeploy mcp
webdeploy mcp --help
webdeploy mcp --agent codex --method command
webdeploy mcp --agent claude --method prompt --output claude-mcp.txt
```

The Dashboard provides the same choices as Agent and installation-method selectors with Copy and
Download actions.

## Codex CLI

```bash
codex mcp add webdeploy-deploy-example-com-webdeploy \
  --url https://deploy.example.com/webdeploy/mcp \
  --oauth-resource https://deploy.example.com/webdeploy/mcp
codex mcp login webdeploy-deploy-example-com-webdeploy \
  --scopes openid,profile,platform:read,projects:write,deployments:write,offline_access
```

The login command opens the system browser. Complete WebDeploy Passkey login and approve the
requested scopes. Codex saves and refreshes the resulting OAuth credentials; do not put a bearer
token in `config.toml`.

Inspect or remove the connection with:

```bash
codex mcp list
codex mcp remove webdeploy-deploy-example-com-webdeploy
```

## Claude Code

Add WebDeploy as a user-scoped remote HTTP server:

```bash
claude mcp add --transport http --scope user webdeploy-deploy-example-com-webdeploy https://deploy.example.com/webdeploy/mcp
```

Claude Code performs interactive OAuth from its MCP menu:

1. Start Claude Code and enter `/mcp`.
2. Select `webdeploy-deploy-example-com-webdeploy`.
3. Choose **Authenticate**. The system browser opens automatically.
4. Complete WebDeploy Passkey login and approve access.
5. Return to Claude Code and use `/mcp` to confirm the server is connected.

Inspect or remove the connection with:

```bash
claude mcp get webdeploy-deploy-example-com-webdeploy
claude mcp remove --scope user webdeploy-deploy-example-com-webdeploy
```

Adding the server only writes its URL. The browser opens when **Authenticate** is selected from
`/mcp`, which is the current Claude Code OAuth flow.

## One-prompt Agent installation

The Dashboard home page generates this prompt with the deployment's real MCP URL. For manual use,
replace `<MCP_URL>` and paste the whole block into the Agent:

```text
Install the WebDeploy MCP server in this agent.

Server name: webdeploy-deploy-example-com-webdeploy
MCP URL: <MCP_URL>

Requirements:
1. Detect the current client (Codex, Claude Code, or another MCP-capable agent).
2. Install this as a user/global remote Streamable HTTP MCP server using the client's native configuration. Do not use a stdio bridge and do not ask me to paste an access token.
3. Immediately start the client's OAuth Authorization Code + PKCE flow and open the system browser. Use the server name shown above for every client command and authentication selection.
4. Wait while I finish WebDeploy Passkey login and consent in the browser.
5. After authorization, call the "platform_status" and "list_projects" tools to verify the connection.
6. Report where the MCP configuration was saved and whether both verification calls succeeded.
```

## ChatGPT web

There is no shell command that installs a connector into the ChatGPT website. A workspace
administrator may need to enable custom apps. In ChatGPT settings, enable developer mode under
advanced app/connector settings, create a custom connector, and enter the MCP HTTPS endpoint.
The first use starts OAuth and redirects to WebDeploy's Passkey login.

Availability depends on workspace plan and policy. Use current OpenAI documentation if the
developer controls are not shown.

## Other clients

Any client that supports remote Streamable HTTP MCP plus OAuth Authorization Code/PKCE can use the
same URL. Prefer the client's URL-based remote-server configuration. Stdio-only clients need an
independently maintained remote-MCP bridge; WebDeploy does not bundle one.

Do not paste access tokens into configuration. Let the client's OAuth flow obtain and refresh
tokens. Register only loopback or HTTPS redirect URIs and preserve the client-generated `state`
value.
