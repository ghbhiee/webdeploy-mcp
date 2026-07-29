# WebDeploy MCP v0.1.1

This maintenance release makes MCP installation explicit and verifiable for Codex, Claude Code,
and other MCP-capable coding Agents.

## Highlights

- The Dashboard home page now displays the deployment's exact MCP URL and copy-ready client commands.
- Codex installation explicitly configures the OAuth resource and scopes, then opens browser login.
- Claude Code has a documented remote HTTP setup and `/mcp` authentication flow.
- A single universal Agent prompt installs, opens browser OAuth, and verifies two read-only tools.
- Split Dashboard and MCP domains are supported when generating installation instructions.
- Deploy static/frontend, Node.js, and Python projects from Git, ZIP/TAR, or inline MCP files.
- Candidate builds and health checks protect the active release; rollback and restart are built in.

## Release assets

- `webdeploy-mcp-v0.1.1.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums for both assets

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- The privileged worker reduces risk with validation and Unix-user separation, but v0.1.1 is not a
  sandbox for mutually hostile tenants.
- Always test on a non-production server and keep off-host backups.
