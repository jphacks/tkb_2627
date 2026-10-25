-- S07: follow, like, post images. Images are stored in the DB (owner-only until attached to a post).
CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES users(id),
  followee_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id);

CREATE TABLE post_likes (
  post_id TEXT NOT NULL REFERENCES posts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE post_images (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  post_id TEXT REFERENCES posts(id),
  position INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes BLOB NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_post_images_post ON post_images(post_id);
CREATE INDEX idx_post_images_owner ON post_images(owner_id, post_id);

ALTER TABLE post_previews ADD COLUMN image_ids TEXT NOT NULL DEFAULT '[]';
