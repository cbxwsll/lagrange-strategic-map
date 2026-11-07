import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAdminGrant, assertCaptainChange, assertRoleTransfer, assertTTransfer
} from '../src/lib/permissions.js';

const actor = (overrides = {}) => ({ memberId: 'actor', permissions: new Set(), ...overrides });

test('§11-1 管理员可以授予自己已有权限的子集', () => {
  const admin = actor({ permissions: new Set(['permissions.grant', 'members.review', 'members.manage']) });
  assert.doesNotThrow(() => assertAdminGrant(admin, ['members.review']));
});

test('§11-2 管理员越权授予被拒绝', () => {
  const admin = actor({ permissions: new Set(['permissions.grant', 'members.review']) });
  assert.throws(() => assertAdminGrant(admin, ['map.manage']), (error) => error.code === 'GRANT_NOT_SUBSET');
});

test('§11-3 当前持有者可以转移 T 权限', () => {
  assert.doesNotThrow(() => assertTTransfer(actor({ isTHolder: true })));
});

test('§11-4 非持有者不能转移 T 权限', () => {
  assert.throws(() => assertTTransfer(actor({ isCreator: true })), (error) => error.code === 'T_TRANSFER_NOT_HOLDER');
});

test('§11-5 盟主可以任命小队队长', () => {
  assert.doesNotThrow(() => assertCaptainChange(actor({ isLeader: true })));
});

test('§11-6 盟主可以删除并恢复小队队长权限', () => {
  const leader = actor({ isLeader: true });
  assert.doesNotThrow(() => assertCaptainChange(leader));
  assert.doesNotThrow(() => assertCaptainChange(leader));
});

test('§11-7 创建者身份本身不能直接删除队长', () => {
  assert.throws(() => assertCaptainChange(actor({ isCreator: true })), (error) => error.code === 'CAPTAIN_LEADER_ONLY');
});

test('§11-8 创建者身份不可转移', () => {
  assert.throws(() => assertRoleTransfer(actor({ isTHolder: true }), 'creator'), (error) => error.code === 'CREATOR_IMMUTABLE');
});
