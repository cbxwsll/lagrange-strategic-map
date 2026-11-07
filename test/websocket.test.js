import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import supertest from 'supertest';
import WebSocket from 'ws';
import { setupWebSocket } from '../src/ws.js';
import { auth, registerUser, reportBody, testContext } from './helpers.js';

test('WebSocket 骨架：Cookie 认证、订阅与退订', async (t) => {
  const context = testContext();
  const server = http.createServer(context.app);
  const wss = setupWebSocket(server, context.db, context.config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    context.close();
  });
  const request = supertest(context.app);
  const user = await registerUser(request, context, { email: 'ws@example.com' });
  const created = await request.post('/api/v1/maps').set(auth(user)).send({ name: 'WS图', creatorGameName: 'WS', joinPassword: 'joinpass1!' }).expect(201);
  const mapId = created.body.map.id;
  const token = (await request.post(`/api/v1/maps/${mapId}/client-tokens`).set(auth(user)).send({}).expect(201)).body.token;
  await request.post('/api/v1/client/report').set('Authorization', `Bearer ${token}`).send(reportBody()).expect(202);
  await request.post(`/api/v1/maps/${mapId}/activate`).set(auth(user)).expect(200);
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `lagrange_session=${encodeURIComponent(user.token)}` } });
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages[0].type, 'ready');
  ws.send(JSON.stringify({ type: 'subscribe', mapId }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(messages.some((message) => message.type === 'subscribed' && message.mapId === mapId));
  ws.send(JSON.stringify({ type: 'unsubscribe', mapId }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(messages.some((message) => message.type === 'unsubscribed' && message.mapId === mapId));
  ws.close();
});


test('WebSocket 内测门槛：无通行 cookie 拒绝，停用码后已有连接在下条消息失效', async (t) => {
  const context = testContext();
  const request = supertest(context.app);
  const user = await registerUser(request, context, { email: 'ws-beta@example.com' });
  context.config.betaInviteRequired = true;
  context.db.prepare('INSERT INTO invites (code, bound_name, active, used_count, created_at) VALUES (?, ?, 1, 0, ?)')
    .run('TEST-WS-BETA', 'WebSocket 测试', new Date().toISOString());
  const entered = await request.post('/api/v1/beta/enter').send({ code: 'TEST-WS-BETA' }).expect(200);
  const betaCookie = entered.headers['set-cookie'][0].split(';')[0];
  const sessionCookie = `lagrange_session=${encodeURIComponent(user.token)}`;

  const server = http.createServer(context.app);
  const wss = setupWebSocket(server, context.db, context.config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    context.close();
  });
  const address = `ws://127.0.0.1:${server.address().port}/ws`;

  await assert.rejects(new Promise((resolve, reject) => {
    const denied = new WebSocket(address, { headers: { Cookie: sessionCookie } });
    denied.once('open', () => { denied.close(); reject(new Error('无内测 cookie 不应连接成功')); });
    denied.once('error', reject);
  }), /401/);

  const ws = new WebSocket(address, { headers: { Cookie: `${sessionCookie}; ${betaCookie}` } });
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages[0].type, 'ready');

  context.db.prepare('UPDATE invites SET active = 0 WHERE code = ?').run('TEST-WS-BETA');
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.send(JSON.stringify({ type: 'unsubscribe', mapId: '00000000-0000-4000-8000-000000000001' }));
  assert.equal(await closed, 1008);
  assert.ok(messages.some((message) => message.type === 'error' && message.code === 'BETA_REQUIRED'));
});
