import assert from 'node:assert/strict';
import test from 'node:test';
import supertest from 'supertest';
import { auth, registerUser, reportBody, testContext } from './helpers.js';
import { ensureMembership } from '../src/lib/identities.js';
import { getMember, mapActor } from '../src/lib/maps.js';
import { issueMemberSession, memberSessionForToken } from '../src/lib/member-auth.js';
import { hashToken } from '../src/lib/security.js';
import { VIEWER_COLORS } from '../src/lib/viewer-colors.js';

async function activeMap(request, context, options = {}) {
  const creator = await registerUser(request, context, { email: options.email || 'creator@example.com' });
  const created = await request.post('/api/v1/maps').set(auth(creator)).send({}).expect(201);
  const mapId = created.body.map.id;
  assert.equal(created.body.map.wizardStep, 2);
  const token = (await request.post(`/api/v1/maps/${mapId}/client-tokens`).set(auth(creator)).send({}).expect(201)).body.token;
  const report = reportBody();
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(report).expect(202);
  const wizard = await request.get(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).expect(200);
  assert.equal(wizard.body.canContinueToInfo, true);
  assert.equal(wizard.body.suggestedName, '（测试联合体）的地图');
  await request.post(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).send({
    name: options.name || wizard.body.suggestedName,
    creatorGameName: options.creatorGameName || '创建者大号',
    ...(options.creatorGameId ? { creatorGameId: options.creatorGameId } : {}),
    reviewRequired: options.reviewRequired || false,
    joinPassword: 'joinpass1!'
  }).expect(200);
  await request.post(`/api/v1/maps/${mapId}/activate`).set(auth(creator)).send({}).expect(200);
  return { creator, mapId, token, report };
}

async function reportedDraft(request, context, email, report) {
  const creator = await registerUser(request, context, { email });
  const created = await request.post('/api/v1/maps').set(auth(creator)).send({}).expect(201);
  const mapId = created.body.map.id;
  const token = (await request.post(`/api/v1/maps/${mapId}/client-tokens`).set(auth(creator)).send({}).expect(201)).body.token;
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(report).expect(202);
  const wizard = await request.get(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).expect(200);
  return { creator, mapId, token, wizard };
}

test('账号注册、密码登录与找回：数据库不留明文密码', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const user = await registerUser(request, context, { email: 'person@example.com', password: 'secret1!' });
  const row = context.db.prepare('SELECT * FROM users WHERE email = ?').get('person@example.com');
  assert.match(row.password_hash, /^\$2[aby]\$/);
  assert.equal(row.password_hash.includes('secret1!'), false);
  await request.post('/api/v1/auth/login').send({ email: 'person@example.com', password: 'secret1!' }).expect(200);
  await request.put('/api/v1/auth/recovery/question').set(auth(user)).send({ question: ' favourite? ', answer: '答案' }).expect(204);
  await request.post('/api/v1/auth/recovery/reset').send({ email: 'person@example.com', answer: '答案', newPassword: 'newpass2@' }).expect(204);
  await request.post('/api/v1/auth/login').send({ email: 'person@example.com', password: 'secret1!' }).expect(401);
  await request.post('/api/v1/auth/login').send({ email: 'person@example.com', password: 'newpass2@' }).expect(200);
});

test('建图、客户端上报、幂等批次、激活与地图列表格式', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId, token, report } = await activeMap(request, context);
  const duplicate = await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(report).expect(200);
  assert.equal(duplicate.body.duplicate, true);
  const publicList = await request.get('/api/v1/maps').expect(200);
  assert.equal(publicList.body.maps[0].joined, false);
  const list = await request.get('/api/v1/maps').set(auth(creator)).expect(200);
  assert.equal(list.body.maps[0].displayName, '（测试联合体）的地图');
  assert.equal(list.body.maps[0].joined, true);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM ingest_batches WHERE map_id = ?').get(mapId).count, 1);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM celestial_bodies').get().count, 1);
});

test('无账号加入：T 拒绝后盟主仍可同意，申请人领取成员会话', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId, token } = await activeMap(request, context);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    roster: [
      { gameId: 'data-account-1', gameName: '数据小号' },
      { gameId: 'leader-1', gameName: '盟主' },
      { gameId: 'player-1', gameName: '申请人' }
    ]
  })).expect(202);
  const leaderJoin = await request.post(`/api/v1/maps/${mapId}/join-requests`).send({
    gameName: '盟主', joinPassword: 'joinpass1!'
  }).expect(201);
  await request.post(`/api/v1/maps/${mapId}/join-requests/${leaderJoin.body.id}/review`).set(auth(creator)).send({ decision: 'approve' }).expect(200);
  const leaderSession = await request.post(`/api/v1/maps/${mapId}/join-requests/${leaderJoin.body.id}/session`)
    .send({ receipt: leaderJoin.body.receipt }).expect(200);
  const leaderCookie = leaderSession.headers['set-cookie'][0].split(';')[0];
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    roster: [
      { gameId: 'data-account-1', gameName: '数据小号' },
      { gameId: 'leader-1', gameName: '盟主', isLeader: true },
      { gameId: 'player-1', gameName: '申请人' }
    ]
  })).expect(202);
  const join = await request.post(`/api/v1/maps/${mapId}/join-requests`).send({
    gameName: '申请人', joinPassword: 'joinpass1!'
  }).expect(201);
  const pending = await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/session`)
    .send({ receipt: join.body.receipt }).expect(200);
  assert.equal(pending.body.status, 'pending');
  assert.equal(pending.headers['set-cookie'], undefined);
  const rejected = await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/review`).set(auth(creator)).send({ decision: 'reject', as: 't' }).expect(200);
  assert.equal(rejected.body.status, 'pending');
  const approved = await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/review`).set('Cookie', leaderCookie).send({ decision: 'approve', as: 'leader' }).expect(200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.headers['set-cookie'], undefined);
  const claimed = await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/session`)
    .send({ receipt: join.body.receipt }).expect(200);
  const memberCookie = claimed.headers['set-cookie'][0].split(';')[0];
  assert.match(memberCookie, /^lagrange_member=/);
  await request.get(`/api/v1/maps/${mapId}`).set('Cookie', memberCookie).expect(200);
  await request.get(`/api/v1/maps/${mapId}/display`).set('Cookie', memberCookie).expect(200);
  const membership = context.db.prepare(`SELECT map_memberships.* FROM map_memberships
    JOIN game_identities ON game_identities.id = map_memberships.game_identity_id
    WHERE map_id = ? AND game_identities.game_id = 'player-1' AND map_memberships.status = 'active'`).get(mapId);
  assert.equal(membership.user_id, null);
  const other = await activeMap(request, context, { email: 'other-map@example.com' });
  const memberList = await request.get('/api/v1/maps').set('Cookie', memberCookie).expect(200);
  assert.equal(memberList.body.maps.find((map) => map.id === mapId).joined, true);
  assert.equal(memberList.body.maps.find((map) => map.id === other.mapId).joined, false);
  await request.get(`/api/v1/maps/${other.mapId}`).set('Cookie', memberCookie).expect(403);
  await request.get(`/api/v1/maps/${other.mapId}/display`).set('Cookie', memberCookie).expect(403);
});

test('换星系后恢复：旧版本归档，新版本 roster 校验生效', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId, token } = await activeMap(request, context);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    galaxy: { id: 'galaxy-2', name: '第二星系' },
    roster: [
      { gameId: 'data-account-1', gameName: '数据小号' },
      { gameId: 'member-1', gameName: '真实成员' }
    ]
  })).expect(202);
  const restored = await request.post(`/api/v1/maps/${mapId}/restore`).set(auth(creator)).send({ mode: 'same_organization' }).expect(200);
  assert.equal(restored.body.map.galaxy.id, 'galaxy-2');
  assert.equal(restored.body.map.status, 'active');
  const archives = await request.get(`/api/v1/maps/${mapId}/archives`).set(auth(creator)).expect(200);
  assert.equal(archives.body.archives.length, 1);
  assert.equal(archives.body.archives[0].galaxyName, '第一星系');
});


test('T 权限通过 API 转移后创建者身份保持不变', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId } = await activeMap(request, context);
  const target = await registerUser(request, context, { email: 't-target@example.com', intent: 'join' });
  await request.post(`/api/v1/maps/${mapId}/permissions/transfer-t`).set(auth(creator)).send({ targetUserId: target.user.id }).expect(200);
  assert.equal(context.db.prepare('SELECT creator_user_id FROM maps WHERE id = ?').get(mapId).creator_user_id, creator.user.id);
  assert.equal(context.db.prepare('SELECT is_t_holder FROM map_memberships WHERE map_id = ? AND user_id = ?').get(mapId, target.user.id).is_t_holder, 1);
  await request.post(`/api/v1/maps/${mapId}/permissions/transfer-t`).set(auth(creator)).send({ targetUserId: creator.user.id }).expect(403);
});

test('数据号离盟立即下线，回盟后仍须创建者手动恢复', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId, token } = await activeMap(request, context);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    roster: [{ gameId: 'data-account-1', gameName: '数据小号' }, { gameId: 'member-1', gameName: '成员' }]
  })).expect(202);
  const join = await request.post(`/api/v1/maps/${mapId}/join-requests`).send({ gameName: '成员', joinPassword: 'joinpass1!' }).expect(201);
  await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/review`).set(auth(creator)).send({ decision: 'approve' }).expect(200);
  const claimed = await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/session`).send({ receipt: join.body.receipt }).expect(200);
  const memberCookie = claimed.headers['set-cookie'][0].split(';')[0];
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    roster: [{ gameId: 'member-1', gameName: '成员' }]
  })).expect(202);
  await request.get(`/api/v1/maps/${mapId}`).set('Cookie', memberCookie).expect(403);
  await request.get(`/api/v1/maps/${mapId}`).set(auth(creator)).expect(200);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    roster: [{ gameId: 'data-account-1', gameName: '数据小号' }]
  })).expect(202);
  await request.get(`/api/v1/maps/${mapId}`).set('Cookie', memberCookie).expect(403);
  await request.post(`/api/v1/maps/${mapId}/resume-access`).set(auth(creator)).send({}).expect(200);
  await request.get(`/api/v1/maps/${mapId}`).set('Cookie', memberCookie).expect(200);
});

test('地图合并由目标创建者批准，源版本归档且源令牌撤销', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const source = await activeMap(request, context, { email: 'source@example.com', name: '源图' });
  const target = await activeMap(request, context, { email: 'target@example.com', name: '目标图' });
  const merge = await request.post(`/api/v1/maps/${source.mapId}/merge-requests`).set(auth(source.creator)).send({ targetMapId: target.mapId }).expect(201);
  const inbox = await request.get(`/api/v1/maps/${target.mapId}/merge-requests`).set(auth(target.creator)).expect(200);
  assert.equal(inbox.body.requests[0].direction, 'incoming');
  await request.post(`/api/v1/maps/${target.mapId}/merge-requests/${merge.body.id}/review`).set(auth(target.creator)).send({ decision: 'approve' }).expect(200);
  assert.equal(context.db.prepare('SELECT status FROM maps WHERE id = ?').get(source.mapId).status, 'merged');
  assert.ok(context.db.prepare("SELECT 1 FROM map_memberships WHERE map_id = ? AND user_id = ? AND status = 'active'").get(target.mapId, source.creator.user.id));
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${source.token}`).send(reportBody()).expect(401);
  const archives = await request.get(`/api/v1/maps/${target.mapId}/archives`).set(auth(target.creator)).expect(200);
  assert.ok(archives.body.archives.some((archive) => archive.mapId === source.mapId));
});


test('加入密码错误拒绝，重名必须选择服务端候选 ID', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { mapId, token } = await activeMap(request, context);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    roster: [
      { gameId: 'data-account-1', gameName: '数据小号' },
      { gameId: 'same-1', gameName: '重名玩家' },
      { gameId: 'same-2', gameName: '重名玩家' }
    ]
  })).expect(202);
  await request.post(`/api/v1/maps/${mapId}/join-requests`).send({
    gameName: '重名玩家', joinPassword: 'wrong-pass1!'
  }).expect(401);
  const ambiguous = await request.post(`/api/v1/maps/${mapId}/join-requests`).send({
    gameName: '重名玩家', joinPassword: 'joinpass1!'
  }).expect(409);
  assert.equal(ambiguous.body.error.code, 'IDENTITY_DISAMBIGUATION_REQUIRED');
  await request.post(`/api/v1/maps/${mapId}/join-requests`).send({
    gameName: '重名玩家', gameId: 'not-a-candidate', joinPassword: 'joinpass1!'
  }).expect(400);
  const join = await request.post(`/api/v1/maps/${mapId}/join-requests`).send({
    gameName: '重名玩家', gameId: 'same-2', joinPassword: 'joinpass1!'
  }).expect(201);
  const requestRow = context.db.prepare(`SELECT game_identities.game_id FROM join_requests
    JOIN game_identities ON game_identities.id = join_requests.game_identity_id WHERE join_requests.id = ?`).get(join.body.id);
  assert.equal(requestRow.game_id, 'same-2');
});

test('创建向导手填大号：未上报拦截，无匹配醒目警告但允许只保存角色名', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const creator = await registerUser(request, context, { email: 'wizard@example.com' });
  await request.post('/api/v1/maps').set(auth(creator)).send({
    name: '手填地图', creatorGameName: '手填创建者', joinPassword: 'joinpass1!'
  }).expect(400);
  const created = await request.post('/api/v1/maps').set(auth(creator)).send({}).expect(201);
  const mapId = created.body.map.id;
  const initial = await request.get(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).expect(200);
  assert.equal(initial.body.step, 2);
  assert.equal(initial.body.suggestedName, null);
  assert.equal(initial.body.canContinueToInfo, false);
  assert.deepEqual(initial.body.creatorCandidates, []);
  await request.post(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).send({
    name: '手填绕过', creatorGameName: '大号角色',
    reviewRequired: false, joinPassword: 'joinpass1!'
  }).expect(409);
  await request.post(`/api/v1/maps/${mapId}/activate`).set(auth(creator)).send({}).expect(409);
  const token = (await request.post(`/api/v1/maps/${mapId}/client-tokens`).set(auth(creator)).send({}).expect(201)).body.token;
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody()).expect(202);
  const ready = await request.get(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).expect(200);
  assert.equal(ready.body.client.galaxy.name, '第一星系');
  assert.equal(ready.body.client.organization.name, '测试联合体');
  assert.equal(ready.body.canContinueToInfo, true);
  assert.deepEqual(ready.body.creatorCandidates, []);
  await request.get(`/api/v1/maps/${mapId}/creator-candidates`).set(auth(creator))
    .query({ gameName: '数据小号' }).expect(403);
  const unmatched = await request.get(`/api/v1/maps/${mapId}/creator-candidates`).set(auth(creator))
    .query({ gameName: '大号角色' }).expect(200);
  assert.deepEqual(unmatched.body.candidates, []);
  assert.match(unmatched.body.warning, /可继续创建/);
  const completed = await request.post(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).send({
    name: ready.body.suggestedName, creatorGameName: '大号角色',
    reviewRequired: false, joinPassword: 'joinpass1!'
  }).expect(200);
  assert.equal(completed.body.creatorIdentityMatched, false);
  assert.match(completed.body.creatorWarning, /只保存角色名/);
  assert.equal(completed.body.map.creatorGameName, '大号角色');
  assert.equal(completed.body.map.creatorGameId, null);
  const mapRow = context.db.prepare('SELECT * FROM maps WHERE id = ?').get(mapId);
  assert.equal(mapRow.creator_game_name, '大号角色');
  assert.equal(mapRow.creator_game_identity_id, null);
  assert.equal(mapRow.wizard_step, 3);
  await request.post(`/api/v1/maps/${mapId}/activate`).set(auth(creator)).send({}).expect(200);
});


test('创建向导手填大号：唯一同名自动绑定角色 ID，创建者不是观察小号', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId, wizard } = await reportedDraft(request, context, 'unique-creator@example.com', reportBody({
    roster: [
      { gameId: 'data-account-1', gameName: '数据小号', isLeader: true },
      { gameId: 'creator-main-1', gameName: '大号唯一', teamId: 'team-1' }
    ]
  }));
  assert.deepEqual(wizard.body.creatorCandidates.map((candidate) => candidate.gameId), ['creator-main-1']);
  const lookup = await request.get(`/api/v1/maps/${mapId}/creator-candidates`).set(auth(creator))
    .query({ gameName: '大号唯一' }).expect(200);
  assert.equal(lookup.body.candidates.length, 1);
  assert.equal(lookup.body.candidates[0].teamId, 'team-1');
  assert.deepEqual(lookup.body.candidates[0].organization, { id: 'org-1', name: '测试联合体' });
  const completed = await request.post(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).send({
    name: wizard.body.suggestedName, creatorGameName: '大号唯一',
    reviewRequired: false, joinPassword: 'joinpass1!'
  }).expect(200);
  assert.equal(completed.body.creatorIdentityMatched, true);
  assert.equal(completed.body.creatorWarning, null);
  assert.equal(completed.body.map.creatorGameName, '大号唯一');
  assert.equal(completed.body.map.creatorGameId, 'creator-main-1');
  const binding = context.db.prepare(`SELECT game_identities.game_id FROM map_memberships
    JOIN game_identities ON game_identities.id = map_memberships.game_identity_id
    WHERE map_memberships.map_id = ? AND map_memberships.user_id = ?`).get(mapId, creator.user.id);
  assert.equal(binding.game_id, 'creator-main-1');
  await request.post(`/api/v1/maps/${mapId}/activate`).set(auth(creator)).send({}).expect(200);
});

test('创建向导手填大号：重名展示区分信息并强制消歧，伪造 ID 被拒绝', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId, wizard } = await reportedDraft(request, context, 'ambiguous-creator@example.com', reportBody({
    roster: [
      { gameId: 'data-account-1', gameName: '数据小号' },
      { gameId: 'same-main-1', gameName: '重名大号', teamId: 'team-1', isLeader: true },
      { gameId: 'same-main-2', gameName: '重名大号', teamId: 'team-2' }
    ]
  }));
  const lookup = await request.get(`/api/v1/maps/${mapId}/creator-candidates`).set(auth(creator))
    .query({ gameName: '重名大号' }).expect(200);
  assert.deepEqual(lookup.body.candidates.map((candidate) => candidate.gameId), ['same-main-1', 'same-main-2']);
  assert.deepEqual(lookup.body.candidates.map((candidate) => candidate.teamId), ['team-1', 'team-2']);
  assert.equal(lookup.body.candidates[0].isLeader, true);
  const payload = {
    name: wizard.body.suggestedName, creatorGameName: '重名大号',
    reviewRequired: false, joinPassword: 'joinpass1!'
  };
  const ambiguous = await request.post(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).send(payload).expect(409);
  assert.equal(ambiguous.body.error.code, 'CREATOR_IDENTITY_DISAMBIGUATION_REQUIRED');
  assert.equal(ambiguous.body.error.details.candidates.length, 2);
  await request.post(`/api/v1/maps/${mapId}/wizard`).set(auth(creator))
    .send({ ...payload, creatorGameId: 'not-a-candidate' }).expect(400);
  const completed = await request.post(`/api/v1/maps/${mapId}/wizard`).set(auth(creator))
    .send({ ...payload, creatorGameId: 'same-main-2' }).expect(200);
  assert.equal(completed.body.creatorIdentityMatched, true);
  assert.equal(completed.body.map.creatorGameId, 'same-main-2');
  const binding = context.db.prepare(`SELECT game_identities.game_id FROM map_memberships
    JOIN game_identities ON game_identities.id = map_memberships.game_identity_id
    WHERE map_memberships.map_id = ? AND map_memberships.user_id = ?`).get(mapId, creator.user.id);
  assert.equal(binding.game_id, 'same-main-2');
});

test('观察小号持久隔离：不进名册成员或权限候选，不能加入、持有成员会话或权限', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId } = await activeMap(request, context, { email: 'observer@example.com' });
  const observer = context.db.prepare('SELECT * FROM game_identities WHERE game_id = ?').get('data-account-1');
  assert.equal(observer.is_observer, 1);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM map_roster WHERE game_identity_id = ?').get(observer.id).count, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM map_memberships WHERE game_identity_id = ?').get(observer.id).count, 0);
  const wizard = await request.get(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).expect(200);
  assert.deepEqual(wizard.body.creatorCandidates, []);
  const candidates = await request.get(`/api/v1/maps/${mapId}/game-identities`).query({ gameName: '数据小号' }).expect(200);
  assert.deepEqual(candidates.body.candidates, []);
  const joinByName = await request.post(`/api/v1/maps/${mapId}/join-requests`)
    .send({ gameName: '数据小号', joinPassword: 'joinpass1!' }).expect(403);
  assert.equal(joinByName.body.error.code, 'OBSERVER_NOT_USER');
  await request.post(`/api/v1/maps/${mapId}/join-requests`)
    .send({ gameName: '数据小号', gameId: 'data-account-1', joinPassword: 'joinpass1!' }).expect(403);
  assert.equal(getMember(context.db, mapId, null, observer.id), undefined);
  assert.equal(mapActor(context.db, mapId, null, observer.id), null);
  assert.throws(() => ensureMembership(context.db, mapId, null, observer.id), (error) => error.code === 'OBSERVER_NOT_USER');
  assert.throws(() => issueMemberSession(context.db, context.config, mapId, observer.id), (error) => error.code === 'OBSERVER_NOT_USER');
  const testSessionToken = 'test-only-observer-session-token';
  const timestamp = new Date().toISOString();
  context.db.prepare(`INSERT INTO member_sessions
    (id, map_id, game_identity_id, token_hash, expires_at, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('test-observer-session', mapId, observer.id, hashToken(testSessionToken),
      new Date(Date.now() + 86_400_000).toISOString(), timestamp, timestamp);
  assert.equal(memberSessionForToken(context.db, testSessionToken), undefined);
});


test('查看者关系着色：同一快照在大号与另一成员视角下，自己、同队、同联合体颜色不同', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const observedAt = new Date().toISOString();
  const owners = ['viewer-a', 'teammate-a', 'viewer-b', 'unassigned'];
  const { creator, mapId, wizard } = await reportedDraft(request, context, 'viewer-a@example.com', reportBody({
    roster: [
      { gameId: 'data-account-1', gameName: '数据小号' },
      { gameId: 'viewer-a', gameName: '查看者A', teamId: 'team-1' },
      { gameId: 'teammate-a', gameName: 'A的队友', teamId: 'team-1' },
      { gameId: 'viewer-b', gameName: '查看者B', teamId: 'team-2' },
      { gameId: 'unassigned', gameName: '未分队成员' }
    ],
    snapshots: [{
      observedAt,
      bodies: owners.map((ownerGameId) => ({
        key: `body-${ownerGameId}`, name: `建筑-${ownerGameId}`, type: 'base', x: 1, y: 2,
        features: { ownerGameId }
      })),
      fleets: owners.map((ownerGameId) => ({
        key: `fleet-${ownerGameId}`, ownerGameId, state: 'real', x: 3, y: 4
      }))
    }]
  }));
  await request.post(`/api/v1/maps/${mapId}/wizard`).set(auth(creator)).send({
    name: wizard.body.suggestedName, creatorGameName: '查看者A',
    reviewRequired: false, joinPassword: 'joinpass1!'
  }).expect(200);
  await request.post(`/api/v1/maps/${mapId}/activate`).set(auth(creator)).send({}).expect(200);
  const join = await request.post(`/api/v1/maps/${mapId}/join-requests`)
    .send({ gameName: '查看者B', joinPassword: 'joinpass1!' }).expect(201);
  await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/review`)
    .set(auth(creator)).send({ decision: 'approve' }).expect(200);
  const claimed = await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/session`)
    .send({ receipt: join.body.receipt }).expect(200);
  const viewerBCookie = claimed.headers['set-cookie'][0].split(';')[0];

  const displayA = await request.get(`/api/v1/maps/${mapId}/display`).set(auth(creator)).expect(200);
  const displayB = await request.get(`/api/v1/maps/${mapId}/display`).set('Cookie', viewerBCookie).expect(200);
  assert.equal(displayA.body.snapshot.id, displayB.body.snapshot.id);
  assert.deepEqual(displayA.body.colorLegend, {
    self: VIEWER_COLORS.self, team: VIEWER_COLORS.team, organization: VIEWER_COLORS.organization
  });
  const relationsA = Object.fromEntries(displayA.body.fleets.map((fleet) => [fleet.ownerGameId, fleet.relation]));
  assert.deepEqual(relationsA, {
    'viewer-a': 'self', 'teammate-a': 'team', 'viewer-b': 'organization', unassigned: 'organization'
  });
  const relationsB = Object.fromEntries(displayB.body.fleets.map((fleet) => [fleet.ownerGameId, fleet.relation]));
  assert.deepEqual(relationsB, {
    'viewer-a': 'organization', 'teammate-a': 'organization', 'viewer-b': 'self', unassigned: 'organization'
  });
  for (const display of [displayA.body, displayB.body]) {
    for (const item of [...display.bodies, ...display.fleets]) {
      assert.equal(item.color, VIEWER_COLORS[item.relation]);
    }
  }
  const bodyAFromA = displayA.body.bodies.find((body) => body.ownerGameId === 'viewer-a');
  const bodyAFromB = displayB.body.bodies.find((body) => body.ownerGameId === 'viewer-a');
  assert.equal(bodyAFromA.relation, 'self');
  assert.equal(bodyAFromA.color, VIEWER_COLORS.self);
  assert.equal(bodyAFromB.relation, 'organization');
  assert.equal(bodyAFromB.color, VIEWER_COLORS.organization);
  assert.notEqual(bodyAFromA.color, bodyAFromB.color);
  const teammateFromA = displayA.body.fleets.find((fleet) => fleet.ownerGameId === 'teammate-a');
  const teammateFromB = displayB.body.fleets.find((fleet) => fleet.ownerGameId === 'teammate-a');
  assert.equal(teammateFromA.color, VIEWER_COLORS.team);
  assert.equal(teammateFromB.color, VIEWER_COLORS.organization);
});
