-- S05: one-time SNS preview (K12). Only sha256(previewToken) is stored; the snapshot is built by the server.
CREATE TABLE post_previews (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  source_revision INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private','group','public')),
  group_id TEXT REFERENCES groups(id),
  story TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_post_previews_expires ON post_previews(expires_at);
CREATE INDEX idx_posts_feed ON posts(created_at DESC, id DESC);
CREATE INDEX idx_posts_source_trip ON posts(source_trip_id);
