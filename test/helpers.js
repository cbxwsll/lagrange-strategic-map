import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';

export function testContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-test-'));
  const config = {
    nodeEnv: 'test', host: '127.0.0.1', port: 0, trustProxy: 0,
    publicBasePath: '/project/lagrange', dbPath: path.join(directory, 'test.db'),
    codeHmacSecret: 'test-only-hmac-secret-with-at-least-32-characters', sessionTtlDays: 30,
    bcryptRounds: 10, cookieSecure: false, betaInviteRequired: false,
    smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
    emailCodeTtlMinutes: 10, emailCodeMaxAttempts: 5, emailCodeResendSeconds: 60
  };
  const sent = [];
  const mailer = { async sendCode(email, purpose, code) { sent.push({ email, purpose, code }); } };
  const db = openDatabase(config);
  const app = buildApp({ config, db, mailer });
  return {
    app, db, config, sent,
    close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

export async function registerUser(request, context, overrides = {}) {
  const emailAddress = overrides.email || `user-${Math.random().toString(16).slice(2)}@example.com`;
  await request.post('/api/v1/auth/email-codes').send({ email: emailAddress, purpose: 'register' }).expect(202);
  const { code } = context.sent.filter((item) => item.email === emailAddress && item.purpose === 'register').at(-1);
  const response = await request.post('/api/v1/auth/register').send({
    email: emailAddress, code, username: overrides.username || '测试用户',
    password: overrides.password || 'passw0rd!', intent: overrides.intent || 'create'
  }).expect(201);
  return { ...response.body, password: overrides.password || 'passw0rd!' };
}

export function auth(user) {
  return { Authorization: `Bearer ${user.token}` };
}

export const reportBody = (overrides = {}) => ({
  batchId: `batch-${Math.random().toString(16).slice(2)}`,
  protocolVersion: 'weiyang-3.0',
  dataAccount: { gameId: 'data-account-1', gameName: '数据小号' },
  galaxy: { id: 'galaxy-1', name: '第一星系' },
  organization: { id: 'org-1', name: '测试联合体' },
  serverStatus: 'online',
  roster: [{ gameId: 'data-account-1', gameName: '数据小号', isLeader: true }],
  snapshots: [{ observedAt: new Date().toISOString(), bodies: [{ key: 'body-1', name: '测试基地', type: 'base', x: 1, y: 2, features: { level: 3 } }], fleets: [] }],
  ...overrides
});
