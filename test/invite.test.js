import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import supertest from 'supertest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { registerUser, testContext } from './helpers.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function seedInvite(context, code, boundName = '自动化测试绑定名') {
  context.db.prepare('INSERT INTO invites (code, bound_name, active, used_count, created_at) VALUES (?, ?, 1, 0, ?)')
    .run(code, boundName, new Date().toISOString());
}

function enter(request, code) {
  return request.post('/api/v1/beta/enter').send({ code });
}

function passCookie(response) {
  return response.headers['set-cookie'][0].split(';')[0];
}

function expiredCookie(context, code) {
  const payload = Buffer.from(JSON.stringify({ code, exp: Date.now() - 1000 }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', context.config.codeHmacSecret).update(payload).digest('base64url');
  return `lagrange_beta_pass=${payload}.${signature}`;
}

test('内测开：页面和 API 无 cookie 被拦，仅健康检查、进站接口和输码页资源放行', async (t) => {
  const context = testContext();
  context.config.betaInviteRequired = true;
  t.after(() => context.close());
  const request = supertest(context.app);

  const page = await request.get('/map?id=map-1').expect(302);
  assert.equal(page.headers.location, '/project/lagrange/beta.html?next=%2Fmap%3Fid%3Dmap-1');
  const api = await request.get('/api/v1/maps').expect(401);
  assert.equal(api.body.error.code, 'BETA_REQUIRED');
  assert.equal(api.body.betaEntry, '/project/lagrange/beta.html');
  await request.get('/assets/home.js').expect(302);
  await request.get('/healthz').expect(200);
  await request.get('/api/v1/beta/enter').expect(200, { required: true });
  await request.get('/beta.html').expect(200);
  await request.get('/assets/beta.js').expect(200);
  await request.get('/assets/runtime.js').expect(200);
  await request.get('/assets/styles.css').expect(200);
  await request.get('/favicon.ico').expect(204);
});

test('错码和停用码拒绝；对码签发 7 天 cookie，重复进站只累计审计次数', async (t) => {
  const context = testContext();
  context.config.betaInviteRequired = true;
  t.after(() => context.close());
  const request = supertest(context.app);
  seedInvite(context, 'TEST-GATE-REPEAT', '绑定名不是用户名');

  const invalid = await enter(request, 'TEST-NOT-EXIST').expect(400);
  assert.equal(invalid.body.error.code, 'BETA_CODE_INVALID');
  const accepted = await enter(request, 'TEST-GATE-REPEAT').expect(200);
  assert.equal(accepted.body.boundName, '绑定名不是用户名');
  assert.ok(Date.parse(accepted.body.expiresAt) - Date.now() > 6.9 * 86_400_000);
  assert.ok(Date.parse(accepted.body.expiresAt) - Date.now() <= 7 * 86_400_000);
  const setCookie = accepted.headers['set-cookie'][0];
  assert.match(setCookie, /^lagrange_beta_pass=/);
  assert.match(setCookie, /Path=\/project\/lagrange/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = passCookie(accepted);
  await request.get('/').set('Cookie', cookie).expect(200);
  await request.get('/api/v1/auth/session').set('Cookie', cookie).expect(200, { user: null });
  assert.equal(context.db.prepare('SELECT used_count FROM invites WHERE code = ?').get('TEST-GATE-REPEAT').used_count, 1);

  await enter(request, 'TEST-GATE-REPEAT').expect(200);
  assert.equal(context.db.prepare('SELECT used_count FROM invites WHERE code = ?').get('TEST-GATE-REPEAT').used_count, 2);

  context.db.prepare('UPDATE invites SET active = 0 WHERE code = ?').run('TEST-GATE-REPEAT');
  await request.get('/').set('Cookie', cookie).expect(302);
  await request.get('/api/v1/maps').set('Cookie', cookie).expect(401);
  const disabled = await enter(request, 'TEST-GATE-REPEAT').expect(403);
  assert.equal(disabled.body.error.code, 'BETA_CODE_DISABLED');
});

test('签名被篡改或已过期的 cookie 不能进站', async (t) => {
  const context = testContext();
  context.config.betaInviteRequired = true;
  t.after(() => context.close());
  const request = supertest(context.app);
  seedInvite(context, 'TEST-GATE-SIGNATURE');
  const accepted = await enter(request, 'TEST-GATE-SIGNATURE').expect(200);
  const cookie = passCookie(accepted);
  await request.get('/api/v1/auth/session').set('Cookie', `${cookie}x`).expect(401);
  await request.get('/api/v1/auth/session').set('Cookie', expiredCookie(context, 'TEST-GATE-SIGNATURE')).expect(401);
});

test('内测开：注册本身不再校验或消耗邀请码', async (t) => {
  const context = testContext();
  context.config.betaInviteRequired = true;
  t.after(() => context.close());
  const request = supertest(context.app);
  seedInvite(context, 'TEST-GATE-REGISTER');
  const cookie = passCookie(await enter(request, 'TEST-GATE-REGISTER').expect(200));
  const email = 'gate-register@example.com';
  await request.post('/api/v1/auth/email-codes').set('Cookie', cookie).send({ email, purpose: 'register' }).expect(202);
  const { code } = context.sent.find((item) => item.email === email && item.purpose === 'register');
  const registered = await request.post('/api/v1/auth/register').set('Cookie', cookie).send({
    email, code, username: '注册用户名', password: 'passw0rd!', intent: 'join'
  }).expect(201);
  assert.equal(registered.body.user.username, '注册用户名');
  assert.equal(registered.body.betaWelcome, undefined);
  assert.equal(context.db.prepare('SELECT used_count FROM invites WHERE code = ?').get('TEST-GATE-REGISTER').used_count, 1);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'invite_uses'").get().count, 0);
});

test('内测关：全站免码，注册和进站接口均不种 cookie', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  await request.get('/').expect(200);
  await request.get('/api/v1/auth/session').expect(200, { user: null });
  const user = await registerUser(request, context, { email: 'open-registration@example.com', intent: 'join' });
  assert.equal(user.betaWelcome, undefined);
  const entered = await enter(request, 'TEST-ANYTHING').expect(200, { required: false });
  assert.equal(entered.headers['set-cookie'], undefined);
});

test('BETA_INVITE_REQUIRED 只接受明确 true/false，缺省关闭', () => {
  assert.equal(loadConfig({}).betaInviteRequired, false);
  assert.equal(loadConfig({ BETA_INVITE_REQUIRED: 'true' }).betaInviteRequired, true);
  assert.equal(loadConfig({ BETA_INVITE_REQUIRED: 'false' }).betaInviteRequired, false);
  assert.throws(() => loadConfig({ BETA_INVITE_REQUIRED: 'yes' }), /Invalid boolean configuration/);
});

test('种码命令使用新表结构，不再接受次数参数', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-invite-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'invite.db');
  const environment = { ...process.env, NODE_ENV: 'test', DB_PATH: dbPath, BETA_INVITE_REQUIRED: 'true' };
  const result = spawnSync(process.execPath, ['src/invite.js', 'add', 'TEST-CLI-ONLY', '--name', '命令行测试'], {
    cwd: rootDirectory, env: environment, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const oldOption = spawnSync(process.execPath, ['src/invite.js', 'add', 'TEST-CLI-OLD', '--name', '旧参数', '--uses', '3'], {
    cwd: rootDirectory, env: environment, encoding: 'utf8'
  });
  assert.equal(oldOption.status, 1);
  const db = openDatabase(loadConfig({ NODE_ENV: 'test', DB_PATH: dbPath }));
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT code, bound_name, active, used_count FROM invites').get(), {
    code: 'TEST-CLI-ONLY', bound_name: '命令行测试', active: 1, used_count: 0
  });
});

test('旧注册邀请表升级时保留码、绑定名和计数，删除次数与账号使用记录', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-invite-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'migration.db');
  const old = new Database(dbPath);
  old.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('001_initial.sql', new Date().toISOString());
  old.exec(fs.readFileSync(path.join(rootDirectory, 'src/db/migrations/002_invites.sql'), 'utf8'));
  old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('002_invites.sql', new Date().toISOString());
  old.prepare('INSERT INTO invites (code, bound_name, max_uses, used_count, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('TEST-MIGRATED', '旧绑定名', 3, 2, new Date().toISOString());
  old.close();

  const config = loadConfig({ NODE_ENV: 'test', DB_PATH: dbPath });
  const db = openDatabase(config);
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT code, bound_name, active, used_count FROM invites').get(), {
    code: 'TEST-MIGRATED', bound_name: '旧绑定名', active: 1, used_count: 2
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'invite_uses'").get().count, 0);
});

test('内测欢迎文案只写一处，绑定名由输码页传递，公共脚本负责全站展示', () => {
  const copy = '本网站处于内测阶段：功能可能不稳定，内测期间的账号和地图数据不保证保留到正式版；遇到问题请联系站长反馈。本地客户端挂机采集数据存在游戏账号封禁风险，请自行评估后使用。';
  const publicFiles = [
    'public/index.html', 'public/auth.html', 'public/beta.html', 'public/assets/home.js',
    'public/assets/auth.js', 'public/assets/beta.js', 'public/assets/common.js'
  ].map((file) => fs.readFileSync(path.join(rootDirectory, file), 'utf8'));
  assert.equal(publicFiles.reduce((count, source) => count + source.split(copy).length - 1, 0), 1);
  assert.match(publicFiles[5], /sessionStorage\.setItem\(BETA_WELCOME_PENDING, data\.boundName\)/);
  assert.match(publicFiles[6], /sessionStorage\.getItem\(BETA_WELCOME_PENDING\)/);
  assert.match(publicFiles[6], /欢迎体验内测版本，\$\{boundName\}。/);
  assert.doesNotMatch(publicFiles[1], /inviteCode|invite-field/);
  assert.doesNotMatch(publicFiles[3], /BETA_WELCOME|showBetaWelcome/);
});


test('根路径部署不会生成协议相对重定向，畸形 cookie 按未授权处理', async (t) => {
  const context = testContext();
  context.config.betaInviteRequired = true;
  context.config.publicBasePath = '/';
  t.after(() => context.close());
  const request = supertest(context.app);
  const page = await request.get('/create.html?from=root').set('Cookie', 'lagrange_beta_pass=%').expect(302);
  assert.equal(page.headers.location, '/beta.html?next=%2Fcreate.html%3Ffrom%3Droot');
  const api = await request.get('/api/v1/maps').set('Cookie', 'lagrange_beta_pass=%').expect(401);
  assert.equal(api.body.betaEntry, '/beta.html');
});
