ALTER TABLE game_identities ADD COLUMN is_observer INTEGER NOT NULL DEFAULT 0 CHECK (is_observer IN (0, 1));
CREATE INDEX game_identities_observer_name ON game_identities (is_observer, game_name, game_id);

ALTER TABLE client_contexts ADD COLUMN observer_in_roster INTEGER NOT NULL DEFAULT 0 CHECK (observer_in_roster IN (0, 1));

UPDATE game_identities SET is_observer = 1, updated_at = updated_at
WHERE id IN (SELECT game_identity_id FROM client_contexts);

UPDATE client_contexts SET observer_in_roster = CASE WHEN EXISTS (
  SELECT 1 FROM map_roster
  WHERE map_roster.version_id = client_contexts.version_id
    AND map_roster.game_identity_id = client_contexts.game_identity_id
) THEN 1 ELSE 0 END;

UPDATE maps SET creator_game_name = NULL, creator_game_identity_id = NULL
WHERE creator_game_identity_id IN (SELECT id FROM game_identities WHERE is_observer = 1);

DELETE FROM member_sessions WHERE game_identity_id IN (SELECT id FROM game_identities WHERE is_observer = 1);
UPDATE map_memberships SET status = 'removed', is_t_holder = 0, is_leader = 0, is_captain = 0,
  game_identity_id = NULL, team_id = NULL, updated_at = updated_at
WHERE user_id IS NULL AND game_identity_id IN (SELECT id FROM game_identities WHERE is_observer = 1);
UPDATE map_memberships SET game_identity_id = NULL, team_id = NULL, updated_at = updated_at
WHERE game_identity_id IN (SELECT id FROM game_identities WHERE is_observer = 1);

DELETE FROM map_roster WHERE game_identity_id IN (SELECT id FROM game_identities WHERE is_observer = 1);
