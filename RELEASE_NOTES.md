# WebDeploy MCP v0.1.9

This release adds the built-in Pages service and hardens deployments against system lock
contention.

## Highlights

- One-off static pages no longer need a project: `publish_page` writes files into a per-account
  directory served at `PUBLIC_URL/pages/<slug>/`.
- Each Pages site has a publish token for a plain HTTP API (`/api/pages/publish`,
  `/api/pages/files/*`), so CI jobs and other agents can publish without OAuth.
- Tokens are stored hashed, are shown only once, and can be rotated or deleted with the site.
- `useradd`/`userdel` now retry when apt, unattended-upgrades, or cloud-init holds the
  `/etc/passwd` lock, instead of failing the deployment immediately.

## Release assets

- `webdeploy-mcp-v0.1.9.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- Keep off-host backups before production upgrades.
