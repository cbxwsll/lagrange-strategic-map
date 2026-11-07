import { fail } from './errors.js';
import { hashToken, now, randomToken, uuid } from './security.js';

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function requestToken(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return cookies(req).lagrange_session || null;
}

export function issueSession(db, config, userId) {
  const token = randomToken();
  const timestamp = now();
  const expires = new Date(Date.now() + config.sessionTtlDays * 86_400_000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), userId, hashToken(token), expires, timestamp, timestamp);
  return { token, expires };
}

export function setSessionCookie(res, config, token, expires) {
  res.cookie('lagrange_session', token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: config.publicBasePath,
    expires: new Date(expires)
  });
}

export function clearSessionCookie(res, config) {
  res.clearCookie('lagrange_session', { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: config.publicBasePath });
}

export function userForToken(db, token) {
  if (!token) return null;
  return db.prepare(`SELECT users.*, sessions.id AS session_id, sessions.expires_at AS session_expires
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(hashToken(token), now());
}

export function optionalAuth(req, res, next) {
  req.authToken = requestToken(req);
  req.user = userForToken(req.app.locals.db, req.authToken);
  next();
}

export function authenticated(req, res, next) {
  if (!req.user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
  req.app.locals.db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(now(), req.user.session_id);
  next();
}

export function tokenFromWebSocketRequest(req) {
  return cookies(req).lagrange_session || null;
}

export function audit(db, mapId, actorUserId, action, subjectId, details = {}) {
  db.prepare('INSERT INTO audit_log (id, map_id, actor_user_id, action, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), mapId, actorUserId, action, subjectId, JSON.stringify(details), now());
}
