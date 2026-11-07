import { Router } from 'express';
import { z } from 'zod';
import { authenticated, audit } from '../lib/auth.js';
import { fail } from '../lib/errors.js';
import { ensureMembership } from '../lib/identities.js';
import { getMap, getMember, mapActor, requireMapView } from '../lib/maps.js';
import {
  adminPermissionsFor, assertAdminGrant, assertAdminTransfer, assertCaptainChange,
  assertRoleTransfer, PERMISSIONS, T_PERMISSION_LABEL
} from '../lib/permissions.js';
import { now } from '../lib/security.js';

const userId = z.string().uuid();

function targetUser(db, id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) fail(404, 'USER_NOT_FOUND', '目标网站账号不存在');
  return user;
}

export function createPermissionsRouter() {
  const router = Router();
  router.use(authenticated);

  router.get('/:mapId/permissions', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const { member } = requireMapView(database, map, req.user.id);
    res.json({
      tPermissionLabel: T_PERMISSION_LABEL,
      availableAdminPermissions: PERMISSIONS,
      mine: member ? {
        memberId: member.id,
        isCreator: Boolean(member.is_creator),
        isTHolder: Boolean(member.is_t_holder),
        isLeader: Boolean(member.is_leader),
        isCaptain: Boolean(member.is_captain),
        adminPermissions: adminPermissionsFor(database, member.id)
      } : null
    });
  });

  router.post('/:mapId/permissions/grant', (req, res) => {
    const input = z.object({ targetUserId: userId, permissions: z.array(z.string()).min(1).max(PERMISSIONS.length) }).parse(req.body);
    const requested = [...new Set(input.permissions)];
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const actor = mapActor(database, map.id, req.user.id);
    assertAdminGrant(actor, requested);
    targetUser(database, input.targetUserId);
    let target = getMember(database, map.id, input.targetUserId);
    if (!target && !actor.isTHolder) fail(404, 'MEMBER_NOT_FOUND', '目标账号尚未加入地图');
    database.transaction(() => {
      target = target || ensureMembership(database, map.id, input.targetUserId);
      for (const permission of requested) {
        database.prepare(`INSERT INTO map_admin_permissions (member_id, permission, granted_by, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(member_id, permission) DO NOTHING`).run(target.id, permission, actor.memberId, now());
      }
      audit(database, map.id, req.user.id, 'permissions.granted', target.id, { permissions: requested });
    })();
    res.json({ targetMemberId: target.id, permissions: adminPermissionsFor(database, target.id) });
  });

  router.post('/:mapId/permissions/transfer-t', (req, res) => {
    const input = z.object({ targetUserId: userId }).parse(req.body);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const actor = mapActor(database, map.id, req.user.id);
    assertRoleTransfer(actor, 't');
    targetUser(database, input.targetUserId);
    database.transaction(() => {
      database.prepare('UPDATE map_memberships SET is_t_holder = 0, updated_at = ? WHERE map_id = ? AND is_t_holder = 1').run(now(), map.id);
      const target = ensureMembership(database, map.id, input.targetUserId);
      database.prepare('UPDATE map_memberships SET is_t_holder = 1, updated_at = ? WHERE id = ?').run(now(), target.id);
      audit(database, map.id, req.user.id, 'permissions.t_transferred', target.id, { fromMemberId: actor.memberId });
    })();
    const creator = database.prepare('SELECT creator_user_id FROM maps WHERE id = ?').get(map.id);
    res.json({ transferred: true, creatorUserId: creator.creator_user_id });
  });

  router.post('/:mapId/permissions/transfer-admin', (req, res) => {
    const input = z.object({ fromUserId: userId, targetUserId: userId }).parse(req.body);
    if (input.fromUserId === input.targetUserId) fail(400, 'TRANSFER_TO_SELF', '不能转移给本人');
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const actor = mapActor(database, map.id, req.user.id);
    const source = getMember(database, map.id, input.fromUserId);
    if (!source) fail(404, 'MEMBER_NOT_FOUND', '权限转出方不是有效地图成员');
    assertAdminTransfer(actor, source.id);
    const permissions = adminPermissionsFor(database, source.id);
    if (!permissions.length) fail(409, 'NO_ADMIN_PERMISSIONS', '转出方没有可转移的管理员权限');
    targetUser(database, input.targetUserId);
    database.transaction(() => {
      const target = ensureMembership(database, map.id, input.targetUserId);
      database.prepare('DELETE FROM map_admin_permissions WHERE member_id = ?').run(source.id);
      for (const permission of permissions) {
        database.prepare(`INSERT INTO map_admin_permissions (member_id, permission, granted_by, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(member_id, permission) DO NOTHING`).run(target.id, permission, actor.memberId, now());
      }
      audit(database, map.id, req.user.id, 'permissions.admin_transferred', target.id, { fromMemberId: source.id, permissions });
    })();
    res.json({ transferred: true, permissions });
  });

  router.post('/:mapId/captains', (req, res) => {
    const input = z.object({ targetUserId: userId, teamId: z.string().trim().min(1).max(80) }).parse(req.body);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const actor = mapActor(database, map.id, req.user.id);
    assertCaptainChange(actor);
    const target = getMember(database, map.id, input.targetUserId);
    if (!target) fail(404, 'MEMBER_NOT_FOUND', '目标账号尚未加入地图');
    database.prepare('UPDATE map_memberships SET is_captain = 1, team_id = ?, updated_at = ? WHERE id = ?')
      .run(input.teamId, now(), target.id);
    audit(database, map.id, req.user.id, 'captain.appointed', target.id, { teamId: input.teamId });
    res.status(204).end();
  });

  router.delete('/:mapId/captains/:targetUserId', (req, res) => {
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const actor = mapActor(database, map.id, req.user.id);
    assertCaptainChange(actor);
    const target = getMember(database, map.id, req.params.targetUserId);
    if (!target) fail(404, 'MEMBER_NOT_FOUND', '目标账号尚未加入地图');
    database.prepare('UPDATE map_memberships SET is_captain = 0, updated_at = ? WHERE id = ?').run(now(), target.id);
    audit(database, map.id, req.user.id, 'captain.removed', target.id);
    res.status(204).end();
  });

  return router;
}
