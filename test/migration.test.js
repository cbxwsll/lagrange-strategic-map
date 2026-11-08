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
