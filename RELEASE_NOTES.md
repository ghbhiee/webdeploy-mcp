# WebDeploy MCP v0.1.6

This release fixes actionable Passkey login errors being hidden behind a generic HTTP 401.

## Highlights

- One command reuses an existing domain and Nginx virtual host.
- Only `/webdeploy/` is added; the root website remains unchanged.
- Dashboard, Passkeys, OAuth PKCE, MCP streaming, and Agent commands all use the public path.
- Dashboard login shows the exact account or Passkey activation problem.
- Control-plane API errors consistently use the documented error envelope.

## Release assets

- `webdeploy-mcp-v0.1.6.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- Keep off-host backups before production upgrades.
