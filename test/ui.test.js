import assert from 'node:assert/strict';
import test from 'node:test';
import supertest from 'supertest';
import { createRuntime } from '../public/assets/runtime.js';
import { auth, registerUser, reportBody, testContext } from './helpers.js';

test('§9 静态页面由现有 Express 托管，使用相对资源', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const home = await request.get('/').expect(200).expect('Content-Type', /html/);
  assert.match(home.text, /本网站纯免费公益为爱发电/);
  assert.match(home.text, /\.\/assets\/home\.js/);
  assert.doesNotMatch(home.text, /https:\/\/skylin\.xin\/project\/lagrange\/assets/);
  await request.get('/assets/home.js').expect(200).expect('Content-Type', /javascript/);
  await request.get('/auth').expect(200).expect('Content-Type', /html/);
  await request.get('/create').expect(200).expect('Content-Type', /html/);
  await request.get('/map').expect(200).expect('Content-Type', /html/);
  await request.get('/settings').expect(200).expect('Content-Type', /html/);
  await request.get('/favicon.ico').expect(204);
});

test('§9 页面初始化静默读取会话和本人找回问题', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const guest = await request.get('/api/v1/auth/session').expect(200);
  assert.equal(guest.body.user, null);
  assert.equal(guest.body.inviteRequired, false);
  await request.get('/api/v1/auth/recovery/question/mine').expect(401);
  const user = await registerUser(request, context, { email: 'settings@example.com' });
  const session = await request.get('/api/v1/auth/session').set(auth(user)).expect(200);
  assert.equal(session.body.user.email, 'settings@example.com');
  assert.deepEqual((await request.get('/api/v1/auth/recovery/question/mine').set(auth(user)).expect(200)).body, { question: null });
});

test('§9 运行时地址保留路径前缀和当前 host，HTTPS 页面使用 wss', () => {
  const domain = createRuntime(
    'https://skylin.xin/project/lagrange/assets/runtime.js',
    'https://skylin.xin/project/lagrange/map.html?id=map-1'
  );
  assert.equal(domain.apiBase, 'https://skylin.xin/project/lagrange/api/v1');
  assert.equal(domain.wsUrl, 'wss://skylin.xin/project/lagrange/ws');
  assert.equal(domain.page('index.html'), 'https://skylin.xin/project/lagrange/index.html');

  const ip = createRuntime(
    'http://47.94.46.2/project/lagrange/assets/runtime.js',
    'http://47.94.46.2/project/lagrange/'
  );
  assert.equal(ip.apiBase, 'http://47.94.46.2/project/lagrange/api/v1');
  assert.equal(ip.wsUrl, 'ws://47.94.46.2/project/lagrange/ws');
  assert.equal(ip.page('auth.html', { mode: 'login' }), 'http://47.94.46.2/project/lagrange/auth.html?mode=login');
});

test('§9 地图只读接口返回真实快照并支持建筑名和特征筛选', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const creator = await registerUser(request, context, { email: 'display@example.com' });
  const created = await request.post('/api/v1/maps').set(auth(creator)).send({
    name: '展示图', creatorGameName: '创建者', reviewRequired: false, joinPassword: 'joinpass1!'
  }).expect(201);
  const mapId = created.body.map.id;
  const token = (await request.post(`/api/v1/maps/${mapId}/client-tokens`).set(auth(creator)).send({}).expect(201)).body.token;
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody({
    snapshots: [{
      observedAt: new Date().toISOString(),
      bodies: [
        { key: 'body-1', name: '前哨站A', type: 'base', x: 1, y: 2, features: { level: 3, zone: '前线' } },
        { key: 'body-2', name: '后方基地', type: 'base', x: 8, y: 9, features: { level: 5, zone: '后方' } }
      ],
      fleets: [
        { key: 'fleet-real', state: 'real', x: 2, y: 3 },
        { key: 'fleet-estimated', state: 'estimated', x: 4, y: 5 },
        { key: 'fleet-invalid', state: 'invalid', x: 6, y: 7 }
      ],
      sharing: { current: 10, target: 100, effect: '研究加速', visitsEquivalent: 9 }
    }]
  })).expect(202);
  await request.post(`/api/v1/maps/${mapId}/activate`).set(auth(creator)).send({}).expect(200);

  await request.get(`/api/v1/maps/${mapId}/display`).expect(401);
  const display = await request.get(`/api/v1/maps/${mapId}/display`).set(auth(creator)).expect(200);
  assert.equal(display.body.empty, false);
  assert.equal(display.body.bodies.length, 2);
  assert.deepEqual(Object.fromEntries(display.body.fleets.map((fleet) => [fleet.key, fleet.state])), {
    'fleet-real': 'real', 'fleet-estimated': 'estimated', 'fleet-invalid': 'invalid'
  });
  assert.equal(display.body.sharing.effect, '研究加速');
  assert.equal(display.body.sharing.visitsEquivalent, 9);
  assert.ok(display.body.features.some((feature) => feature.key === 'zone'));

  const search = await request.get(`/api/v1/maps/${mapId}/display`).set(auth(creator)).query({ search: '前哨' }).expect(200);
  assert.equal(search.body.bodies.length, 1);
  assert.equal(search.body.bodies[0].name, '前哨站A');
  const filtered = await request.get(`/api/v1/maps/${mapId}/display`).set(auth(creator))
    .query({ featureKey: 'zone', featureValue: '后方' }).expect(200);
  assert.equal(filtered.body.bodies.length, 1);
  assert.equal(filtered.body.bodies[0].name, '后方基地');
});
