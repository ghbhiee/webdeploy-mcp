# WebDeploy MCP v0.1.4

This release supports deploying WebDeploy behind an existing website at `/webdeploy/`.

## Highlights

- One command reuses an existing domain and Nginx virtual host.
- Only `/webdeploy/` is added; the root website remains unchanged.
- Dashboard, Passkeys, OAuth PKCE, MCP streaming, and Agent commands all use the public path.
- Existing Nginx configuration is backed up, validated, and rolled back safely.
- The generated MCP name includes both domain and path.

## Release assets

- `webdeploy-mcp-v0.1.4.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- Keep off-host backups before production upgrades.
