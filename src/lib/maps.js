import { fail } from './errors.js';
import { adminPermissionsFor, actorFromMembership, canViewMap, loadActor } from './permissions.js';
import { now, uuid } from './security.js';

export function getMap(db, mapId) {
  const map = db.prepare('SELECT * FROM maps WHERE id = ?').get(mapId);
  if (!map) fail(404, 'MAP_NOT_FOUND', '地图不存在');
  return map;
}

export function getVersion(db, versionId) {
  return versionId ? db.prepare('SELECT * FROM map_versions WHERE id = ?').get(versionId) : null;
}

export function currentVersion(db, map) {
  return getVersion(db, map.current_version_id);
}

export function getMember(db, mapId, userId) {
  return db.prepare(`SELECT * FROM map_memberships WHERE map_id = ? AND user_id = ? AND status = 'active'`).get(mapId, userId);
}

export function requireCreator(db, map, userId) {
  if (map.creator_user_id !== userId) fail(403, 'CREATOR_ONLY', '只有地图创建者可以执行此操作');
}

export function requireMapView(db, map, userId) {
  const member = getMember(db, map.id, userId);
  const actor = actorFromMembership(member, member ? adminPermissionsFor(db, member.id) : []);
  if (!canViewMap(map, actor)) fail(403, 'MAP_UNAVAILABLE', '地图当前不可查看');
  return { member, actor };
}

export function serializeMap(db, map, userId = null) {
  const version = currentVersion(db, map);
  const organizationName = version?.organization_name || '联合体待上报';
  const membership = userId ? getMember(db, map.id, userId) : null;
  return {
    id: map.id,
    name: map.name,
    displayName: `（${organizationName}）的（${map.name}）的地图`,
    status: map.status,
    reviewRequired: Boolean(map.review_required),
    wizardStep: map.wizard_step,
    creatorUserId: map.creator_user_id,
    organization: version ? { id: version.organization_id, name: version.organization_name } : null,
    galaxy: version ? { id: version.galaxy_id, name: version.galaxy_name } : null,
    joined: Boolean(membership),
    isCreator: Boolean(membership?.is_creator),
    isTHolder: Boolean(membership?.is_t_holder),
    isLeader: Boolean(membership?.is_leader),
    createdAt: map.created_at,
    activatedAt: map.activated_at
  };
}

export function createVersion(db, mapId, context) {
  const id = uuid();
  const timestamp = now();
  db.prepare(`INSERT INTO map_versions
    (id, map_id, galaxy_id, galaxy_name, organization_id, organization_name, protocol_version, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
    .run(id, mapId, context.galaxyId, context.galaxyName, context.organizationId,
      context.organizationName, context.protocolVersion, timestamp);
  return db.prepare('SELECT * FROM map_versions WHERE id = ?').get(id);
}

export function archiveVersion(db, map, version, reason) {
  if (!version) return;
  const timestamp = now();
  db.prepare("UPDATE map_versions SET status = 'historical', ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(timestamp, version.id);
  const counts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM map_snapshots WHERE version_id = ?) AS snapshots,
    (SELECT COUNT(*) FROM map_roster WHERE version_id = ?) AS roster`).get(version.id, version.id);
  db.prepare(`INSERT INTO archives (id, map_id, version_id, reason, summary_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(version_id) DO NOTHING`)
    .run(uuid(), map.id, version.id, reason, JSON.stringify({
      galaxyId: version.galaxy_id,
      galaxyName: version.galaxy_name,
      organizationId: version.organization_id,
      organizationName: version.organization_name,
      snapshots: counts.snapshots,
      roster: counts.roster
    }), timestamp);
}

export function mapActor(db, mapId, userId) {
  return loadActor(db, mapId, userId);
}
