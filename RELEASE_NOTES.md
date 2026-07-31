# WebDeploy MCP v0.1.12

This release fixes Claude Code OAuth sign-in and includes v0.1.9's Pages service and
deployment lock hardening.

## Highlights

- Stale `/etc/passwd.lock`-style lock files left by crashed processes are detected by holder
  PID and removed automatically during deployment retries; locks held by a live process are
  never touched and the holder is named in the error. `webdeploy doctor --fix` cleans them
  manually. Lock retries now use exponential backoff over a larger window.
- Claude Code can authenticate again: loopback redirect URIs from client metadata documents
  are accepted, and their ephemeral ports are matched per RFC 8252 section 7.3, fixing both
  `invalid_client: client is not allowed` and `invalid_redirect_uri`.
- One-off static pages no longer need a project: `publish_page` writes files into a per-account
  directory served at `PUBLIC_URL/pages/<slug>/`.
- Each Pages site has a publish token for a plain HTTP API (`/api/pages/publish`,
  `/api/pages/files/*`), so CI jobs and other agents can publish without OAuth.
- Tokens are stored hashed, are shown only once, and can be rotated or deleted with the site.
- `useradd`/`userdel` now retry when apt, unattended-upgrades, or cloud-init holds the
  `/etc/passwd` lock, instead of failing the deployment immediately.
- Project Unix users are denied SSH entirely (shell, SFTP, and port forwarding) through a
  `DenyGroups` drop-in that is validated with `sshd -t` before activation; existing users are
  retrofitted automatically on upgrade.
- Worker restarts release stale job locks and fail repeatedly interrupted deployments instead of
  leaving them stuck; `webdeploy doctor` flags stale user-database lock files.

## Release assets

- `webdeploy-mcp-v0.1.12.tar.gz` — versioned source bundle
- `install.sh` — inspectable bootstrap installer
- `SHA256SUMS` — SHA-256 checksums

## Known limitations

- Deployment execution supports Ubuntu 22.04/24.04 and Debian 12 on a single host.
- Private Git deploy keys require an administrator-run server setup step.
- Generic compact-JSON HMAC webhooks are included; provider-specific adapters are not.
- Keep off-host backups before production upgrades.
