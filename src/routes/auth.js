import { Router } from 'express';
import { z } from 'zod';
import { authenticated, audit, clearSessionCookie, issueSession, setSessionCookie } from '../lib/auth.js';
import { asyncRoute, fail } from '../lib/errors.js';
import {
  assertPasswordComplexity, consumeRateLimit, hashEmailCode, hashPassword,
  normalizeEmail, now, publicUser, randomCode, uuid, verifyPassword
} from '../lib/security.js';

const email = z.string().trim().email().max(254).transform(normalizeEmail);
const purpose = z.enum(['register', 'login', 'recovery']);
const username = z.string().trim().min(1).max(40);
const password = z.string().min(1).max(72);

function sessionResponse(db, config, user) {
  const session = issueSession(db, config, user.id);
  return { user: publicUser(user), token: session.token, expiresAt: session.expires };
}

function latestChallenge(db, emailAddress, codePurpose) {
  return db.prepare(`SELECT * FROM email_challenges WHERE email = ? AND purpose = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1`).get(emailAddress, codePurpose);
}

function consumeCode(db, config, emailAddress, codePurpose, code) {
  const challenge = latestChallenge(db, emailAddress, codePurpose);
  if (!challenge || challenge.expires_at <= now() || challenge.attempts >= challenge.max_attempts) {
    fail(400, 'CODE_INVALID', '验证码无效、已过期或尝试次数已用完');
  }
  const expected = hashEmailCode(config.codeHmacSecret, emailAddress, codePurpose, code);
  if (expected !== challenge.code_hash) {
    db.prepare('UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);
    fail(400, 'CODE_INVALID', '验证码无效、已过期或尝试次数已用完');
  }
  db.prepare('UPDATE email_challenges SET consumed_at = ? WHERE id = ?').run(now(), challenge.id);
}

export function createAuthRouter(config, mailer) {
  const router = Router();

  router.post('/email-codes', asyncRoute(async (req, res) => {
    const input = z.object({ email, purpose }).parse(req.body);
    consumeRateLimit(req.app.locals.db, `code:${req.ip}:${input.email}`, { limit: 10, windowSeconds: 3600 });
    const database = req.app.locals.db;
    const user = database.prepare('SELECT id FROM users WHERE email = ?').get(input.email);
    if (input.purpose === 'register' && user) fail(409, 'EMAIL_REGISTERED', '该邮箱已注册');
    if (input.purpose !== 'register' && !user) return res.status(202).json({ accepted: true });

    const previous = latestChallenge(database, input.email, input.purpose);
    if (previous && Date.now() - Date.parse(previous.last_sent_at) < config.emailCodeResendSeconds * 1000) {
      fail(429, 'CODE_RESEND_TOO_SOON', '验证码发送过于频繁，请稍后再试');
    }
    const code = randomCode();
    const timestamp = now();
    const id = uuid();
    database.prepare('UPDATE email_challenges SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL')
      .run(timestamp, input.email, input.purpose);
    database.prepare(`INSERT INTO email_challenges
      (id, email, purpose, code_hash, expires_at, max_attempts, last_sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.email, input.purpose, hashEmailCode(config.codeHmacSecret, input.email, input.purpose, code),
        new Date(Date.now() + config.emailCodeTtlMinutes * 60_000).toISOString(),
        config.emailCodeMaxAttempts, timestamp, timestamp);
    try {
      await mailer.sendCode(input.email, input.purpose, code);
    } catch (error) {
      database.prepare('DELETE FROM email_challenges WHERE id = ?').run(id);
      throw error;
    }
    res.status(202).json({ accepted: true, expiresInSeconds: config.emailCodeTtlMinutes * 60 });
  }));

  router.post('/register', asyncRoute(async (req, res) => {
    const input = z.object({ email, code: z.string().regex(/^\d{6}$/), username, password, intent: z.enum(['create', 'join']).default('create') }).parse(req.body);
    assertPasswordComplexity(input.password);
    const database = req.app.locals.db;
    consumeCode(database, config, input.email, 'register', input.code);
    if (database.prepare('SELECT id FROM users WHERE email = ?').get(input.email)) fail(409, 'EMAIL_REGISTERED', '该邮箱已注册');
    const passwordHash = await hashPassword(input.password, config.bcryptRounds);
    const user = { id: uuid(), email: input.email, username: input.username, created_at: now() };
    database.prepare('INSERT INTO users (id, email, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, user.email, user.username, passwordHash, user.created_at, user.created_at);
    const response = sessionResponse(database, config, user);
    setSessionCookie(res, config, response.token, response.expiresAt);
    res.status(201).json({ ...response, nextRoute: input.intent === 'create' ? '/maps/new' : '/maps' });
  }));

  router.post('/login', asyncRoute(async (req, res) => {
    const input = z.object({ email, password }).parse(req.body);
    consumeRateLimit(req.app.locals.db, `login:${req.ip}:${input.email}`, { limit: 10, windowSeconds: 600 });
    const user = req.app.locals.db.prepare('SELECT * FROM users WHERE email = ?').get(input.email);
    if (!user || !(await verifyPassword(input.password, user.password_hash))) fail(401, 'LOGIN_FAILED', '邮箱或密码错误');
    const response = sessionResponse(req.app.locals.db, config, user);
    setSessionCookie(res, config, response.token, response.expiresAt);
    res.json(response);
  }));

  router.post('/login/email', asyncRoute(async (req, res) => {
    const input = z.object({ email, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    consumeRateLimit(req.app.locals.db, `login-code:${req.ip}:${input.email}`, { limit: 10, windowSeconds: 600 });
    const database = req.app.locals.db;
    consumeCode(database, config, input.email, 'login', input.code);
    const user = database.prepare('SELECT * FROM users WHERE email = ?').get(input.email);
    if (!user) fail(401, 'LOGIN_FAILED', '登录失败');
    const response = sessionResponse(database, config, user);
    setSessionCookie(res, config, response.token, response.expiresAt);
    res.json(response);
  }));

  router.post('/logout', authenticated, (req, res) => {
    req.app.locals.db.prepare('DELETE FROM sessions WHERE id = ?').run(req.user.session_id);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.get('/session', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null });
  });

  router.get('/me', authenticated, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  router.put('/recovery/question', authenticated, asyncRoute(async (req, res) => {
    const input = z.object({ question: z.string().trim().min(1).max(200), answer: z.string().trim().min(1).max(100) }).parse(req.body);
    const answerHash = await hashPassword(input.answer, config.bcryptRounds);
    req.app.locals.db.prepare(`INSERT INTO recovery_questions (user_id, question, answer_hash, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET question = excluded.question, answer_hash = excluded.answer_hash, updated_at = excluded.updated_at`)
      .run(req.user.id, input.question, answerHash, now());
    res.status(204).end();
  }));

  router.get('/recovery/question/mine', authenticated, (req, res) => {
    const row = req.app.locals.db.prepare('SELECT question FROM recovery_questions WHERE user_id = ?').get(req.user.id);
    res.json({ question: row?.question || null });
  });

  router.get('/recovery/question', (req, res) => {
    const input = z.object({ email }).parse(req.query);
    const row = req.app.locals.db.prepare(`SELECT recovery_questions.question FROM recovery_questions
      JOIN users ON users.id = recovery_questions.user_id WHERE users.email = ?`).get(input.email);
    if (!row) fail(404, 'RECOVERY_NOT_CONFIGURED', '该账号未设置自定义找回问题');
    res.json({ question: row.question });
  });

  router.post('/recovery/reset', asyncRoute(async (req, res) => {
    const input = z.object({ email, answer: z.string().min(1).max(100), newPassword: password }).parse(req.body);
    assertPasswordComplexity(input.newPassword, 'newPassword');
    consumeRateLimit(req.app.locals.db, `recovery:${req.ip}:${input.email}`, { limit: 5, windowSeconds: 600 });
    const row = req.app.locals.db.prepare(`SELECT users.id, recovery_questions.answer_hash FROM users
      JOIN recovery_questions ON recovery_questions.user_id = users.id WHERE users.email = ?`).get(input.email);
    if (!row || !(await verifyPassword(input.answer, row.answer_hash))) fail(401, 'RECOVERY_FAILED', '找回问题答案错误');
    const passwordHash = await hashPassword(input.newPassword, config.bcryptRounds);
    req.app.locals.db.transaction(() => {
      req.app.locals.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, now(), row.id);
      req.app.locals.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      audit(req.app.locals.db, null, row.id, 'account.password_recovered', row.id);
    })();
    res.status(204).end();
  }));

  return router;
}
