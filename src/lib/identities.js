import { fail } from './errors.js';
import { now, uuid } from './security.js';

export function upsertGameIdentity(db, { gameId, gameName, avatarUrl = null, userId = null }) {
  const existing = db.prepare('SELECT * FROM game_identities WHERE game_id = ?').get(gameId);
  if (existing) {
    if (userId && existing.user_id && existing.user_id !== userId) {
      fail(409, 'GAME_ID_BOUND', '该游戏内 ID 已绑定其他网站账号');
    }
    db.prepare(`UPDATE game_identities SET game_name = ?, avatar_url = COALESCE(?, avatar_url),
      user_id = COALESCE(user_id, ?), updated_at = ? WHERE id = ?`)
      .run(gameName, avatarUrl, userId, now(), existing.id);
    return db.prepare('SELECT * FROM game_identities WHERE id = ?').get(existing.id);
  }
  const id = uuid();
  const timestamp = now();
  db.prepare(`INSERT INTO game_identities
    (id, game_id, game_name, avatar_url, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, gameId, gameName, avatarUrl, userId, timestamp, timestamp);
  return db.prepare('SELECT * FROM game_identities WHERE id = ?').get(id);
}

export function ensureMembership(db, mapId, userId, gameIdentityId = null) {
  const existing = db.prepare('SELECT * FROM map_memberships WHERE map_id = ? AND user_id = ?').get(mapId, userId);
  const timestamp = now();
  if (existing) {
    if (existing.status !== 'active' || (gameIdentityId && existing.game_identity_id !== gameIdentityId)) {
      db.prepare(`UPDATE map_memberships SET status = 'active', game_identity_id = COALESCE(?, game_identity_id),
        updated_at = ? WHERE id = ?`).run(gameIdentityId, timestamp, existing.id);
    }
    return db.prepare('SELECT * FROM map_memberships WHERE id = ?').get(existing.id);
  }
  const id = uuid();
  db.prepare(`INSERT INTO map_memberships
    (id, map_id, user_id, game_identity_id, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, mapId, userId, gameIdentityId, timestamp, timestamp);
  return db.prepare('SELECT * FROM map_memberships WHERE id = ?').get(id);
}
