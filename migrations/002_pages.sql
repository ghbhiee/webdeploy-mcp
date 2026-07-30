CREATE TABLE page_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_sites_owner_idx ON page_sites(owner_id);

INSERT INTO schema_migrations(version) VALUES ('002_pages') ON CONFLICT DO NOTHING;
