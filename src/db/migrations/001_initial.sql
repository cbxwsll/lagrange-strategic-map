CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'recovery')),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  consumed_at TEXT,
  last_sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX email_challenges_lookup ON email_challenges (email, purpose, consumed_at, created_at DESC);

CREATE TABLE recovery_questions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id, expires_at);

CREATE TABLE rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE game_identities (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL UNIQUE,
  game_name TEXT NOT NULL,
  avatar_url TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX game_identities_name ON game_identities (game_name, game_id);
CREATE INDEX game_identities_user ON game_identities (user_id);

CREATE TABLE maps (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  creator_game_name TEXT NOT NULL,
  join_password_hash TEXT NOT NULL,
  review_required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'historical', 'maintenance', 'suspended', 'merged')),
  wizard_step INTEGER NOT NULL DEFAULT 1 CHECK (wizard_step BETWEEN 1 AND 4),
  current_version_id TEXT,
  data_account_game_id TEXT,
  merged_into_map_id TEXT REFERENCES maps(id),
  activated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX maps_creator ON maps (creator_user_id, status);
CREATE INDEX maps_current_version ON maps (current_version_id);

CREATE TABLE map_versions (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  galaxy_id TEXT NOT NULL,
  galaxy_name TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'historical', 'maintenance')),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX map_versions_map ON map_versions (map_id, started_at DESC);
CREATE INDEX map_versions_galaxy ON map_versions (galaxy_id, organization_id, status);
CREATE INDEX map_versions_body_search ON map_versions (galaxy_id, map_id);

CREATE TABLE map_memberships (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
CREATE UNIQUE INDEX map_one_creator ON map_memberships (map_id) WHERE is_creator = 1;
CREATE UNIQUE INDEX map_one_t_holder ON map_memberships (map_id) WHERE is_t_holder = 1;
CREATE UNIQUE INDEX map_one_game_identity ON map_memberships (map_id, game_identity_id) WHERE game_identity_id IS NOT NULL;
CREATE INDEX memberships_user ON map_memberships (user_id, status, map_id);
CREATE INDEX memberships_map ON map_memberships (map_id, status);

CREATE TABLE map_admin_permissions (
  member_id TEXT NOT NULL REFERENCES map_memberships(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_by TEXT REFERENCES map_memberships(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, permission)
);
CREATE INDEX admin_permissions_grantor ON map_admin_permissions (granted_by);

CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_identity_id TEXT NOT NULL REFERENCES game_identities(id),
  game_name TEXT NOT NULL,
  evidence TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
CREATE INDEX join_requests_map ON join_requests (map_id, status, created_at);
CREATE INDEX join_requests_user ON join_requests (user_id, status, created_at);

CREATE TABLE join_request_reviews (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES join_requests(id) ON DELETE CASCADE,
  reviewer_member_id TEXT NOT NULL REFERENCES map_memberships(id),
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('t', 'leader')),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  created_at TEXT NOT NULL,
  UNIQUE (request_id, reviewer_kind)
);

CREATE TABLE client_tokens (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX client_tokens_map ON client_tokens (map_id, revoked_at);

CREATE TABLE client_contexts (
  map_id TEXT PRIMARY KEY REFERENCES maps(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES client_tokens(id),
  game_identity_id TEXT NOT NULL REFERENCES game_identities(id),
  version_id TEXT NOT NULL REFERENCES map_versions(id),
  galaxy_id TEXT NOT NULL,
  galaxy_name TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  server_status TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_data_at TEXT NOT NULL
);
CREATE INDEX client_contexts_last_seen ON client_contexts (last_seen_at);

CREATE TABLE ingest_batches (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES client_tokens(id),
  external_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (map_id, external_id)
);

CREATE TABLE map_snapshots (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES map_versions(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES ingest_batches(id),
  observed_at TEXT NOT NULL,
  game_time TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX snapshots_map_time ON map_snapshots (map_id, observed_at DESC);
CREATE INDEX snapshots_version_time ON map_snapshots (version_id, observed_at DESC);

CREATE TABLE celestial_bodies (
  snapshot_id TEXT NOT NULL REFERENCES map_snapshots(id) ON DELETE CASCADE,
  body_key TEXT NOT NULL,
  name TEXT NOT NULL,
  body_type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL DEFAULT 0,
  features_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, body_key)
);
CREATE INDEX bodies_name ON celestial_bodies (name, body_type);

CREATE TABLE fleet_snapshots (
  snapshot_id TEXT NOT NULL REFERENCES map_snapshots(id) ON DELETE CASCADE,
  fleet_key TEXT NOT NULL,
  owner_game_id TEXT,
  display_state TEXT NOT NULL CHECK (display_state IN ('real', 'estimated', 'invalid')),
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL DEFAULT 0,
  vx REAL,
  vy REAL,
  vz REAL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, fleet_key)
);
CREATE INDEX fleets_owner ON fleet_snapshots (owner_game_id, display_state);

CREATE TABLE sharing_snapshots (
  snapshot_id TEXT PRIMARY KEY REFERENCES map_snapshots(id) ON DELETE CASCADE,
  current_value REAL NOT NULL,
  target_value REAL NOT NULL,
  effect TEXT NOT NULL,
  visits_equivalent REAL
);

CREATE TABLE map_roster (
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES map_versions(id) ON DELETE CASCADE,
  game_identity_id TEXT NOT NULL REFERENCES game_identities(id),
  game_name TEXT NOT NULL,
  is_leader INTEGER NOT NULL DEFAULT 0,
  team_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (map_id, version_id, game_identity_id)
);
CREATE INDEX roster_identity ON map_roster (game_identity_id, map_id, version_id);
CREATE INDEX roster_team ON map_roster (map_id, version_id, team_id);

CREATE TABLE archives (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES map_versions(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('same_organization_restore', 'different_organization_restore', 'merged', 'expedition_ended')),
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (version_id)
);
CREATE INDEX archives_map ON archives (map_id, created_at DESC);

CREATE TABLE merge_requests (
  id TEXT PRIMARY KEY,
  source_map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  target_map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  requester_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  CHECK (source_map_id <> target_map_id)
);
CREATE INDEX merge_requests_target ON merge_requests (target_map_id, status, created_at);
CREATE INDEX merge_requests_source ON merge_requests (source_map_id, status, created_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  map_id TEXT REFERENCES maps(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  subject_id TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_map_time ON audit_log (map_id, created_at DESC);
