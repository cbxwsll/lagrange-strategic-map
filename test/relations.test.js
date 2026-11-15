import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRelation } from '../src/lib/viewer-relations.js';

const viewer = { viewerGameId: 'viewer-1', viewerTeamId: 'team-1' };

test('classifyRelation 六类判定：敌对中立优先，保留自己同队同联合体并兜底缺失字段', () => {
  assert.equal(classifyRelation('body', { ...viewer, ownerGameId: 'viewer-1' }), 'self');
  assert.equal(classifyRelation('fleet', {
    ...viewer, ownerGameId: 'teammate-1', sameOrganization: true, targetTeamId: 'team-1'
  }), 'team');
  assert.equal(classifyRelation('body', {
    ...viewer, ownerGameId: 'member-1', sameOrganization: true, targetTeamId: 'team-2'
  }), 'organization');
  assert.equal(classifyRelation('fleet', { ...viewer, ownerGameId: 'outsider-1', sameOrganization: false }), 'other');
  assert.equal(classifyRelation('body', { ...viewer, entityKind: 'pirate_base' }), 'hostile');
  assert.equal(classifyRelation('body', { ...viewer, features: { faction: '海盗' } }), 'hostile');
  assert.equal(classifyRelation('body', { ...viewer, entityKind: 'space_station', features: { faction: 'neutral' } }), 'neutral');
  assert.equal(classifyRelation('body', { ...viewer }), 'neutral');
  assert.equal(classifyRelation('fleet', { ...viewer }), 'other');
});
