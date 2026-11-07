CREATE TABLE invites_beta_gate (
  code TEXT PRIMARY KEY,
  bound_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at TEXT NOT NULL
);

INSERT INTO invites_beta_gate (code, bound_name, active, used_count, created_at)
SELECT code, bound_name, 1, used_count, created_at FROM invites;

DROP TABLE invite_uses;
DROP TABLE invites;
ALTER TABLE invites_beta_gate RENAME TO invites;
