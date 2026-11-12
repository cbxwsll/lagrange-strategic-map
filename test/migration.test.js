import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';

const migrations = path.resolve('src/db/migrations');

test('004 从真实旧库升级：保留账号、成员、申请和审批外键', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-004-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'legacy.db');
  const legacy = new Database(dbPath);
  legacy.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const name of ['001_initial.sql', '002_invites.sql', '003_beta_gate.sql']) {
    legacy.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
    legacy.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  }
  const timestamp = new Date().toISOString();
  legacy.prepare('INSERT INTO users (id, email, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user-1', 'legacy@example.com', '旧用户', 'hash', timestamp, timestamp);
  legacy.prepare('INSERT INTO game_identities (id, game_id, game_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('identity-1', 'game-1', '旧身份', timestamp, timestamp);
  legacy.prepare(`INSERT INTO maps
    (id, creator_user_id, name, creator_game_name, join_password_hash, review_required, status, wizard_step, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 'active', 4, ?, ?)`)
    .run('map-1', 'user-1', '旧地图', '旧身份', 'join-hash', timestamp, timestamp);
  legacy.prepare('INSERT INTO map_memberships (id, map_id, user_id, game_identity_id, is_creator, is_t_holder, joined_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)')
    .run('member-1', 'map-1', 'user-1', 'identity-1', timestamp, timestamp);
  legacy.prepare(`INSERT INTO join_requests
    (id, map_id, user_id, game_identity_id, game_name, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)`)
    .run('request-1', 'map-1', 'user-1', 'identity-1', '旧身份', timestamp, timestamp);
  legacy.prepare('INSERT INTO join_request_reviews (id, request_id, reviewer_member_id, reviewer_kind, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('review-1', 'request-1', 'member-1', 't', 'approve', timestamp);
  legacy.close();

  const db = openDatabase({ dbPath });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT name FROM maps WHERE id = ?').get('map-1').name, '旧地图');
  assert.equal(db.prepare('SELECT user_id FROM map_memberships WHERE id = ?').get('member-1').user_id, 'user-1');
  assert.equal(db.prepare('SELECT user_id FROM join_requests WHERE id = ?').get('request-1').user_id, 'user-1');
  assert.equal(db.prepare('SELECT decision FROM join_request_reviews WHERE id = ?').get('review-1').decision, 'approve');
  assert.equal(db.prepare('SELECT receipt_token_hash FROM join_requests WHERE id = ?').get('request-1').receipt_token_hash, null);
  db.prepare('INSERT INTO game_identities (id, game_id, game_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('identity-2', 'game-2', '访客身份', timestamp, timestamp);
  db.prepare('INSERT INTO map_memberships (id, map_id, user_id, game_identity_id, joined_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)')
    .run('guest-member', 'map-1', 'identity-2', timestamp, timestamp);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});


test('005 从旧库升级：观察小号脱离创建者、名册、成员和会话，真实玩家保留', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-005-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'legacy.db');
  const legacy = new Database(dbPath);
  legacy.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const name of ['001_initial.sql', '002_invites.sql', '003_beta_gate.sql', '004_guest_members_and_auto_wizard.sql']) {
    legacy.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
    legacy.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  }
  const timestamp = new Date().toISOString();
  legacy.prepare('INSERT INTO users (id, email, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user-observer-migration', 'observer-migration@example.com', '旧创建者', 'hash', timestamp, timestamp);
  for (const [id, gameId, gameName] of [
    ['identity-observer-migration', 'observer-game-id', '观察小号'],
    ['identity-player-migration', 'player-game-id', '真实玩家']
  ]) {
    legacy.prepare('INSERT INTO game_identities (id, game_id, game_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, gameId, gameName, timestamp, timestamp);
  }
  legacy.prepare(`INSERT INTO maps
    (id, creator_user_id, name, creator_game_name, creator_game_identity_id, join_password_hash,
     status, wizard_step, current_version_id, data_account_game_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 4, ?, ?, ?, ?)`)
    .run('map-observer-migration', 'user-observer-migration', '旧地图', '观察小号',
      'identity-observer-migration', 'join-hash', 'version-observer-migration', 'observer-game-id', timestamp, timestamp);
  legacy.prepare(`INSERT INTO map_versions
    (id, map_id, galaxy_id, galaxy_name, organization_id, organization_name, protocol_version, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
    .run('version-observer-migration', 'map-observer-migration', 'galaxy-test', '测试星系',
      'org-test', '测试联合体', 'weiyang-3.0', timestamp);
  legacy.prepare('INSERT INTO client_tokens (id, map_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('token-observer-migration', 'map-observer-migration', 'test-only-token-hash', '测试客户端', timestamp);
  legacy.prepare(`INSERT INTO client_contexts
    (map_id, token_id, game_identity_id, version_id, galaxy_id, galaxy_name, organization_id,
     organization_name, protocol_version, server_status, last_seen_at, first_data_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`)
    .run('map-observer-migration', 'token-observer-migration', 'identity-observer-migration',
      'version-observer-migration', 'galaxy-test', '测试星系', 'org-test', '测试联合体',
      'weiyang-3.0', timestamp, timestamp);
  for (const identityId of ['identity-observer-migration', 'identity-player-migration']) {
    legacy.prepare(`INSERT INTO map_roster
      (map_id, version_id, game_identity_id, game_name, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('map-observer-migration', 'version-observer-migration', identityId,
        identityId === 'identity-observer-migration' ? '观察小号' : '真实玩家', timestamp);
  }
  legacy.prepare(`INSERT INTO map_memberships
    (id, map_id, user_id, is_creator, is_t_holder, joined_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)`)
    .run('member-creator-migration', 'map-observer-migration', 'user-observer-migration', timestamp, timestamp);
  legacy.prepare(`INSERT INTO map_memberships
    (id, map_id, user_id, game_identity_id, joined_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)`)
    .run('member-observer-migration', 'map-observer-migration', 'identity-observer-migration', timestamp, timestamp);
  legacy.prepare(`INSERT INTO member_sessions
    (id, map_id, game_identity_id, token_hash, expires_at, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('session-observer-migration', 'map-observer-migration', 'identity-observer-migration',
      'test-only-session-hash', new Date(Date.now() + 86_400_000).toISOString(), timestamp, timestamp);
  legacy.close();

  const db = openDatabase({ dbPath });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT is_observer FROM game_identities WHERE id = ?').get('identity-observer-migration').is_observer, 1);
  assert.equal(db.prepare('SELECT is_observer FROM game_identities WHERE id = ?').get('identity-player-migration').is_observer, 0);
  assert.equal(db.prepare('SELECT observer_in_roster FROM client_contexts WHERE map_id = ?').get('map-observer-migration').observer_in_roster, 1);
  const map = db.prepare('SELECT creator_game_name, creator_game_identity_id FROM maps WHERE id = ?').get('map-observer-migration');
  assert.equal(map.creator_game_name, null);
  assert.equal(map.creator_game_identity_id, null);
  assert.deepEqual(db.prepare('SELECT game_identity_id FROM map_roster WHERE map_id = ?').all('map-observer-migration'),
    [{ game_identity_id: 'identity-player-migration' }]);
  const observerMember = db.prepare('SELECT status, game_identity_id FROM map_memberships WHERE id = ?').get('member-observer-migration');
  assert.equal(observerMember.status, 'removed');
  assert.equal(observerMember.game_identity_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM member_sessions WHERE game_identity_id = ?').get('identity-observer-migration').count, 0);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name = '005_observer_and_viewer_colors.sql'").get());
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
