# Changelog

All notable changes follow semantic versioning.

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
