import assert from 'node:assert/strict';
import test from 'node:test';
import supertest from 'supertest';
import { auth, registerUser, reportBody, testContext } from './helpers.js';

async function activeMap(request, context, options = {}) {
  const creator = await registerUser(request, context, { email: options.email || 'creator@example.com' });
  const created = await request.post('/api/v1/maps').set(auth(creator)).send({
    name: options.name || '前线图', creatorGameName: '创建者', reviewRequired: false, joinPassword: 'joinpass1!'
  }).expect(201);
  const mapId = created.body.map.id;
  const token = (await request.post(`/api/v1/maps/${mapId}/client-tokens`).set(auth(creator)).send({}).expect(201)).body.token;
  const report = reportBody();
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(report).expect(202);
  await request.post(`/api/v1/maps/${mapId}/activate`).set(auth(creator)).send({}).expect(200);
  return { creator, mapId, token, report };
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
  assert.equal(list.body.maps[0].displayName, '（测试联合体）的（前线图）的地图');
  assert.equal(list.body.maps[0].joined, true);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM ingest_batches WHERE map_id = ?').get(mapId).count, 1);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM celestial_bodies').get().count, 1);
});

test('加入申请：T 单方拒绝后盟主仍可同意', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId, token } = await activeMap(request, context);
  const leader = await registerUser(request, context, { email: 'leader@example.com', intent: 'join' });
  const leaderJoin = await request.post(`/api/v1/maps/${mapId}/join-requests`).set(auth(leader)).send({
    gameId: 'leader-1', gameName: '盟主', joinPassword: 'joinpass1!'
  }).expect(201);
  await request.post(`/api/v1/maps/${mapId}/join-requests/${leaderJoin.body.id}/review`).set(auth(creator)).send({ decision: 'approve' }).expect(200);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    roster: [
      { gameId: 'data-account-1', gameName: '数据小号' },
      { gameId: 'leader-1', gameName: '盟主', isLeader: true }
    ]
  })).expect(202);
  const applicant = await registerUser(request, context, { email: 'applicant@example.com', intent: 'join' });
  const join = await request.post(`/api/v1/maps/${mapId}/join-requests`).set(auth(applicant)).send({
    gameId: 'player-1', gameName: '申请人', joinPassword: 'joinpass1!'
  }).expect(201);
  const rejected = await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/review`).set(auth(creator)).send({ decision: 'reject', as: 't' }).expect(200);
  assert.equal(rejected.body.status, 'pending');
  const approved = await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/review`).set(auth(leader)).send({ decision: 'approve', as: 'leader' }).expect(200);
  assert.equal(approved.body.status, 'approved');
  assert.ok(context.db.prepare("SELECT 1 FROM map_memberships WHERE map_id = ? AND user_id = ? AND status = 'active'").get(mapId, applicant.user.id));
});

test('换星系后恢复：旧版本归档，新版本 roster 校验生效', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const { creator, mapId, token } = await activeMap(request, context);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    galaxy: { id: 'galaxy-2', name: '第二星系' }
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
  const member = await registerUser(request, context, { email: 'offline-member@example.com', intent: 'join' });
  const join = await request.post(`/api/v1/maps/${mapId}/join-requests`).set(auth(member)).send({ gameId: 'member-1', gameName: '成员', joinPassword: 'joinpass1!' }).expect(201);
  await request.post(`/api/v1/maps/${mapId}/join-requests/${join.body.id}/review`).set(auth(creator)).send({ decision: 'approve' }).expect(200);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    roster: [{ gameId: 'member-1', gameName: '成员' }]
  })).expect(202);
  await request.get(`/api/v1/maps/${mapId}`).set(auth(member)).expect(403);
  await request.get(`/api/v1/maps/${mapId}`).set(auth(creator)).expect(200);
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody()).expect(202);
  await request.get(`/api/v1/maps/${mapId}`).set(auth(member)).expect(403);
  await request.post(`/api/v1/maps/${mapId}/resume-access`).set(auth(creator)).send({}).expect(200);
  await request.get(`/api/v1/maps/${mapId}`).set(auth(member)).expect(200);
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
