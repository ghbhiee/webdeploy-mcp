# Changelog

All notable changes follow semantic versioning.

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
