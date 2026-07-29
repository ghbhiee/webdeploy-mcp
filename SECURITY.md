# Security policy

## Supported versions

Security fixes are provided for the latest released minor version. v0.1.x is currently supported.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Use GitHub's private vulnerability
reporting feature on this repository. Include affected version, reproduction steps, impact, and
any suggested remediation. Do not include real credentials or attack systems you do not own.

You should receive acknowledgement within 7 days. Disclosure timing will be coordinated after a
fix and release are available.

## Security model and operator responsibilities

- Keep the host OS, Node.js, PostgreSQL, Nginx, Certbot, PM2, and `mise` updated.
- Expose the control plane only through HTTPS and a trusted reverse proxy.
- Protect `/etc/webdeploy`, backups, the database, and root access.
- Review Passkey requests out of band before approval.
- Use repository-scoped, read-only deploy keys for private Git.
- Treat custom build/start commands and uploaded source as code execution by the project Unix user.
- Do not share Unix users between untrusted projects.
- Review Nginx changes and deployment logs; rotate webhook secrets after suspected disclosure.

The worker intentionally runs as root because it manages project Unix users and Nginx. Its input
is constrained to typed jobs, safe path resolution, validated archive entries, isolated project
users, loopback ports, candidate health checks, and `nginx -t` before reload. This reduces risk but
does not make the platform suitable for mutually hostile tenants without additional OS sandboxing.

Environment and webhook secrets use AES-256-GCM with an installation key outside PostgreSQL.
Application runtime processes necessarily receive their project's environment. Administrators
cannot retrieve stored plaintext through the product, but root on the host can inspect processes
and files.
