# WebDeploy MCP v0.1.7

This release simplifies accounts and Passkey administration.

## Highlights

- Email is the only registration and login identifier.
- The first completed Passkey enrollment becomes system administrator automatically.
- Later user applications appear in Dashboard administration for approval or rejection.
- An existing email account can bind multiple Passkeys.
- Every additional Passkey requires Dashboard or CLI administrator approval.

## Release assets

- `webdeploy-mcp-v0.1.7.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- Keep off-host backups before production upgrades.
