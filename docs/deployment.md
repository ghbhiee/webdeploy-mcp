# Deployment and operations

## Installation layout

Defaults are shown; the installer can change all three roots.

```text
/opt/webdeploy/
  current -> releases/v0.1.5
  releases/<version>/
/var/lib/webdeploy/
  projects/<project-id>/releases/<release-id>/
  projects/<project-id>/current
  uploads/
  pm2/
  backups/
/etc/webdeploy/
  webdeploy.env
  master.key
  oidc-jwks.json
  ecosystem.config.cjs
```

## Manual reverse proxy

When installing with `--no-nginx`, strip the public `/webdeploy/` prefix before proxying to the
configured loopback port. Keep buffering disabled and use a long read timeout for MCP streaming.

```nginx
server {
    listen 443 ssl http2;
    server_name deploy.example.com;
    location = /webdeploy {
        return 308 /webdeploy/;
    }

    location ^~ /webdeploy/ {
        client_max_body_size 100m;
        proxy_pass http://127.0.0.1:3847/;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Prefix /webdeploy;
    }
}
```

Set `PUBLIC_URL` and `MCP_PUBLIC_URL` to `https://deploy.example.com/webdeploy`, build the Dashboard
with `WEBDEPLOY_BASE_PATH=/webdeploy`, and enable `TRUST_PROXY`.

## Application contract

Dynamic applications receive `HOST=127.0.0.1`, `PORT=<allocated>`, and `NODE_ENV=production`.
They must bind to these values. A preferred port is honored when it is free; a temporary alternate
port may be used to keep the old release alive during candidate health checks.

Commands execute from the release root under the project's Unix user. `mise exec` supplies the
configured Node.js and/or Python version. Static projects must produce a non-empty output directory.

## Private Git

Create the project once, identify its OS user from PostgreSQL or the project directory, then
install a read-only repository deploy key in that user's `.ssh` directory. Use strict permissions,
pin the host key in `known_hosts`, and configure the project with an SSH Git URL. The Dashboard
does not accept private-key material in v0.1.5.

## Backup and recovery

`webdeploy backup` combines a custom-format PostgreSQL dump with configuration files. This
includes the master encryption key and OIDC private signing key. Encrypt the archive at rest,
restrict access, and keep an off-host copy.

Restore stops services and replaces database contents. Test recovery periodically on an isolated
host. A backup without `master.key` cannot decrypt stored environment values.

## Updates

`webdeploy update` downloads the latest semantic release and SHA256 manifest, verifies the source
archive, builds it in a new version directory, backs up PostgreSQL, runs migrations, atomically
switches `current`, and restarts. A restart failure restores the previous application symlink.

Automatic updates use a weekly systemd timer. For controlled environments, leave it disabled and
update after reviewing release notes.

## Uninstallation

The default uninstall removes services, application versions, and generated control-plane Nginx
configuration while preserving data/configuration. `--purge-data` is irreversible and also removes
the PostgreSQL database and role.
