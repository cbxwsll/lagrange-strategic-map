import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { cookies } from './auth.js';
import { fail } from './errors.js';

export const BETA_COOKIE = 'lagrange_beta_pass';
const BETA_COOKIE_MS = 7 * 86_400_000;
const PUBLIC_GATE_FILES = new Set(['/beta.html', '/assets/styles.css', '/assets/beta.js', '/assets/runtime.js', '/favicon.ico']);

function betaEntry(config) {
  return `${config.publicBasePath.replace(/\/+$/, '')}/beta.html`;
}

function sign(config, payload) {
  return createHmac('sha256', config.codeHmacSecret).update(payload).digest('base64url');
}

function issuePass(config, code, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ code, exp: expiresAt }), 'utf8').toString('base64url');
  return `${payload}.${sign(config, payload)}`;
}

export function betaInviteFromRequest(req, config, database) {
  if (!config.betaInviteRequired) return null;
  const token = cookies(req)[BETA_COOKIE] || '';
  const [payload, suppliedSignature, extra] = token.split('.');
  if (!payload || !suppliedSignature || extra) return null;
  const expectedSignature = sign(config, payload);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let pass;
  try { pass = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!Number.isSafeInteger(pass.exp) || pass.exp <= Date.now() || typeof pass.code !== 'string') return null;
  return database.prepare('SELECT code, bound_name FROM invites WHERE code = ? AND active = 1').get(pass.code) || null;
}

export function setBetaCookie(res, config, token, expiresAt) {
  res.cookie(BETA_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: config.publicBasePath,
    expires: new Date(expiresAt)
  });
}

export function betaGate(config) {
  return (req, res, next) => {
    if (!config.betaInviteRequired || req.path === '/healthz' || req.path === '/api/v1/beta/enter' || PUBLIC_GATE_FILES.has(req.path)) {
      return next();
    }
    const invite = betaInviteFromRequest(req, config, req.app.locals.db);
    if (invite) {
      req.betaInvite = invite;
      return next();
    }
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({
        error: { code: 'BETA_REQUIRED', message: '请输入有效内测通行码后再访问' },
        betaEntry: betaEntry(config)
      });
    }
    const nextPath = req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//') ? req.originalUrl : '/';
    res.redirect(302, `${betaEntry(config)}?next=${encodeURIComponent(nextPath)}`);
  };
}

export function createBetaRouter(config) {
  const router = Router();
  router.get('/', (req, res) => res.json({ required: config.betaInviteRequired === true }));
  router.post('/', (req, res) => {
    if (!config.betaInviteRequired) return res.json({ required: false });
    const input = z.object({ code: z.string().trim().min(1).max(200) }).parse(req.body);
    const database = req.app.locals.db;
    const updated = database.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ? AND active = 1').run(input.code);
    if (!updated.changes) {
      const invite = database.prepare('SELECT active FROM invites WHERE code = ?').get(input.code);
      if (invite) fail(403, 'BETA_CODE_DISABLED', '内测通行码已停用');
      fail(400, 'BETA_CODE_INVALID', '内测通行码无效，请检查后重试');
    }
    const invite = database.prepare('SELECT bound_name FROM invites WHERE code = ?').get(input.code);
    const expiresAt = Date.now() + BETA_COOKIE_MS;
    setBetaCookie(res, config, issuePass(config, input.code, expiresAt), expiresAt);
    res.json({ required: true, boundName: invite.bound_name, expiresAt: new Date(expiresAt).toISOString() });
  });
  return router;
}
