# Architecture

## Components

- **Dashboard:** React/Vite single-page application served by the control plane.
- **Control plane:** Fastify API, Passkey ceremonies, OAuth/OIDC provider, and Streamable HTTP MCP.
- **Core:** authorization, database, audit, encryption, project, and deployment services.
- **Worker:** PostgreSQL job consumer for source preparation, builds, PM2, health checks, Nginx,
  activation, rollback, pruning, and reboot reconciliation.
- **PostgreSQL:** durable users, credentials, sessions, OAuth objects, projects, jobs, logs,
  releases, ports, operations, and audit events.

## Trust boundaries

The web-facing control plane runs as the `webdeploy` user. It cannot create Unix accounts or
write Nginx configuration. A root systemd worker polls typed database jobs and performs only
validated deployment operations.

Every project receives a generated system user and its own directory. Builds and application
processes run as that user. Nginx exposes only configured release roots or proxies to loopback
ports. Project paths are resolved under the configured data directory; archive and inline paths
reject absolute paths, traversal, and escaping symlinks.

## Release state machine

```text
queued → preparing → fetching → installing → building
       → starting_candidate → health_checking → activating → succeeded
                                                        ↘ failed
```

A dynamic candidate receives a reserved port and starts under a release-specific PM2 name. Only
after its health check succeeds does Nginx point at it and the database mark it active. The old
process is stopped afterward. Failure removes the candidate and its port reservation.

Static output is validated before an atomic `current` symlink replacement. Nginx references that
symlink, so rollback is another atomic replacement.

## Authentication and authorization

WebAuthn is handled by SimpleWebAuthn. New credentials remain `pending` until a local administrator
approves their request code. Dashboard sessions are random, hashed database tokens with CSRF
protection.

The OAuth provider uses Authorization Code with mandatory S256 PKCE, exact registered redirect
URIs, `state` supplied by the client, short-lived access tokens, refresh tokens, revocation, and
resource indicators for the MCP URL. The MCP server maps scopes and the user identity to the same
project authorization service used by Dashboard APIs.

## Data model

The initial migration is [001_initial.sql](../migrations/001_initial.sql). Major relationships:

```text
users ─┬─ passkeys ─ enrollment_requests
       ├─ web_sessions
       ├─ projects ─┬─ project_settings
       │            ├─ project_domains
       │            ├─ environment_variables
       │            ├─ deployments ─ deployment_logs
       │            ├─ releases
       │            └─ project_operations
       └─ audit_events

oauth_objects stores oidc-provider grants, codes, tokens, sessions, and clients.
```

Environment and webhook secrets are AES-256-GCM encrypted using a 32-byte installation key stored
outside the database. Database and key backups are both required for recovery.
