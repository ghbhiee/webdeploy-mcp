# WebDeploy MCP v0.1.0

The first public release delivers a complete single-server, self-hosted deployment platform with
a Passkey-protected Dashboard and OAuth 2.1 MCP endpoint.

## Highlights

- Deploy static/frontend, Node.js, and Python projects from Git, ZIP/TAR, or inline MCP files.
- Candidate builds and health checks protect the active release; rollback and restart are built in.
- PM2 processes, Nginx routes, optional Certbot HTTPS, per-project Unix users, and reboot recovery.
- Passkey enrollment requires local administrator approval.
- OAuth Authorization Code + S256 PKCE, token revocation, protected-resource metadata, and 15 MCP tools.
- Encrypted, Dashboard-only environment values; signed auto-deploy webhooks.
- Interactive Ubuntu/Debian installer plus update, doctor, backup, restore, and uninstall commands.

## Release assets

- `webdeploy-mcp-v0.1.0.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums for both assets

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- The privileged worker reduces risk with validation and Unix-user separation, but v0.1.0 is not a
  sandbox for mutually hostile tenants.
- Always test on a non-production server and keep off-host backups.
