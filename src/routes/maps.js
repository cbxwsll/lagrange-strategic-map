import { Router } from 'express';
import { z } from 'zod';
import { authenticated, audit } from '../lib/auth.js';
import { asyncRoute, fail } from '../lib/errors.js';
import { mapViewAuthenticated, viewerForMap } from '../lib/member-auth.js';
import { ensureMembership } from '../lib/identities.js';
import {
  archiveVersion, currentVersion, getMap, getMember, getVersion,
  mapActor, requireCreator, requireMapView, serializeMap
} from '../lib/maps.js';
import { assertArchiveDelete } from '../lib/permissions.js';
import { reconcileRoster } from '../lib/roster.js';
import { assertPasswordComplexity, hashPassword, now, randomToken, hashToken, uuid } from '../lib/security.js';

const wizardInfoInput = z.object({
  name: z.string().trim().min(1).max(80),
  creatorGameName: z.string().trim().min(1).max(80),
  creatorGameId: z.string().trim().min(1).max(80).optional(),
  reviewRequired: z.boolean().default(false),
  joinPassword: z.string().min(1).max(72)
});

function contextView(context) {
  if (!context) return { online: false, firstDataReceived: false, lastSeenAt: null };
  return {
    online: Date.now() - Date.parse(context.last_seen_at) < 90_000,
    firstDataReceived: true,
    lastSeenAt: context.last_seen_at,
    galaxy: { id: context.galaxy_id, name: context.galaxy_name },
    organization: { id: context.organization_id, name: context.organization_name },
    protocolVersion: context.protocol_version,
    serverStatus: context.server_status
  };
}

function creatorCandidates(database, context, gameName = null) {
  if (!context) return [];
  const rows = database.prepare(`SELECT game_identities.id, game_identities.game_id, game_identities.game_name,
      map_roster.team_id, map_roster.is_leader, map_versions.organization_id, map_versions.organization_name
    FROM map_roster
    JOIN game_identities ON game_identities.id = map_roster.game_identity_id
    JOIN map_versions ON map_versions.id = map_roster.version_id
    WHERE map_roster.version_id = ? AND game_identities.is_observer = 0
      AND (? IS NULL OR game_identities.game_name = ?)
    ORDER BY game_identities.game_name, game_identities.game_id`)
    .all(context.version_id, gameName, gameName);
  return rows.map((row) => ({
    id: row.id,
    gameId: row.game_id,
    gameName: row.game_name,
    teamId: row.team_id,
    isLeader: Boolean(row.is_leader),
    organization: { id: row.organization_id, name: row.organization_name }
  }));
}

function assertCreatorNotObserver(database, context, gameName) {
  const observer = database.prepare('SELECT game_name FROM game_identities WHERE id = ?').get(context.game_identity_id);
  if (observer?.game_name === gameName) fail(403, 'OBSERVER_NOT_USER', '观察员小号只作数据来源，创建者请填写大号游戏角色名');
}

export function createMapsRouter(config) {
  const router = Router();

  router.get('/wizard-prep', authenticated, (req, res) => {
    res.json({
      step: 1,
      requirements: ['一个与大号同联合体、网易官服、完全不用的小号', '一台 24 小时开机的电脑'],
      why: '因为这个地图要给联合体使用为了让你的盟友能通过游戏信息方便的加入且方便管理，能避免手动给账号加入。需要小号的原因是为了获取舰队信息账号需要24H在线。'
    });
  });

  router.get('/', (req, res) => {
    const memberMapId = req.memberSession?.map_id || null;
    const memberIdentityId = req.memberSession?.game_identity_id || null;
    const maps = req.app.locals.db.prepare(`SELECT DISTINCT maps.* FROM maps
      LEFT JOIN map_memberships mine ON mine.map_id = maps.id AND mine.status = 'active' AND (
        (? IS NOT NULL AND mine.user_id = ?) OR
        (? IS NOT NULL AND mine.map_id = ? AND mine.game_identity_id = ?)
      )
      WHERE maps.status NOT IN ('draft', 'merged') OR maps.creator_user_id = ? OR mine.id IS NOT NULL
      ORDER BY CASE WHEN mine.id IS NOT NULL THEN 0 ELSE 1 END, maps.created_at DESC LIMIT 200`)
      .all(req.user?.id || null, req.user?.id || null, memberMapId, memberMapId,
        memberIdentityId, req.user?.id || null);
    res.json({ maps: maps.map((map) => {
      const viewer = viewerForMap(req, map.id);
      return serializeMap(req.app.locals.db, map, viewer.userId, viewer.gameIdentityId);
    }) });
  });

  router.get('/:mapId', mapViewAuthenticated, (req, res) => {
    const map = getMap(req.app.locals.db, req.params.mapId);
    const viewer = viewerForMap(req, map.id);
    requireMapView(req.app.locals.db, map, viewer.userId, viewer.gameIdentityId);
    res.json({ map: serializeMap(req.app.locals.db, map, viewer.userId, viewer.gameIdentityId) });
  });

  router.get('/:mapId/archives', mapViewAuthenticated, (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const viewer = viewerForMap(req, map.id);
    requireMapView(database, map, viewer.userId, viewer.gameIdentityId);
    const rows = database.prepare(`SELECT archives.*, map_versions.galaxy_name, map_versions.organization_name FROM archives
      JOIN map_versions ON map_versions.id = archives.version_id
      WHERE archives.map_id = ? OR archives.map_id IN (SELECT id FROM maps WHERE merged_into_map_id = ?)
      ORDER BY archives.created_at DESC LIMIT 200`).all(map.id, map.id);
    res.json({ archives: rows.map((row) => ({ id: row.id, mapId: row.map_id, versionId: row.version_id, reason: row.reason,
      galaxyName: row.galaxy_name, organizationName: row.organization_name, summary: JSON.parse(row.summary_json), createdAt: row.created_at })) });
  });

  router.use(authenticated);

  router.post('/', asyncRoute(async (req, res) => {
    z.object({}).strict().parse(req.body || {});
    const database = req.app.locals.db;
    const mapId = uuid();
    const memberId = uuid();
    const timestamp = now();
    database.transaction(() => {
      database.prepare(`INSERT INTO maps
        (id, creator_user_id, status, wizard_step, created_at, updated_at)
        VALUES (?, ?, 'draft', 2, ?, ?)`)
        .run(mapId, req.user.id, timestamp, timestamp);
      database.prepare(`INSERT INTO map_memberships
        (id, map_id, user_id, is_creator, is_t_holder, joined_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)`)
        .run(memberId, mapId, req.user.id, timestamp, timestamp);
      audit(database, mapId, req.user.id, 'map.created', mapId);
    })();
    res.status(201).json({ map: serializeMap(database, database.prepare('SELECT * FROM maps WHERE id = ?').get(mapId), req.user.id) });
  }));

  router.get('/:mapId/wizard', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    const context = database.prepare('SELECT * FROM client_contexts WHERE map_id = ?').get(map.id);
    const snapshots = context ? database.prepare('SELECT COUNT(*) AS count FROM map_snapshots WHERE version_id = ?').get(context.version_id).count : 0;
    const client = contextView(context);
    const candidates = creatorCandidates(database, context);
    const ready = Boolean(context && snapshots > 0 && client.online);
    res.json({
      step: map.wizard_step,
      map: serializeMap(database, map, req.user.id),
      client,
      creatorCandidates: candidates,
      suggestedName: context ? `（${context.organization_name}）的地图` : null,
      firstDataReceived: snapshots > 0,
      canContinueToInfo: ready,
      canActivate: Boolean(ready && map.name && map.creator_game_name && map.join_password_hash)
    });
  });

  router.get('/:mapId/creator-candidates', (req, res) => {
    const input = z.object({ gameName: z.string().trim().min(1).max(80) }).parse(req.query);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    const context = database.prepare('SELECT * FROM client_contexts WHERE map_id = ?').get(map.id);
    if (!context) return res.json({ candidates: [], warning: '等待客户端上报' });
    assertCreatorNotObserver(database, context, input.gameName);
    const candidates = creatorCandidates(database, context, input.gameName);
    res.json({
      candidates,
      warning: candidates.length ? null : '未在客户端已抓到的玩家数据中找到该角色，可继续创建，但暂时只记录角色名'
    });
  });

  router.post('/:mapId/wizard', asyncRoute(async (req, res) => {
    const input = wizardInfoInput.parse(req.body);
    assertPasswordComplexity(input.joinPassword, 'joinPassword');
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    if (map.status !== 'draft') fail(409, 'MAP_NOT_DRAFT', '地图不处于创建向导状态');
    const context = database.prepare('SELECT * FROM client_contexts WHERE map_id = ?').get(map.id);
    const snapshots = context ? database.prepare('SELECT COUNT(*) AS count FROM map_snapshots WHERE version_id = ?').get(context.version_id).count : 0;
    if (!context || !snapshots || !contextView(context).online) {
      fail(409, 'CLIENT_CONTEXT_REQUIRED', '客户端上线、登录并选择势力后才能填写地图信息');
    }
    assertCreatorNotObserver(database, context, input.creatorGameName);
    const candidates = creatorCandidates(database, context, input.creatorGameName);
    if (candidates.length > 1 && !input.creatorGameId) {
      fail(409, 'CREATOR_IDENTITY_DISAMBIGUATION_REQUIRED', '存在重名，必须从候选列表选择大号角色 ID', { candidates });
    }
    const identity = input.creatorGameId
      ? candidates.find((candidate) => candidate.gameId === input.creatorGameId)
      : candidates.length === 1 ? candidates[0] : null;
    if (input.creatorGameId && !identity) fail(400, 'CREATOR_IDENTITY_INVALID', '大号角色 ID 必须来自该角色名的候选列表');
    const joinPasswordHash = await hashPassword(input.joinPassword, config.bcryptRounds);
    database.transaction(() => {
      database.prepare(`UPDATE maps SET name = ?, creator_game_name = ?, creator_game_identity_id = ?,
        join_password_hash = ?, review_required = ?, wizard_step = 3, updated_at = ? WHERE id = ?`)
        .run(input.name, input.creatorGameName, identity?.id || null, joinPasswordHash, input.reviewRequired ? 1 : 0, now(), map.id);
      const membership = database.prepare('SELECT * FROM map_memberships WHERE map_id = ? AND user_id = ?').get(map.id, req.user.id);
      database.prepare('UPDATE map_memberships SET game_identity_id = ?, updated_at = ? WHERE id = ?')
        .run(identity?.id || null, now(), membership.id);
      audit(database, map.id, req.user.id, 'map.wizard_completed', map.id, {
        creatorGameName: input.creatorGameName, creatorGameIdentityId: identity?.id || null
      });
    })();
    res.json({
      map: serializeMap(database, getMap(database, map.id), req.user.id),
      creatorIdentityMatched: Boolean(identity),
      creatorWarning: identity ? null : '未匹配到大号角色 ID，已只保存角色名并允许继续'
    });
  }));

  router.post('/:mapId/client-tokens', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const actor = mapActor(database, map.id, req.user.id);
    if (!actor?.isCreator && !actor?.isTHolder && !actor?.permissions.has('client.manage')) {
      fail(403, 'FORBIDDEN', '没有客户端令牌管理权限');
    }
    const token = randomToken();
    const id = uuid();
    database.prepare('INSERT INTO client_tokens (id, map_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, map.id, hashToken(token), req.body?.label || '默认客户端', now());
    audit(database, map.id, req.user.id, 'client.token_issued', id);
    res.status(201).json({ id, token, warning: '令牌仅显示一次，服务端只保存哈希' });
  });

  router.delete('/:mapId/client-tokens/:tokenId', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    const result = database.prepare('UPDATE client_tokens SET revoked_at = ? WHERE id = ? AND map_id = ? AND revoked_at IS NULL')
      .run(now(), req.params.tokenId, map.id);
    if (!result.changes) fail(404, 'TOKEN_NOT_FOUND', '客户端令牌不存在或已撤销');
    audit(database, map.id, req.user.id, 'client.token_revoked', req.params.tokenId);
    res.status(204).end();
  });

  router.post('/:mapId/activate', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    if (map.status !== 'draft') fail(409, 'MAP_NOT_DRAFT', '地图不处于创建向导状态');
    const context = database.prepare('SELECT * FROM client_contexts WHERE map_id = ?').get(map.id);
    const snapshots = context ? database.prepare('SELECT COUNT(*) AS count FROM map_snapshots WHERE version_id = ?').get(context.version_id).count : 0;
    if (!context || !snapshots) fail(409, 'FIRST_DATA_REQUIRED', '首批客户端数据到达后才能激活地图');
    if (!map.name || !map.creator_game_name || !map.join_password_hash) {
      fail(409, 'MAP_INFO_REQUIRED', '填写大号角色名、地图信息并设置加入密码后才能激活地图');
    }
    database.prepare("UPDATE maps SET current_version_id = ?, status = 'active', wizard_step = 4, activated_at = ?, updated_at = ? WHERE id = ?")
      .run(context.version_id, now(), now(), map.id);
    audit(database, map.id, req.user.id, 'map.activated', map.id);
    res.json({ map: serializeMap(database, getMap(database, map.id), req.user.id) });
  });

  router.post('/:mapId/roster/check', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    const version = currentVersion(database, map);
    const result = reconcileRoster(database, map, version, req.user.id);
    audit(database, map.id, req.user.id, 'roster.checked', version.id, result);
    res.json(result);
  });

  router.post('/:mapId/resume-access', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    if (map.status !== 'suspended') fail(409, 'MAP_NOT_SUSPENDED', '地图当前不是数据号离盟下线状态');
    const context = database.prepare('SELECT * FROM client_contexts WHERE map_id = ?').get(map.id);
    if (!context?.observer_in_roster) fail(409, 'DATA_ACCOUNT_NOT_IN_ROSTER', '数据号尚未回到联合体 roster');
    database.prepare("UPDATE maps SET status = 'active', updated_at = ? WHERE id = ?").run(now(), map.id);
    audit(database, map.id, req.user.id, 'map.access_resumed', map.id);
    res.json({ map: serializeMap(database, getMap(database, map.id), req.user.id) });
  });

  router.post('/:mapId/restore', (req, res) => {
    const input = z.object({ mode: z.enum(['same_organization', 'different_organization']) }).parse(req.body);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    const previous = currentVersion(database, map);
    const context = database.prepare('SELECT * FROM client_contexts WHERE map_id = ?').get(map.id);
    if (!previous || !context || context.version_id === previous.id) fail(409, 'NEW_GALAXY_REQUIRED', '客户端尚未上报新星系数据');
    const next = getVersion(database, context.version_id);
    const sameOrganization = previous.organization_id === next.organization_id;
    if ((input.mode === 'same_organization') !== sameOrganization) {
      fail(400, 'RESTORE_MODE_MISMATCH', '恢复选项与客户端上报的联合体信息不一致');
    }
    let result;
    database.transaction(() => {
      archiveVersion(database, map, previous, input.mode === 'same_organization' ? 'same_organization_restore' : 'different_organization_restore');
      database.prepare("UPDATE map_versions SET status = 'active', ended_at = NULL WHERE id = ?").run(next.id);
      database.prepare("UPDATE maps SET current_version_id = ?, status = 'active', updated_at = ? WHERE id = ?").run(next.id, now(), map.id);
      result = reconcileRoster(database, map, next, req.user.id);
      audit(database, map.id, req.user.id, 'map.restored', next.id, { mode: input.mode, ...result });
    })();
    res.json({ map: serializeMap(database, getMap(database, map.id), req.user.id), roster: result });
  });

  router.delete('/:mapId/archives/:archiveId', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const actor = mapActor(database, map.id, req.user.id);
    assertArchiveDelete(actor);
    const archive = database.prepare('SELECT * FROM archives WHERE id = ? AND map_id = ?').get(req.params.archiveId, map.id);
    if (!archive) fail(404, 'ARCHIVE_NOT_FOUND', '档案不存在');
    const used = database.prepare('SELECT COUNT(*) AS count FROM map_snapshots WHERE version_id = ?').get(archive.version_id).count;
    if (used) {
      database.prepare('DELETE FROM map_snapshots WHERE version_id = ?').run(archive.version_id);
    }
    database.prepare('DELETE FROM archives WHERE id = ?').run(archive.id);
    database.prepare('DELETE FROM map_versions WHERE id = ?').run(archive.version_id);
    audit(database, map.id, req.user.id, 'archive.deleted', archive.id);
    res.status(204).end();
  });

  router.get('/:mapId/merge-requests', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    requireCreator(database, map, req.user.id);
    const rows = database.prepare(`SELECT * FROM merge_requests WHERE source_map_id = ? OR target_map_id = ?
      ORDER BY created_at DESC LIMIT 100`).all(map.id, map.id);
    res.json({ requests: rows.map((row) => ({ id: row.id, sourceMapId: row.source_map_id, targetMapId: row.target_map_id,
      direction: row.source_map_id === map.id ? 'outgoing' : 'incoming', status: row.status, createdAt: row.created_at })) });
  });

  router.post('/:mapId/merge-requests', (req, res) => {
    const input = z.object({ targetMapId: z.string().uuid() }).parse(req.body);
    const database = req.app.locals.db;
    const source = getMap(database, req.params.mapId);
    requireCreator(database, source, req.user.id);
    const target = getMap(database, input.targetMapId);
    if (source.id === target.id || source.status !== 'active' || target.status !== 'active') fail(409, 'MAP_NOT_MERGEABLE', '两张地图都必须处于活跃状态');
    const pending = database.prepare("SELECT id FROM merge_requests WHERE source_map_id = ? AND target_map_id = ? AND status = 'pending'").get(source.id, target.id);
    if (pending) fail(409, 'MERGE_ALREADY_PENDING', '已有待处理的合并申请');
    const id = uuid();
    database.prepare(`INSERT INTO merge_requests (id, source_map_id, target_map_id, requester_user_id, status, created_at, resolved_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(id, source.id, target.id, req.user.id, now(), now());
    audit(database, source.id, req.user.id, 'merge.requested', id, { targetMapId: target.id });
    res.status(201).json({ id, status: 'pending' });
  });

  router.post('/:mapId/merge-requests/:requestId/review', (req, res) => {
    const input = z.object({ decision: z.enum(['approve', 'reject']) }).parse(req.body);
    const database = req.app.locals.db;
    const target = getMap(database, req.params.mapId);
    requireCreator(database, target, req.user.id);
    const request = database.prepare("SELECT * FROM merge_requests WHERE id = ? AND target_map_id = ? AND status = 'pending'").get(req.params.requestId, target.id);
    if (!request) fail(404, 'MERGE_REQUEST_NOT_FOUND', '合并申请不存在或已处理');
    database.transaction(() => {
      database.prepare('UPDATE merge_requests SET status = ?, resolved_at = ? WHERE id = ?').run(input.decision === 'approve' ? 'approved' : 'rejected', now(), request.id);
      if (input.decision === 'reject') return;
      const source = getMap(database, request.source_map_id);
      const sourceMembers = database.prepare("SELECT * FROM map_memberships WHERE map_id = ? AND status = 'active'").all(source.id);
      for (const member of sourceMembers) {
        const identityOwner = member.game_identity_id
          ? database.prepare('SELECT user_id FROM map_memberships WHERE map_id = ? AND game_identity_id = ?').get(target.id, member.game_identity_id)
          : null;
        const identityId = member.user_id && identityOwner && identityOwner.user_id !== member.user_id
          ? null
          : member.game_identity_id;
        const copied = ensureMembership(database, target.id, member.user_id, identityId);
        const permissions = database.prepare('SELECT permission FROM map_admin_permissions WHERE member_id = ?').all(member.id);
        for (const row of permissions) {
          database.prepare('INSERT OR IGNORE INTO map_admin_permissions (member_id, permission, granted_by, created_at) VALUES (?, ?, NULL, ?)')
            .run(copied.id, row.permission, now());
        }
      }
      const sourceVersion = currentVersion(database, source);
      archiveVersion(database, source, sourceVersion, 'merged');
      database.prepare("UPDATE maps SET status = 'merged', merged_into_map_id = ?, updated_at = ? WHERE id = ?").run(target.id, now(), source.id);
      database.prepare('UPDATE client_tokens SET revoked_at = ? WHERE map_id = ? AND revoked_at IS NULL').run(now(), source.id);
      audit(database, target.id, req.user.id, 'merge.approved', request.id, { sourceMapId: source.id });
    })();
    res.json({ status: input.decision === 'approve' ? 'approved' : 'rejected' });
  });

  return router;
}
