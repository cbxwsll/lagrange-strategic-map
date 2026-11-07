import { audit } from './auth.js';
import { ensureMembership, upsertGameIdentity } from './identities.js';
import { fail } from './errors.js';
import { now } from './security.js';

export function replaceRoster(db, map, version, roster) {
  const timestamp = now();
  db.prepare('DELETE FROM map_roster WHERE map_id = ? AND version_id = ?').run(map.id, version.id);
  db.prepare("UPDATE map_memberships SET is_leader = 0, updated_at = ? WHERE map_id = ?").run(timestamp, map.id);
  for (const entry of roster) {
    const identity = upsertGameIdentity(db, { gameId: entry.gameId, gameName: entry.gameName });
    db.prepare(`INSERT INTO map_roster
      (map_id, version_id, game_identity_id, game_name, is_leader, team_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(map.id, version.id, identity.id, entry.gameName, entry.isLeader ? 1 : 0, entry.teamId || null, timestamp);
    db.prepare(`UPDATE map_memberships SET is_leader = ?, team_id = COALESCE(?, team_id), updated_at = ?
      WHERE map_id = ? AND game_identity_id = ?`)
      .run(entry.isLeader ? 1 : 0, entry.teamId || null, timestamp, map.id, identity.id);
  }
  if (roster.length && map.data_account_game_id) {
    const dataAccountPresent = roster.some((entry) => entry.gameId === map.data_account_game_id);
    if (!dataAccountPresent && map.status !== 'draft' && map.status !== 'merged') {
      db.prepare("UPDATE maps SET status = 'suspended', updated_at = ? WHERE id = ?").run(timestamp, map.id);
    }
  }
}

export function reconcileRoster(db, map, version, actorUserId) {
  const roster = db.prepare('SELECT * FROM map_roster WHERE map_id = ? AND version_id = ?').all(map.id, version.id);
  if (!roster.length) fail(409, 'ROSTER_REQUIRED', '恢复前需要本地客户端先上报联合体 roster');
  const allowed = new Set(roster.map((entry) => entry.game_identity_id));
  const members = db.prepare(`SELECT * FROM map_memberships WHERE map_id = ? AND status = 'active'`).all(map.id);
  const timestamp = now();
  for (const member of members) {
    if (member.is_creator || !member.game_identity_id || allowed.has(member.game_identity_id)) continue;
    db.prepare("UPDATE map_memberships SET status = 'removed', is_t_holder = 0, is_leader = 0, is_captain = 0, updated_at = ? WHERE id = ?")
      .run(timestamp, member.id);
    db.prepare('DELETE FROM map_admin_permissions WHERE member_id = ?').run(member.id);
    audit(db, map.id, actorUserId, 'roster.member_removed', member.id, { gameIdentityId: member.game_identity_id });

    const identity = db.prepare('SELECT * FROM game_identities WHERE id = ?').get(member.game_identity_id);
    const otherMaps = db.prepare(`SELECT DISTINCT maps.* FROM maps
      JOIN map_roster ON map_roster.map_id = maps.id AND map_roster.version_id = maps.current_version_id
      WHERE map_roster.game_identity_id = ? AND maps.id <> ? AND maps.status = 'active'`)
      .all(member.game_identity_id, map.id);
    for (const otherMap of otherMaps) {
      ensureMembership(db, otherMap.id, member.user_id, identity.id);
      audit(db, otherMap.id, actorUserId, 'roster.member_auto_joined', member.user_id, { fromMapId: map.id });
    }
  }
  return { removed: members.filter((member) => !member.is_creator && member.game_identity_id && !allowed.has(member.game_identity_id)).length };
}
