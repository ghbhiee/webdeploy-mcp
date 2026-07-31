# Changelog

All notable changes follow semantic versioning.

## [0.1.19] - 2026-07-31

### Added

- The Dashboard now shows the built-in Pages sites: a "Pages" section under the project list
  with each site's name, public URL, publish time, and — new — every top-level entry
  (subdirectory or file) of the site as a clickable link, so one-off pages published into
  subdirectories are all reachable from the Dashboard
- Session-authenticated read API backing it: `GET /api/pages-sites` and
  `GET /api/pages-sites/:slug/entries`

## [0.1.18] - 2026-07-31

### Fixed

- Migration `003_databases.sql` (shipped in 0.1.16) was missing its
  `schema_migrations` registration footer, so the next update re-ran it and aborted on
  `relation "project_databases" already exists`. The file is now idempotent and registered,
  and the migration runner itself records each applied version in the same transaction —
  a migration file that forgets its footer can no longer wedge future updates
- `webdeploy update` is now atomic: releases are extracted and built in a staging directory
  and only moved into place on success, and a release directory only counts as "already
  installed" when it carries a completion marker or is the running release. Previously a
  failed update left a half-built directory that made every retry report
  "already installed" while services kept running the old version

## [0.1.17] - 2026-07-31

### Fixed

- The reported public URL no longer points at a dead hostname: a custom domain now counts as
  the project's public URL only after its DNS actually resolves to the platform host
  (`project_domains.verified_at`, previously written by nothing). Unverified domains fall
  back to the default `/apps/<slug>/` URL in the Dashboard, `get_project`, and
  `get_deployment_status`

### Added

- `set_custom_domain` verifies DNS immediately and reports `verified`; the new
  `verify_domain` MCP tool (and `POST /api/projects/:id/domain/verify`) re-checks after DNS
  records are added. The Dashboard settings tab shows a pending-DNS hint for unverified
  domains

## [0.1.16] - 2026-07-31

### Added

- PostgreSQL provisioning for projects: the new `provision_database` MCP tool (and the
  matching `POST /api/projects/:id/database` Dashboard action) creates a dedicated database
  and login role on the platform host, injects the connection string as the `DATABASE_URL`
  secret environment variable (write-only, encrypted at rest), and reports progress through
  `get_project` (`database.status`: provisioning → provisioned/failed). The database and role
  are dropped together with the project on deletion
- Dashboard now shows the live deployment link everywhere: as a clickable URL on each project
  card and in the project page header (default `/apps/<slug>/` URL, or the custom domain once
  configured), plus a Database panel on the settings tab with provision/retry

### Changed

- Migration `003_databases.sql` adds the `project_databases` table and the `db_provision`
  operation kind

## [0.1.15] - 2026-07-31

### Added

- Default app URLs, Vercel/Railway style: every project is now served out of the box at
  `https://<platform-host><APP_BASE_PATH>/<slug>/` (default `/apps/<slug>/`) with no DNS
  setup. The worker maintains one Nginx location config per project in `NGINX_APPS_DIR`
  (default `/etc/nginx/webdeploy-apps.d/`), included from the platform's control snippet, and
  refreshes it on every release activation and rollback; dynamic projects are proxied with
  the prefix stripped (`X-Forwarded-Prefix` carries it), static projects are aliased to the
  active release. Custom domains remain available via `set_custom_domain` and take over as
  the reported public URL when set
- New configuration: `APP_BASE_PATH` (default `/apps`), `NGINX_APPS_DIR`,
  `NGINX_SNIPPET_FILE`

### Changed

- `get_project` and `get_deployment_status` always report a `publicUrl` now (default app URL
  until a custom domain is configured); the MCP instructions tell agents a deployment is not
  finished until the user has been given that link

## [0.1.14] - 2026-07-31

### Changed

- The MCP interface now covers the full deployment lifecycle; the Dashboard is repositioned
  as the owner's read view and manual override rather than a required step. Server
  instructions direct agents to finish deployments entirely over MCP and to report the live
  URL to the user afterwards
- `create_project` accepts the full runtime settings inline, so a project can be created and
  configured in one call
- Deploying a `node`/`python` project without a start command now fails fast in the control
  plane (`START_COMMAND_REQUIRED`, pointing at `configure_project`) instead of failing
  minutes later in the worker
- `get_deployment_status` of a succeeded deployment and `get_project` now return `publicUrl`
  (the primary domain) so agents can hand the user a working link

### Added

- `configure_project` MCP tool: set git source, install/build/start commands, output
  directory, service port, health check path, SPA fallback, runtime versions, auto-deploy,
  and release retention — everything the Dashboard setup page can set (pass `null` to clear
  a field)
- `set_environment_variables` MCP tool (batch upsert, `plain` or `secret` kind; values are
  encrypted at rest and never readable back) and `delete_environment_variable`

## [0.1.13] - 2026-07-31

### Fixed

- The real cause of every `useradd`/`groupadd: cannot lock` deployment failure: the worker's
  systemd sandbox used `ProtectSystem=full`, which mounts `/etc` read-only, and per-file
  `ReadWritePaths` entries cannot allow shadow-utils to create its lock and temp files inside
  `/etc`. The unit now uses `ProtectSystem=true` (protects `/usr` and `/boot`; `/etc` writable,
  which the worker legitimately manages)
- `webdeploy update` now refreshes the worker systemd unit and the update/uninstall operator
  scripts from the new release; previously unit and script fixes never reached existing
  installations

## [0.1.12] - 2026-07-31

### Fixed

- A stale system user database lock file (for example `/etc/group.lock` left by a crashed
  process) no longer blocks deployments forever: after a few failed attempts the worker reads
  the lock file's PID and, only when that process no longer exists, removes the stale lock and
  retries; locks held by a live process are never touched and the holder (pid/command) is
  reported in the deployment error instead
- Lock retries now use exponential backoff with jitter over a larger window (~2.5 minutes),
  surviving longer apt/unattended-upgrades runs
- `webdeploy doctor` detects stale locks by holder PID instead of file age, and
  `webdeploy doctor --fix` removes them

## [0.1.11] - 2026-07-30

### Fixed

- Authorization requests from loopback native clients (Claude Code) no longer fail with
  `invalid_redirect_uri`: redirect URIs on loopback interfaces are matched with the port
  ignored per RFC 8252 section 7.3, since native clients bind an ephemeral port at runtime

## [0.1.10] - 2026-07-30

### Fixed

- OAuth no longer rejects Claude Code with `invalid_client: client is not allowed`: client
  metadata documents may declare loopback `http://localhost` / `http://127.0.0.1` / `http://[::1]`
  redirect URIs (RFC 8252 native apps); all other plain-HTTP redirects remain rejected

## [0.1.9] - 2026-07-30

### Added

- Built-in Pages service: per-account static directories under `DATA_DIR/pages/`, served publicly
  at `PUBLIC_URL/pages/<slug>/` with no per-site project, Linux user, or Nginx configuration
- MCP tools `create_page_site`, `list_page_sites`, `publish_page`, `rotate_page_token`, and
  `delete_page_site`; `publish_page` uses or creates the account's default site automatically
- Token-authenticated Pages HTTP API (`/api/pages/publish`, `/api/pages/files/*`,
  `/api/pages/site`) for publishing from any HTTP client without OAuth; tokens are stored hashed
  and can be rotated

### Security

- Project Unix users are added to a `webdeploy-projects` group that the worker denies in `sshd`
  through a validated `/etc/ssh/sshd_config.d` drop-in, blocking SFTP and port forwarding that a
  `nologin` shell alone does not prevent; existing users are retrofitted on worker start

### Fixed

- Interrupted deployments no longer stay stuck after a worker crash or reboot: stale job locks
  are released on startup, repeatedly interrupted deployments are marked failed, and leftover
  Pages swap directories are cleaned up
- `webdeploy doctor` reports stale `/etc/passwd.lock`-style files, and `webdeploy pages list`
  shows built-in Pages sites
- Deployments no longer fail with `useradd: cannot lock /etc/passwd` when apt,
  unattended-upgrades, cloud-init, or another process briefly holds the system user database
  lock; the worker retries user creation and removal with backoff and reports stale lock files

## [0.1.8] - 2026-07-30

### Fixed

- First Passkey bootstrap now depends only on whether a Passkey has ever been enrolled

## [0.1.7] - 2026-07-30

### Changed

- Email is the single account and Passkey login identifier
- The first completed Passkey enrollment becomes the initial administrator automatically
- Existing accounts can enroll multiple Passkeys, each requiring administrator approval

### Added

- Dashboard approval and rejection controls for new users and additional Passkeys

## [0.1.6] - 2026-07-29

### Fixed

- Dashboard login now displays the control plane's actionable Passkey/account error instead of a generic HTTP 401
- Fastify error handling is registered before routes so API errors consistently use the documented response envelope

## [0.1.5] - 2026-07-29

### Fixed

- Piped bootstrap installation no longer references an unset `BASH_SOURCE`

## [0.1.4] - 2026-07-29

### Added

- Shared-domain installation under `/webdeploy` with `--path` override
- Safe Nginx virtual-host include injection, off-path backup, validation, and rollback
- Dashboard, API, Passkey, OAuth, MCP, and cookie support for public URL prefixes
- Path-derived MCP names so multiple services on one hostname do not collide

### Fixed

- Reverse-proxy OAuth discovery URLs, secure cookies, and multi-step redirects
- Debian `VERSION` variable collision, missing `/usr/local/libexec`, and current mise checksums
- PM2 startup using a different home after reboot

## [0.1.3] - 2026-07-29

### Added

- One-command quick install using a single positional domain
- Per-domain MCP names across server metadata, CLI, Dashboard, Codex, and Claude Code
- Installer `--plan` validation mode
- DNS preflight before installation changes

### Changed

- Existing Nginx installations are reused; Nginx is installed only when absent
- Disabling Nginx also disables installer-managed HTTPS
- Interactive reads use the terminal instead of piped script input

## [0.1.2] - 2026-07-29

### Added

- `webdeploy mcp` command with Agent/method selection, raw output, file export, and `--help`
- Dashboard MCP installer with Agent and installation-method selectors plus Copy and Download
- Shared domain-aware installation content for Codex, Claude Code, and generic MCP Agents
- Installer-generated `/etc/webdeploy/mcp-install.txt`

### Changed

- Installation now requires an explicit public domain and supports the concise `--domain` option
- Successful installation prints the complete MCP connection guide instead of Codex-only hints

## [0.1.1] - 2026-07-29

### Added

- Dashboard home-page commands for installing the remote MCP server in Codex and Claude Code
- A single copy-ready Agent prompt that installs, opens browser OAuth, and verifies MCP tools
- Server-provided MCP URL in the Dashboard session response for split Dashboard/MCP domains
- Claude Code setup, authentication, inspection, removal, and troubleshooting documentation

### Changed

- Codex guidance now declares the OAuth resource and requested scopes explicitly
- MCP installation guidance now distinguishes client configuration from browser authentication

## [0.1.0] - 2026-07-29

### Added

- Passkey enrollment, local approval, Dashboard sessions, and administrator management
- OAuth 2.1 Authorization Code + PKCE and Streamable HTTP MCP with 15 deployment tools
- Static, Node.js, and Python deployments from Git, archives, and inline files
- Health-checked release activation, rollback, restart, retention, and reboot reconciliation
- Nginx, PM2, PostgreSQL, Certbot, `mise`, interactive installer, update, backup, and uninstall
- Encrypted Dashboard-only environment values and HMAC deployment webhooks
- React Dashboard, CLI, audit events, automated unit/integration/browser tests, and documentation

### Known limitations

- Ubuntu/Debian single-host deployments only
- Private Git deploy keys require administrator setup on the host
- Generic canonical-JSON webhooks only; no provider-specific adapters
- No multi-node worker scheduling
