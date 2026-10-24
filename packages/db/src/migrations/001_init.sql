-- S01 initial schema (model/data-model.json, 12 tables). Timestamps are UTC ISO-8601 text.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  schema_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  constraints_json TEXT NOT NULL,
  days_json TEXT NOT NULL,
  places_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  validation_state TEXT NOT NULL CHECK (validation_state IN ('valid','needs_review','needs_revalidation','invalid')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_trips_owner ON trips(owner_id);

CREATE TABLE trip_versions (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (trip_id, revision)
);

CREATE TABLE plan_batches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  base_trip_id TEXT REFERENCES trips(id),
  base_revision INTEGER,
  generation_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  candidates_json TEXT NOT NULL,
  places_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, generation_id)
);
CREATE INDEX idx_plan_batches_owner ON plan_batches(owner_id);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE group_invites (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  invitee_id TEXT REFERENCES users(id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE post_snapshots (
  id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL,
  redaction_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  source_trip_id TEXT REFERENCES trips(id),
  source_revision INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE REFERENCES post_snapshots(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','group','public')),
  group_id TEXT REFERENCES groups(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  story TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((visibility = 'group' AND group_id IS NOT NULL) OR (visibility <> 'group' AND group_id IS NULL))
);
CREATE INDEX idx_posts_owner ON posts(owner_id);
CREATE INDEX idx_posts_visibility ON posts(visibility);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  source_revision INTEGER NOT NULL,
  file_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','ready','failed','expired')),
  expires_at TEXT
);

CREATE TABLE operation_keys (
  owner_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_id TEXT,
  expires_at TEXT NOT NULL,
  UNIQUE (owner_id, action, key_hash)
);
