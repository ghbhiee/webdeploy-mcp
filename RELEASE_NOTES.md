# WebDeploy MCP v0.1.3

This release simplifies installation to one domain while safely reusing the host's existing Nginx.

## Highlights

- Quick install is one command with one positional domain.
- Existing Nginx is reused; it is installed only when missing.
- DNS and Nginx conflicts are checked before changing the server.
- Every deployment receives a domain-derived MCP name to avoid client configuration collisions.
- Dashboard and CLI display the exact MCP name and URL.

## Release assets

- `webdeploy-mcp-v0.1.3.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums for both assets

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- The privileged worker reduces risk with validation and Unix-user separation, but v0.1.3 is not a
  sandbox for mutually hostile tenants.
- Always test on a non-production server and keep off-host backups.
