import { Router } from 'express';
import { z } from 'zod';
import { authenticated, audit } from '../lib/auth.js';
import { asyncRoute, fail } from '../lib/errors.js';
import { ensureMembership, upsertGameIdentity } from '../lib/identities.js';
import { getMap, getMember, mapActor } from '../lib/maps.js';
import { issueMemberSession, setMemberCookie, viewerForMap } from '../lib/member-auth.js';
import { hashToken, now, randomToken, uuid, verifyPassword } from '../lib/security.js';

function joinRequestView(row) {
  return {
    id: row.id, mapId: row.map_id, userId: row.user_id, gameId: row.game_id,
    gameName: row.game_name, evidence: row.evidence, status: row.status, createdAt: row.created_at
  };
}

function reviewer(req, database, map) {
  const viewer = viewerForMap(req, map.id);
  const member = getMember(database, map.id, viewer.userId, viewer.gameIdentityId);
  const actor = mapActor(database, map.id, viewer.userId, viewer.gameIdentityId);
  if (!actor?.isTHolder && !actor?.isLeader) fail(403, 'FORBIDDEN', '只有当前 T 权限持有者或盟主可以审批');
  return { viewer, member, actor };
}

export function createJoinRouter(config) {
  const router = Router();

  router.get('/join-requests/mine', authenticated, (req, res) => {
    const rows = req.app.locals.db.prepare(`SELECT join_requests.*, game_identities.game_id FROM join_requests
      JOIN game_identities ON game_identities.id = join_requests.game_identity_id
      WHERE join_requests.user_id = ? ORDER BY join_requests.created_at DESC LIMIT 100`).all(req.user.id);
    res.json({ requests: rows.map(joinRequestView) });
  });

  router.get('/:mapId/game-identities', (req, res) => {
    const input = z.object({ gameName: z.string().trim().min(1).max(80) }).parse(req.query);
    getMap(req.app.locals.db, req.params.mapId);
    const rows = req.app.locals.db.prepare('SELECT game_id, game_name FROM game_identities WHERE game_name = ? ORDER BY game_id LIMIT 50').all(input.gameName);
    res.json({ candidates: rows.map((row) => ({ gameId: row.game_id, gameName: row.game_name })) });
  });

  router.post('/:mapId/join-requests', asyncRoute(async (req, res) => {
    const input = z.object({
      gameId: z.string().trim().min(1).max(80).optional(),
      gameName: z.string().trim().min(1).max(80),
      joinPassword: z.string().min(1).max(72),
      evidence: z.string().trim().max(2000).optional()
    }).parse(req.body);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    if (map.status !== 'active') fail(409, 'MAP_NOT_JOINABLE', '地图当前不可加入');
    if (!(await verifyPassword(input.joinPassword, map.join_password_hash))) fail(401, 'JOIN_PASSWORD_INVALID', '加入密码错误');
    if (map.review_required && !input.evidence) fail(400, 'EVIDENCE_REQUIRED', '该地图要求加入申请附证据');

    const candidates = database.prepare('SELECT * FROM game_identities WHERE game_name = ? ORDER BY game_id LIMIT 50').all(input.gameName);
    if (!candidates.length) fail(404, 'GAME_IDENTITY_NOT_FOUND', '没有客户端上报的同名游戏身份，请确认游戏名或等待客户端同步');
    if (candidates.length > 1 && !input.gameId) fail(409, 'IDENTITY_DISAMBIGUATION_REQUIRED', '存在重名，必须从候选列表选择游戏内 ID');
    const identity = input.gameId
      ? candidates.find((candidate) => candidate.game_id === input.gameId)
      : candidates[0];
    if (!identity) fail(400, 'IDENTITY_CANDIDATE_INVALID', '游戏内 ID 必须来自该游戏名的候选列表');
    if (getMember(database, map.id, null, identity.id)) fail(409, 'ALREADY_JOINED', '该游戏身份已加入地图');
    const pending = database.prepare("SELECT id FROM join_requests WHERE map_id = ? AND game_identity_id = ? AND status = 'pending'").get(map.id, identity.id);
    if (pending) fail(409, 'JOIN_REQUEST_PENDING', '该游戏身份已有待审批的加入申请');

    const id = uuid();
    const receipt = randomToken();
    const userId = req.user?.id || null;
    database.transaction(() => {
      upsertGameIdentity(database, { gameId: identity.game_id, gameName: input.gameName });
      database.prepare(`INSERT INTO join_requests
        (id, map_id, user_id, game_identity_id, game_name, evidence, receipt_token_hash, status, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(id, map.id, userId, identity.id, input.gameName, input.evidence || null, hashToken(receipt), now(), now());
      audit(database, map.id, userId, 'join.requested', id, { gameId: identity.game_id, guest: !userId });
    })();
    res.status(201).json({ id, receipt, status: 'pending', approvers: ['current_t_holder', 'leader'], anyApprovalSuffices: true });
  }));

  router.post('/:mapId/join-requests/:requestId/session', (req, res) => {
    const input = z.object({ receipt: z.string().min(20).max(500) }).parse(req.body);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const request = database.prepare('SELECT * FROM join_requests WHERE id = ? AND map_id = ? AND receipt_token_hash = ?')
      .get(req.params.requestId, map.id, hashToken(input.receipt));
    if (!request) fail(404, 'JOIN_REQUEST_NOT_FOUND', '加入申请不存在或回执无效');
    if (request.status !== 'approved') return res.json({ id: request.id, status: request.status });
    const member = getMember(database, map.id, null, request.game_identity_id);
    if (!member) fail(403, 'MEMBERSHIP_UNAVAILABLE', '成员资格当前不可用');
    const session = issueMemberSession(database, config, map.id, request.game_identity_id);
    setMemberCookie(res, config, session.token, session.expires);
    res.json({
      id: request.id, status: request.status, expiresAt: session.expires,
      member: { gameName: request.game_name, mapId: map.id }
    });
  });

  router.get('/:mapId/join-requests/inbox', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    reviewer(req, database, map);
    const rows = database.prepare(`SELECT join_requests.*, game_identities.game_id FROM join_requests
      JOIN game_identities ON game_identities.id = join_requests.game_identity_id
      WHERE join_requests.map_id = ? AND join_requests.status = 'pending'
      ORDER BY join_requests.created_at LIMIT 200`).all(map.id);
    res.json({ requests: rows.map(joinRequestView) });
  });

  router.post('/:mapId/join-requests/:requestId/review', (req, res) => {
    const input = z.object({ decision: z.enum(['approve', 'reject']), as: z.enum(['t', 'leader']).optional() }).parse(req.body);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const { viewer, member, actor } = reviewer(req, database, map);
    const roles = [actor.isTHolder ? 't' : null, actor.isLeader ? 'leader' : null].filter(Boolean);
    const reviewerKind = input.as || roles[0];
    if (!roles.includes(reviewerKind)) fail(403, 'FORBIDDEN', '不能以未持有的审批角色操作');
    const request = database.prepare("SELECT * FROM join_requests WHERE id = ? AND map_id = ? AND status = 'pending'").get(req.params.requestId, map.id);
    if (!request) fail(404, 'JOIN_REQUEST_NOT_FOUND', '加入申请不存在或已处理');
    if (database.prepare('SELECT 1 FROM join_request_reviews WHERE request_id = ? AND reviewer_kind = ?').get(request.id, reviewerKind)) {
      fail(409, 'ALREADY_REVIEWED', '该审批角色已经处理过此申请');
    }

    let status = 'pending';
    database.transaction(() => {
      database.prepare(`INSERT INTO join_request_reviews
        (id, request_id, reviewer_member_id, reviewer_kind, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(uuid(), request.id, member.id, reviewerKind, input.decision, now());
      if (input.decision === 'approve') {
        ensureMembership(database, map.id, null, request.game_identity_id);
        status = 'approved';
      } else {
        const eligible = new Set();
        if (database.prepare("SELECT 1 FROM map_memberships WHERE map_id = ? AND is_t_holder = 1 AND status = 'active'").get(map.id)) eligible.add('t');
        if (database.prepare("SELECT 1 FROM map_memberships WHERE map_id = ? AND is_leader = 1 AND status = 'active'").get(map.id)) eligible.add('leader');
        const rejected = new Set(database.prepare("SELECT reviewer_kind FROM join_request_reviews WHERE request_id = ? AND decision = 'reject'").all(request.id).map((row) => row.reviewer_kind));
        if ([...eligible].every((role) => rejected.has(role))) status = 'rejected';
      }
      if (status !== 'pending') database.prepare('UPDATE join_requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), request.id);
      audit(database, map.id, viewer.userId, `join.${status === 'pending' ? 'review_recorded' : status}`, request.id, { reviewerKind });
    })();
    res.json({ status });
  });

  router.post('/:mapId/join-requests/:requestId/cancel', authenticated, (req, res) => {
    const result = req.app.locals.db.prepare(`UPDATE join_requests SET status = 'cancelled', resolved_at = ?
      WHERE id = ? AND map_id = ? AND user_id = ? AND status = 'pending'`)
      .run(now(), req.params.requestId, req.params.mapId, req.user.id);
    if (!result.changes) fail(404, 'JOIN_REQUEST_NOT_FOUND', '加入申请不存在或已处理');
    res.status(204).end();
  });

  return router;
}
