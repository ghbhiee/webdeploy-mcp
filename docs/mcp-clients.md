# MCP client connections

WebDeploy exposes Streamable HTTP MCP at the configured `MCP_PUBLIC_URL` plus `/mcp`. It advertises
OAuth protected-resource metadata and an authorization server rooted at `PUBLIC_URL`.

## Codex CLI

```bash
codex mcp add webdeploy --url https://deploy.example.com/mcp
codex mcp login webdeploy
```

Inspect or remove the connection with:

```bash
codex mcp list
codex mcp remove webdeploy
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
