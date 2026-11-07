import { fail } from './errors.js';

export const T_PERMISSION_LABEL = 'T 权限';
export const PERMISSIONS = Object.freeze([
  'map.manage',
  'map.restore',
  'map.merge',
  'archive.delete',
  'members.review',
  'members.manage',
  'permissions.grant',
  'permissions.transfer',
  'client.manage'
]);
const PERMISSION_SET = new Set(PERMISSIONS);

export function actorFromMembership(member, adminPermissions = []) {
  if (!member) return null;
  return {
    memberId: member.id,
    userId: member.user_id,
    isCreator: Boolean(member.is_creator),
    isTHolder: Boolean(member.is_t_holder),
    isLeader: Boolean(member.is_leader),
    isCaptain: Boolean(member.is_captain),
    permissions: new Set(adminPermissions)
  };
}

export function assertAdminGrant(actor, requested) {
  if (!requested.length || requested.some((permission) => !PERMISSION_SET.has(permission))) {
    fail(400, 'PERMISSION_INVALID', '包含未知管理员权限');
  }
  if (actor?.isTHolder) return;
  if (!actor?.permissions.has('permissions.grant')) fail(403, 'FORBIDDEN', '没有授予管理员权限的能力');
  if (requested.some((permission) => !actor.permissions.has(permission))) {
    fail(403, 'GRANT_NOT_SUBSET', '管理员只能授予自己已有权限的子集');
  }
}

export function assertAdminTransfer(actor, holderMemberId) {
  if (!actor?.isTHolder && actor?.memberId !== holderMemberId) {
    fail(403, 'TRANSFER_NOT_HOLDER', '只有 T 权限持有者或管理员本人可以转移该管理员权限');
  }
}

export function assertTTransfer(actor) {
  if (!actor?.isTHolder) fail(403, 'T_TRANSFER_NOT_HOLDER', '只有当前 T 权限持有者可以转移 T 权限');
}

export function assertRoleTransfer(actor, role) {
  if (role === 'creator') fail(403, 'CREATOR_IMMUTABLE', '创建者身份不可转移');
  if (role === 'leader' || role === 'captain') fail(403, 'ROLE_NOT_TRANSFERABLE', '盟主与小队队长权限不可转移');
  if (role === 't') return assertTTransfer(actor);
  fail(400, 'ROLE_INVALID', '未知权限角色');
}

export function assertCaptainChange(actor) {
  if (!actor?.isLeader) fail(403, 'CAPTAIN_LEADER_ONLY', '只有盟主可以任免小队队长');
}

export function assertArchiveDelete(actor) {
  if (!actor?.isCreator && !actor?.isTHolder && !actor?.isLeader) {
    fail(403, 'FORBIDDEN', '只有创建者、T 权限持有者或盟主可以删除档案');
  }
}

export function adminPermissionsFor(db, memberId) {
  return db.prepare('SELECT permission FROM map_admin_permissions WHERE member_id = ?').all(memberId).map((row) => row.permission);
}

export function loadActor(db, mapId, userId) {
  const member = db.prepare(`SELECT * FROM map_memberships
    WHERE map_id = ? AND user_id = ? AND status = 'active'`).get(mapId, userId);
  return actorFromMembership(member, member ? adminPermissionsFor(db, member.id) : []);
}

export function canViewMap(map, actor) {
  if (actor?.isCreator) return true;
  if (!actor || map.status === 'suspended' || map.status === 'draft' || map.status === 'merged') return false;
  return true;
}
