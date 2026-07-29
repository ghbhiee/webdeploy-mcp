CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('pending', 'active', 'disabled');
CREATE TYPE passkey_status AS ENUM ('pending', 'active', 'revoked', 'rejected');
CREATE TYPE project_type AS ENUM ('static', 'node', 'python');
CREATE TYPE deployment_status AS ENUM (
  'queued', 'preparing', 'fetching', 'installing', 'building',
  'starting_candidate', 'health_checking', 'activating',
  'succeeded', 'failed', 'cancelled'
);
CREATE TYPE source_kind AS ENUM ('git', 'archive', 'inline');
CREATE TYPE environment_kind AS ENUM ('plain', 'secret');

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  email text,
  webauthn_user_id bytea NOT NULL UNIQUE,
  status user_status NOT NULL DEFAULT 'pending',
  is_admin boolean NOT NULL DEFAULT false,
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_unique ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE passkey_enrollment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status passkey_status NOT NULL DEFAULT 'pending',
  request_code text NOT NULL UNIQUE,
  requested_ip inet,
  requested_user_agent text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrollment_request_id uuid REFERENCES passkey_enrollment_requests(id) ON DELETE SET NULL,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_type text NOT NULL,
  backed_up boolean NOT NULL DEFAULT false,
  status passkey_status NOT NULL DEFAULT 'pending',
  name text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passkey_id uuid NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  ip inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  type project_type NOT NULL DEFAULT 'static',
  status text NOT NULL DEFAULT 'idle',
  os_user text,
  current_release_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_idx ON projects(owner_id);

CREATE TABLE project_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  git_url text,
  git_ref text NOT NULL DEFAULT 'main',
  install_command text,
  build_command text,
  output_directory text,
  start_command text,
  service_port integer,
  health_check_path text NOT NULL DEFAULT '/',
  spa_fallback boolean NOT NULL DEFAULT false,
  node_version text,
  python_version text,
  auto_deploy boolean NOT NULL DEFAULT false,
  webhook_secret_ciphertext bytea,
  webhook_secret_nonce bytea,
  webhook_secret_auth_tag bytea,
  webhook_secret_key_version integer,
  release_retention integer NOT NULL DEFAULT 5 CHECK (release_retention BETWEEN 1 AND 50),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_ports (
  port integer PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id uuid,
  allocated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hostname text NOT NULL UNIQUE,
  is_primary boolean NOT NULL DEFAULT false,
  https_status text NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environment_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind environment_kind NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  source_kind source_kind NOT NULL,
  source_spec jsonb NOT NULL,
  status deployment_status NOT NULL DEFAULT 'queued',
  release_id uuid,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deployments_project_created_idx ON deployments(project_id, created_at DESC);

CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  path text NOT NULL,
  port integer,
  source_revision text,
  status text NOT NULL DEFAULT 'candidate',
  activated_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE projects ADD CONSTRAINT projects_current_release_fk
  FOREIGN KEY (current_release_id) REFERENCES releases(id) ON DELETE SET NULL;
ALTER TABLE project_ports ADD CONSTRAINT project_ports_release_fk
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE;

CREATE TABLE deployment_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('restart', 'rollback', 'delete')),
  target_release_id uuid REFERENCES releases(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deployment_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('system', 'stdout', 'stderr')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deployment_logs_deployment_idx ON deployment_logs(deployment_id, id);

CREATE TABLE oauth_objects (
  model text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  grant_id text,
  user_code text,
  uid text,
  expires_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY(model, id)
);
CREATE INDEX oauth_objects_grant_idx ON oauth_objects(grant_id) WHERE grant_id IS NOT NULL;
CREATE UNIQUE INDEX oauth_objects_user_code_idx ON oauth_objects(user_code) WHERE user_code IS NOT NULL;
CREATE UNIQUE INDEX oauth_objects_uid_idx ON oauth_objects(uid) WHERE uid IS NOT NULL;

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_system_uid text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('001_initial') ON CONFLICT DO NOTHING;
