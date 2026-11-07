import { Router } from 'express';
import { z } from 'zod';
import { authenticated, audit } from '../lib/auth.js';
import { asyncRoute, fail } from '../lib/errors.js';
import { ensureMembership, upsertGameIdentity } from '../lib/identities.js';
import { getMap, getMember, mapActor } from '../lib/maps.js';
import { now, uuid, verifyPassword } from '../lib/security.js';

function joinRequestView(row) {
  return { id: row.id, mapId: row.map_id, userId: row.user_id, gameName: row.game_name,
    evidence: row.evidence, status: row.status, createdAt: row.created_at };
}

export function createJoinRouter() {
  const router = Router();
  router.use(authenticated);

  router.get('/join-requests/mine', (req, res) => {
    const rows = req.app.locals.db.prepare('SELECT * FROM join_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
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
      gameId: z.string().trim().min(1).max(80),
      gameName: z.string().trim().min(1).max(80),
      joinPassword: z.string().min(1).max(72),
      evidence: z.string().trim().max(2000).optional()
    }).parse(req.body);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    if (map.status !== 'active') fail(409, 'MAP_NOT_JOINABLE', '地图当前不可加入');
    if (getMember(database, map.id, req.user.id)) fail(409, 'ALREADY_JOINED', '已加入该地图');
    if (!(await verifyPassword(input.joinPassword, map.join_password_hash))) fail(401, 'JOIN_PASSWORD_INVALID', '加入密码错误');
    if (map.review_required && !input.evidence) fail(400, 'EVIDENCE_REQUIRED', '该地图要求加入申请附证据');
    const existingIdentity = database.prepare('SELECT * FROM game_identities WHERE game_id = ?').get(input.gameId);
    if (existingIdentity?.user_id && existingIdentity.user_id !== req.user.id) fail(409, 'GAME_ID_BOUND', '该游戏内 ID 已绑定其他网站账号');
    const identity = upsertGameIdentity(database, { gameId: input.gameId, gameName: input.gameName });
    const pending = database.prepare("SELECT * FROM join_requests WHERE map_id = ? AND user_id = ? AND status = 'pending'").get(map.id, req.user.id);
    if (pending) fail(409, 'JOIN_REQUEST_PENDING', '已有待审批的加入申请');
    const id = uuid();
    database.prepare(`INSERT INTO join_requests
      (id, map_id, user_id, game_identity_id, game_name, evidence, status, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, map.id, req.user.id, identity.id, input.gameName, input.evidence || null, now(), now());
    audit(database, map.id, req.user.id, 'join.requested', id, { gameId: input.gameId });
    res.status(201).json({ id, status: 'pending', approvers: ['current_t_holder', 'leader'], anyApprovalSuffices: true });
  }));

  router.get('/:mapId/join-requests/inbox', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const actor = mapActor(database, map.id, req.user.id);
    if (!actor?.isTHolder && !actor?.isLeader) fail(403, 'FORBIDDEN', '只有当前 T 权限持有者或盟主可以查看申请');
    const rows = database.prepare("SELECT * FROM join_requests WHERE map_id = ? AND status = 'pending' ORDER BY created_at LIMIT 200").all(map.id);
    res.json({ requests: rows.map(joinRequestView) });
  });

  router.post('/:mapId/join-requests/:requestId/review', (req, res) => {
    const input = z.object({ decision: z.enum(['approve', 'reject']), as: z.enum(['t', 'leader']).optional() }).parse(req.body);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const member = getMember(database, map.id, req.user.id);
    const actor = mapActor(database, map.id, req.user.id);
    const roles = [actor?.isTHolder ? 't' : null, actor?.isLeader ? 'leader' : null].filter(Boolean);
    if (!roles.length) fail(403, 'FORBIDDEN', '只有当前 T 权限持有者或盟主可以审批');
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
        upsertGameIdentity(database, { gameId: database.prepare('SELECT game_id FROM game_identities WHERE id = ?').get(request.game_identity_id).game_id,
          gameName: request.game_name, userId: request.user_id });
        ensureMembership(database, map.id, request.user_id, request.game_identity_id);
        status = 'approved';
      } else {
        const eligible = new Set();
        if (database.prepare("SELECT 1 FROM map_memberships WHERE map_id = ? AND is_t_holder = 1 AND status = 'active'").get(map.id)) eligible.add('t');
        if (database.prepare("SELECT 1 FROM map_memberships WHERE map_id = ? AND is_leader = 1 AND status = 'active'").get(map.id)) eligible.add('leader');
        const rejected = new Set(database.prepare("SELECT reviewer_kind FROM join_request_reviews WHERE request_id = ? AND decision = 'reject'").all(request.id).map((row) => row.reviewer_kind));
        if ([...eligible].every((role) => rejected.has(role))) status = 'rejected';
      }
      if (status !== 'pending') database.prepare('UPDATE join_requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), request.id);
      audit(database, map.id, req.user.id, `join.${status === 'pending' ? 'review_recorded' : status}`, request.id, { reviewerKind });
    })();
    res.json({ status });
  });

  router.post('/:mapId/join-requests/:requestId/cancel', (req, res) => {
    const result = req.app.locals.db.prepare(`UPDATE join_requests SET status = 'cancelled', resolved_at = ?
      WHERE id = ? AND map_id = ? AND user_id = ? AND status = 'pending'`)
      .run(now(), req.params.requestId, req.params.mapId, req.user.id);
    if (!result.changes) fail(404, 'JOIN_REQUEST_NOT_FOUND', '加入申请不存在或已处理');
    res.status(204).end();
  });

  return router;
}
