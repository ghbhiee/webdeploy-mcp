ALTER TABLE project_operations DROP CONSTRAINT IF EXISTS project_operations_kind_check;
ALTER TABLE project_operations ADD CONSTRAINT project_operations_kind_check
  CHECK (kind IN ('restart', 'rollback', 'delete', 'db_provision'));

CREATE TABLE IF NOT EXISTS project_databases (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  db_name text NOT NULL UNIQUE,
  db_role text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'provisioned', 'failed')),
  error_message text,
  provisioned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('003_databases') ON CONFLICT DO NOTHING;
