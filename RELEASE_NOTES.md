# WebDeploy MCP v0.1.2

This release turns MCP setup into a first-class installation flow across the server installer,
CLI, and Dashboard.

## Highlights

- Installation requires the public domain and supports `--domain`.
- Installation completion prints the MCP guide and saves `/etc/webdeploy/mcp-install.txt`.
- `webdeploy mcp` regenerates instructions with Agent/method filters, `--raw`, `--output`, and help.
- The Dashboard lets users select Codex, Claude Code, or another Agent; choose command, prompt, or
  manual setup; then Copy or Download the exact domain-aware result.

## Release assets

- `webdeploy-mcp-v0.1.2.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums for both assets

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- The privileged worker reduces risk with validation and Unix-user separation, but v0.1.2 is not a
  sandbox for mutually hostile tenants.
- Always test on a non-production server and keep off-host backups.
