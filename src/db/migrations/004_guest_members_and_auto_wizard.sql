CREATE TABLE maps_new (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT,
  creator_game_name TEXT,
  creator_game_identity_id TEXT REFERENCES game_identities(id),
  join_password_hash TEXT,
  review_required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'historical', 'maintenance', 'suspended', 'merged')),
  wizard_step INTEGER NOT NULL DEFAULT 2 CHECK (wizard_step BETWEEN 1 AND 4),
  current_version_id TEXT,
  data_account_game_id TEXT,
  merged_into_map_id TEXT REFERENCES maps(id),
  activated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO maps_new (
  id, creator_user_id, name, creator_game_name, join_password_hash, review_required,
  status, wizard_step, current_version_id, data_account_game_id, merged_into_map_id,
  activated_at, created_at, updated_at
)
SELECT id, creator_user_id, name, creator_game_name, join_password_hash, review_required,
  status, wizard_step, current_version_id, data_account_game_id, merged_into_map_id,
  activated_at, created_at, updated_at FROM maps;
DROP TABLE maps;
ALTER TABLE maps_new RENAME TO maps;
CREATE INDEX maps_creator ON maps (creator_user_id, status);
CREATE INDEX maps_current_version ON maps (current_version_id);

CREATE TABLE map_memberships_new (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  game_identity_id TEXT REFERENCES game_identities(id),
  is_creator INTEGER NOT NULL DEFAULT 0,
  is_t_holder INTEGER NOT NULL DEFAULT 0,
  is_leader INTEGER NOT NULL DEFAULT 0,
  is_captain INTEGER NOT NULL DEFAULT 0,
  team_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (map_id, user_id)
);
INSERT INTO map_memberships_new SELECT * FROM map_memberships;
DROP TABLE map_memberships;
ALTER TABLE map_memberships_new RENAME TO map_memberships;
CREATE UNIQUE INDEX map_one_creator ON map_memberships (map_id) WHERE is_creator = 1;
CREATE UNIQUE INDEX map_one_t_holder ON map_memberships (map_id) WHERE is_t_holder = 1;
CREATE UNIQUE INDEX map_one_game_identity ON map_memberships (map_id, game_identity_id) WHERE game_identity_id IS NOT NULL;
CREATE INDEX memberships_user ON map_memberships (user_id, status, map_id);
CREATE INDEX memberships_map ON map_memberships (map_id, status);

CREATE TABLE join_requests_new (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  game_identity_id TEXT NOT NULL REFERENCES game_identities(id),
  game_name TEXT NOT NULL,
  evidence TEXT,
  receipt_token_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
INSERT INTO join_requests_new (
  id, map_id, user_id, game_identity_id, game_name, evidence, status, created_at, resolved_at
)
SELECT id, map_id, user_id, game_identity_id, game_name, evidence, status, created_at, resolved_at FROM join_requests;
DROP TABLE join_requests;
ALTER TABLE join_requests_new RENAME TO join_requests;
CREATE INDEX join_requests_map ON join_requests (map_id, status, created_at);
CREATE INDEX join_requests_user ON join_requests (user_id, status, created_at);

CREATE TABLE member_sessions (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  game_identity_id TEXT NOT NULL REFERENCES game_identities(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX member_sessions_identity ON member_sessions (map_id, game_identity_id, expires_at);
