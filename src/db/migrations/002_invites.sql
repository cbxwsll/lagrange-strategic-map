CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  bound_name TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses >= 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE invite_uses (
  invite_code TEXT NOT NULL REFERENCES invites(code) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at TEXT NOT NULL,
  PRIMARY KEY (invite_code, user_id)
);

CREATE INDEX idx_invite_uses_user ON invite_uses(user_id);
