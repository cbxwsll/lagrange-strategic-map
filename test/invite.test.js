import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import supertest from 'supertest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { registerUser, testContext } from './helpers.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function seedInvite(context, code, maxUses) {
  context.db.prepare('INSERT INTO invites (code, bound_name, max_uses, used_count, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(code, '自动化测试', maxUses, new Date().toISOString());
}

async function attemptRegistration(request, context, { email, intent = 'join', inviteCode }) {
  await request.post('/api/v1/auth/email-codes').send({ email, purpose: 'register' }).expect(202);
  const { code } = context.sent.filter((item) => item.email === email && item.purpose === 'register').at(-1);
  const body = { email, code, username: '内测用户', password: 'passw0rd!', intent };
  if (inviteCode !== undefined) body.inviteCode = inviteCode;
  return request.post('/api/v1/auth/register').send(body);
}

test('内测开：无码和错码拒绝，正确码计数并记录账号，单次码用完拒绝', async (t) => {
  const context = testContext();
  context.config.betaInviteRequired = true;
  t.after(() => context.close());
  const request = supertest(context.app);
  seedInvite(context, 'TEST-SINGLE-USE', 1);

  const missing = await attemptRegistration(request, context, { email: 'missing-invite@example.com' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'INVITE_REQUIRED');
  assert.match(missing.body.error.message, /必须填写有效邀请码/);

  const invalid = await attemptRegistration(request, context, { email: 'wrong-invite@example.com', inviteCode: 'TEST-NOT-EXIST' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVITE_INVALID');
  assert.match(invalid.body.error.message, /邀请码无效/);
  assert.equal(context.db.prepare('SELECT used_count FROM invites WHERE code = ?').get('TEST-SINGLE-USE').used_count, 0);

  const accepted = await attemptRegistration(request, context, { email: 'valid-invite@example.com', intent: 'create', inviteCode: 'TEST-SINGLE-USE' });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.betaWelcome, true);
  assert.equal(accepted.body.nextRoute, '/maps/new');
  const invite = context.db.prepare('SELECT used_count FROM invites WHERE code = ?').get('TEST-SINGLE-USE');
  assert.equal(invite.used_count, 1);
  const usage = context.db.prepare('SELECT user_id FROM invite_uses WHERE invite_code = ?').get('TEST-SINGLE-USE');
  assert.equal(usage.user_id, accepted.body.user.id);

  const exhausted = await attemptRegistration(request, context, { email: 'exhausted-invite@example.com', inviteCode: 'TEST-SINGLE-USE' });
  assert.equal(exhausted.status, 400);
  assert.equal(exhausted.body.error.code, 'INVITE_EXHAUSTED');
  assert.match(exhausted.body.error.message, /次数已用完/);
  assert.equal(context.db.prepare('SELECT used_count FROM invites WHERE code = ?').get('TEST-SINGLE-USE').used_count, 1);
});

test('内测开：不限次码可供创建和加入两条注册流程重复使用', async (t) => {
  const context = testContext();
  context.config.betaInviteRequired = true;
  t.after(() => context.close());
  const request = supertest(context.app);
  seedInvite(context, 'TEST-UNLIMITED', 0);

  const creator = await attemptRegistration(request, context, { email: 'unlimited-create@example.com', intent: 'create', inviteCode: 'TEST-UNLIMITED' });
  const joiner = await attemptRegistration(request, context, { email: 'unlimited-join@example.com', intent: 'join', inviteCode: 'TEST-UNLIMITED' });
  assert.equal(creator.status, 201);
  assert.equal(joiner.status, 201);
  assert.equal(joiner.body.nextRoute, '/maps');
  assert.equal(context.db.prepare('SELECT used_count FROM invites WHERE code = ?').get('TEST-UNLIMITED').used_count, 2);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM invite_uses WHERE invite_code = ?').get('TEST-UNLIMITED').count, 2);
  const session = await request.get('/api/v1/auth/session').set('Authorization', `Bearer ${joiner.body.token}`).expect(200);
  assert.equal(session.body.inviteRequired, true);
});

test('内测关：无邀请码可注册且不弹内测欢迎', async (t) => {
  const context = testContext();
  t.after(() => context.close());
  const request = supertest(context.app);
  const user = await registerUser(request, context, { email: 'open-registration@example.com', intent: 'join' });
  assert.equal(user.betaWelcome, false);
  const session = await request.get('/api/v1/auth/session').expect(200);
  assert.equal(session.body.inviteRequired, false);
});

test('BETA_INVITE_REQUIRED 只接受明确 true/false，缺省关闭', () => {
  assert.equal(loadConfig({}).betaInviteRequired, false);
  assert.equal(loadConfig({ BETA_INVITE_REQUIRED: 'true' }).betaInviteRequired, true);
  assert.equal(loadConfig({ BETA_INVITE_REQUIRED: 'false' }).betaInviteRequired, false);
  assert.throws(() => loadConfig({ BETA_INVITE_REQUIRED: 'yes' }), /Invalid boolean configuration/);
});

test('种码命令写入 SQLite，邀请码不需要进入仓库配置', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-invite-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'invite.db');
  const result = spawnSync(process.execPath, ['src/invite.js', 'add', 'TEST-CLI-ONLY', '--name', '命令行测试', '--uses', '3'], {
    cwd: rootDirectory,
    env: { ...process.env, NODE_ENV: 'test', DB_PATH: dbPath, BETA_INVITE_REQUIRED: 'true' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const db = openDatabase(loadConfig({ NODE_ENV: 'test', DB_PATH: dbPath }));
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT code, bound_name, max_uses, used_count FROM invites').get(), {
    code: 'TEST-CLI-ONLY', bound_name: '命令行测试', max_uses: 3, used_count: 0
  });
});

test('内测欢迎注意事项前端只写一处，注册字段和弹窗均有分支', () => {
  const copy = '本网站处于内测阶段：功能可能不稳定，内测期间的账号和地图数据不保证保留到正式版；遇到问题请联系站长反馈。本地客户端挂机采集数据存在游戏账号封禁风险，请自行评估后使用。';
  const publicFiles = [
    'public/index.html', 'public/auth.html', 'public/assets/home.js', 'public/assets/auth.js', 'public/assets/common.js'
  ].map((file) => fs.readFileSync(path.join(rootDirectory, file), 'utf8'));
  assert.equal(publicFiles.reduce((count, source) => count + source.split(copy).length - 1, 0), 1);
  assert.match(publicFiles[2], /sessionStorage\.getItem\(BETA_WELCOME_PENDING\)/);
  assert.match(publicFiles[2], /sessionStorage\.removeItem\(BETA_WELCOME_PENDING\)/);
  assert.match(publicFiles[3], /session\.inviteRequired/);
});
