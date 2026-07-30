# Changelog

All notable changes follow semantic versioning.

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
