# WebDeploy MCP

Self-hosted website deployment for people and AI clients. WebDeploy MCP combines a
Passkey-protected web dashboard, an OAuth 2.1 MCP endpoint, and a release worker that deploys
static sites, frontend builds, Node.js services, and Python web applications without Docker.

The project is server-, IP-, and domain-agnostic. All paths, ports, hostnames, retention limits,
and public URLs are installation settings.

> **Release status:** v0.1.13 fixes the worker sandbox that made every project-user creation
> fail with `cannot lock /etc/group`, and makes updates refresh the systemd unit.

## What it provides

- Git, ZIP/TAR, and small inline-file deployments
- A built-in Pages service: one directory per site, published with a token, no project required
- Custom install, build, output, start, health-check, and runtime settings
- Per-project Linux service users with SSH fully denied (shell, SFTP, and port forwarding)
- Atomic static-site symlinks and health-checked dynamic blue/green activation
- PM2 process management, Nginx routing, and optional Certbot HTTPS
- PostgreSQL-backed jobs, releases, audit events, OAuth state, and encrypted settings
- Passkey-only sign-in with administrator approval for every new enrollment
- OAuth Authorization Code + PKCE, dynamic client registration, token expiry and revocation
- MCP tools for the full lifecycle: project creation and configuration, environment variables,
  deployment, logs, releases, domains, restart, rollback, and deletion
- Environment values encrypted with AES-256-GCM; writable via MCP or Dashboard, readable by neither
- Interactive install, verified release downloads, backup, restore, update, and uninstall

## Architecture

```text
Browser / MCP client
        |
   HTTPS + OAuth
        |
 Nginx reverse proxy
        |
 Control plane (Fastify)
   |        |         |
Dashboard  MCP    Passkey/OIDC
        \    |    /
         PostgreSQL
             |
      privileged worker
       /      |      \
 project UID  PM2    Nginx config
       |
 versioned releases + current symlink
```

The control plane is an unprivileged network service. The systemd worker performs the narrowly
scoped privileged operations needed to create project users, switch releases, and validate Nginx.
See [Architecture](docs/architecture.md) and [Security](SECURITY.md).

## Requirements

- Ubuntu 22.04 or 24.04, or Debian 12
- x86_64 or arm64
- Root access for installation
- A DNS name that already points to the server, including a domain used by an existing site
- TCP 80/443 reachable if the installer should request certificates
- At least 2 GB RAM and 10 GB free disk for a small installation

The installer provisions Node.js 24, pnpm, PM2, Nginx, Certbot, PostgreSQL, Git, Python, and
`mise`. Docker and Caddy are neither required nor used.

## One-command installation

Run one command with the server's domain:

```bash
curl -fsSL https://raw.githubusercontent.com/ghbhiee/webdeploy-mcp/main/install.sh | sudo bash -s -- deploy.your-domain.com
```

Quick installation publishes the Dashboard at
`https://deploy.your-domain.com/webdeploy/` and MCP at
`https://deploy.your-domain.com/webdeploy/mcp`. It derives an isolated name such as
`webdeploy-deploy-your-domain-com-webdeploy`, enables auto-update, and uses `admin` as the initial
identity.

If the domain already has an Nginx virtual host, the installer keeps that site and adds only the
`/webdeploy/` reverse proxy. If Nginx or the virtual host is absent, it installs Nginx and creates
the required configuration. Use `--path /another-path` to change the path or `--path /` for a
dedicated root-domain installation.

Download-first installation uses the same short form:

```bash
curl -fsSLO https://github.com/ghbhiee/webdeploy-mcp/releases/latest/download/install.sh
sudo bash install.sh deploy.your-domain.com
```

Run `sudo bash install.sh --help` for advanced overrides.

At completion, the installer prints the MCP setup for Codex, Claude Code, and other Agents and
saves the same guide to `/etc/webdeploy/mcp-install.txt`. View or save it again at any time:

```bash
webdeploy mcp
webdeploy mcp --help
webdeploy mcp --agent codex --method command
webdeploy mcp --agent claude --method prompt --output claude-mcp.txt
```

## First sign-in and Passkey approval

1. Open the Dashboard URL and register the first account with an email address and Passkey.
2. The first completed enrollment activates immediately as the system administrator.
3. Later users and additional Passkeys wait for approval in **Dashboard > Administration** or CLI:

```bash
sudo webdeploy auth list-pending
sudo webdeploy auth approve-passkey <request-code>
```

Reject an unexpected request with:

```bash
sudo webdeploy auth reject-passkey <request-code>
```

Email is the only account identifier. The same email account can enroll multiple Passkeys.
Revoking a Passkey revokes its web sessions; disabling a user also invalidates that user's OAuth
objects.

## Dashboard workflow

Everything below can equally be driven by an agent over MCP; the Dashboard is the place to
watch what agents did — projects, deployments, live links — and to override any setting by
hand. Create a project, choose `static`, `node`, or `python`, then configure:

- Git repository and branch/tag/commit
- install and build commands
- static output directory or dynamic start command
- preferred internal port and health-check path
- Node.js/Python versions, SPA fallback, release retention, and auto deploy
- custom domain
- plain or secret environment values

Use **Deploy now** for Git, or upload a ZIP/TAR archive. Deployment progress and redacted logs
stream into the project page. Releases can be rolled back; dynamic services can be restarted.
The previous release is not stopped until the candidate passes its health check and activates.

Environment values are write-only after submission. Even administrators and MCP clients receive
only variable names, type, presence, and timestamps.

The Dashboard home page is also the MCP installer: select **Agent** and **Installation method**,
then copy or download the generated command, Agent prompt, or manual configuration. Every result
already contains the deployment's exact MCP URL.

## MCP clients

The public endpoint is:

```text
https://your-mcp-domain.example/webdeploy/mcp
```

### Codex CLI

```bash
codex mcp add webdeploy-your-mcp-domain-example-webdeploy \
  --url https://your-mcp-domain.example/webdeploy/mcp \
  --oauth-resource https://your-mcp-domain.example/webdeploy/mcp
codex mcp login webdeploy-your-mcp-domain-example-webdeploy \
  --scopes openid,profile,platform:read,projects:write,deployments:write,offline_access
```

The login command opens the system browser. Sign in with an approved WebDeploy Passkey, review the
requested scopes, and approve access.

### Claude Code

```bash
claude mcp add --transport http --scope user webdeploy-your-mcp-domain-example-webdeploy \
  https://your-mcp-domain.example/webdeploy/mcp
```

Then open Claude Code, enter `/mcp`, select `webdeploy-your-mcp-domain-example-webdeploy`, and choose
**Authenticate**. Claude opens
the system browser for WebDeploy Passkey login and consent. Claude stores and refreshes the OAuth
credentials after approval.

### One-prompt Agent installation

Replace `<MCP_URL>` and paste this single prompt into Codex, Claude Code, or another MCP-capable
coding Agent:

```text
Install the WebDeploy MCP server in this agent.

Server name: webdeploy-your-mcp-domain-example-webdeploy
MCP URL: <MCP_URL>

Requirements:
1. Detect the current client (Codex, Claude Code, or another MCP-capable agent).
2. Install this as a user/global remote Streamable HTTP MCP server using the client's native configuration. Do not use a stdio bridge and do not ask me to paste an access token.
3. Immediately start the client's OAuth Authorization Code + PKCE flow and open the system browser. Use the server name shown above for every client command and authentication selection.
4. Wait while I finish WebDeploy Passkey login and consent in the browser.
5. After authorization, call the "platform_status" and "list_projects" tools to verify the connection.
6. Report where the MCP configuration was saved and whether both verification calls succeeded.
```

### ChatGPT

ChatGPT connections are configured in the ChatGPT web UI, not with `codex mcp add`. In a workspace
where custom MCP apps are enabled:

1. Open **Settings → Apps & Connectors → Advanced settings** and enable developer mode.
2. Create a custom app/connector and enter the HTTPS MCP URL.
3. Start OAuth. WebDeploy redirects to its Passkey page.
4. Sign in with an approved Passkey and approve the requested scopes.

Menu wording and workspace eligibility can change; consult current OpenAI help if the options are
not present. Client-specific troubleshooting is covered in [MCP clients](docs/mcp-clients.md).

## MCP tools

| Tool                          | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `platform_status`             | Health and authenticated-user summary              |
| `list_projects`               | Accessible projects                                |
| `get_project`                 | Project settings, environment metadata, public URL |
| `create_project`              | Create a project, optionally with runtime settings |
| `configure_project`           | Update git source, commands, port, health check, … |
| `set_environment_variables`   | Upsert env vars (`plain` or `secret`)              |
| `delete_environment_variable` | Remove one env var                                 |
| `provision_database`          | Dedicated PostgreSQL DB; injects `DATABASE_URL`    |
| `deploy_project`              | Deploy configured Git source                       |
| `deploy_from_git`             | Deploy a Git URL/ref                               |
| `deploy_inline_files`         | Deploy up to 100 small files (1 MiB total)         |
| `get_deployment_status`       | Deployment state; public URL on success            |
| `get_deployment_logs`         | Redacted build/deploy logs                         |
| `list_releases`               | Release history                                    |
| `rollback_release`            | Queue an atomic rollback                           |
| `restart_project`             | Restart an active dynamic project                  |
| `get_project_settings_url`    | Passkey-protected Dashboard URL                    |
| `set_custom_domain`           | Configure the primary hostname                     |
| `delete_project`              | Queue project removal                              |
| `create_page_site`            | Create a Pages directory + publish token           |
| `list_page_sites`             | List Pages sites and public URLs                   |
| `publish_page`                | Publish static files to a Pages site               |
| `rotate_page_token`           | Replace a Pages publish token                      |
| `delete_page_site`            | Delete a Pages site and its files                  |

The whole deployment lifecycle — create, configure, set environment, deploy, verify, get the
live URL — runs over MCP. Every project is reachable immediately at
`https://<platform-host>/apps/<slug>/` (configurable via `APP_BASE_PATH`), no DNS work
required; a custom domain set with `set_custom_domain` replaces that default URL. The
Dashboard is the owner's read view and manual override: it shows what each MCP client
installed, deployment history, and the live links, and can edit any setting by hand. Environment values can be written through MCP (encrypted at rest) but are
never readable back through any API; the Dashboard cannot display them either.

## Built-in static Pages

Full projects are the right tool for real sites, but they create a Linux user, releases, and
Nginx state per site. For one-off static pages — reports, demos, artifacts an agent just
generated — the control plane ships a shared Pages service instead:

- Every site is one directory below `DATA_DIR/pages/` and is served publicly at
  `PUBLIC_URL/pages/<slug>/` through the existing reverse proxy. No per-site Nginx or
  certificate work.
- Each MCP account gets a default site on first `publish_page`; additional named sites are
  created with `create_page_site`. Owners and administrators see their sites with
  `list_page_sites`.
- Every site has a publish token (returned once at creation). The token authenticates a plain
  HTTP API, so CI jobs or other agents can publish without OAuth:

```bash
# Replace the whole site with one HTML file
curl -X POST "$PUBLIC_URL/api/pages/publish" \
  -H "Authorization: Bearer $PAGES_TOKEN" -H "Content-Type: application/json" \
  -d '{"clean":true,"files":[{"path":"index.html","content":"<h1>hello</h1>"}]}'

# Upload or overwrite a single file with a raw body
curl -X PUT "$PUBLIC_URL/api/pages/files/report/index.html" \
  -H "Authorization: Bearer $PAGES_TOKEN" --data-binary @report.html

# Inspect the site the token belongs to
curl "$PUBLIC_URL/api/pages/site" -H "Authorization: Bearer $PAGES_TOKEN"
```

`publish_page` merges files into the site by default; pass `clean: true` to atomically replace
the whole directory. Tokens are stored hashed, can be rotated with `rotate_page_token`, and die
with the site on `delete_page_site`. Published pages are served without the dashboard's
Content-Security-Policy so inline scripts and styles work.

## Administration

```bash
sudo webdeploy users list
sudo webdeploy users disable <user-id>
sudo webdeploy users set-admin <user-id>
sudo webdeploy users remove-admin <user-id>
sudo webdeploy passkeys list <user-id>
sudo webdeploy passkeys revoke <passkey-id>
sudo webdeploy projects list
sudo webdeploy projects restart <project-id>
```

Administrators can see all projects, manage roles and Passkeys, approve enrollment, transfer
ownership, and override/delete environment values without reading existing plaintext. Security
and role changes are audit logged.

## Operations

```bash
sudo webdeploy status
sudo webdeploy start
sudo webdeploy stop
sudo webdeploy restart
sudo webdeploy logs
sudo webdeploy doctor
sudo webdeploy backup /secure/path/webdeploy-backup.tar.gz
sudo webdeploy update
sudo webdeploy uninstall
```

`backup` contains the database, configuration, encryption key, and signing key. Store it as a
high-value secret. Restore is intentionally interactive:

```bash
sudo webdeploy restore /secure/path/webdeploy-backup.tar.gz --confirm
```

To remove services but preserve data, run `sudo webdeploy uninstall`. To permanently delete the
database, configuration, and deployment data:

```bash
sudo /etc/webdeploy/uninstall.sh --purge-data
```

## Nginx, HTTPS, and PM2

For an existing domain, the installer backs up the virtual host outside Nginx's loaded directories,
adds one managed include, and proxies only `/webdeploy/`. The root site and its other locations are
untouched. It runs `nginx -t` before reload and removes the include if validation fails. With
`--no-nginx`, configure a path-stripping reverse proxy to the loopback control-plane port and
disable buffering for MCP responses.

Certbot is optional. If certificate issuance fails, installation remains usable locally and prints
the exact retry command after DNS is fixed.

PM2 manages the control plane and dynamic project releases. The worker is a systemd service and
reconciles missing active PM2 processes after reboot.

## Manual development installation

```bash
corepack enable
corepack prepare pnpm@11.10.0 --activate
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
# Create the PostgreSQL database, master key, and OIDC JWKS, then edit .env.
pnpm migrate
pnpm --filter @webdeploy/control-plane dev
pnpm --filter @webdeploy/worker dev
```

For a production server, use the installer so users, permissions, systemd, PM2, Nginx, secrets,
and backup/update scripts are installed consistently.

## Testing

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
TEST_DATABASE_URL=postgresql://... pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

GitHub Actions runs lint, type checks, builds, PostgreSQL integration tests, Passkey/OAuth/MCP
browser tests, and shell syntax checks on Ubuntu.

## Troubleshooting

- **Passkey says pending:** run `sudo webdeploy auth list-pending`, then approve its request code.
- **OAuth callback fails:** verify the Dashboard/MCP public URLs and reverse-proxy scheme/host.
- **Deployment cannot start:** check `sudo webdeploy doctor`, deployment logs, start command, and
  that the app listens on injected `HOST=127.0.0.1` and `PORT`.
- **Health check fails:** the candidate is removed and the old release remains active. Correct the
  path or application and redeploy.
- **Nginx path conflict:** choose another `--path` if the existing virtual host already declares
  `/webdeploy`.
- **Certificate failure:** confirm DNS and inbound 80/443, then run the printed `certbot --nginx` command.
- **Private Git:** use an SSH URL and install a read-only deploy key for the project's isolated Linux
  user. Never put credentials in a Git URL.
- **`useradd: cannot lock /etc/passwd`:** the worker retries with backoff and removes stale lock
  files whose holding process is dead. If deployment still fails, the error names the live
  process holding the lock; wait for it to finish, or run `sudo webdeploy doctor --fix`.

See [Deployment and operations](docs/deployment.md) for details.

## Known limitations in v0.1.9

- Linux deployment execution is supported only on the listed Ubuntu/Debian versions.
- Private Git key enrollment is an administrator-run server step; the Dashboard does not upload
  private keys.
- The generic webhook signs canonical compact JSON as documented in
  [Webhooks](docs/webhooks.md); provider-specific webhook adapters are not included.
- Certificate renewal is delegated to the distribution's Certbot systemd timer.
- Multi-node control planes and remote workers are not supported.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed under
[Apache-2.0](LICENSE).
