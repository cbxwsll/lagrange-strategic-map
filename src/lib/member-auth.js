import { cookies } from './auth.js';
import { assertNotObserver } from './identities.js';
import { hashToken, now, randomToken, uuid } from './security.js';

export const MEMBER_COOKIE = 'lagrange_member';

export function issueMemberSession(db, config, mapId, gameIdentityId) {
  assertNotObserver(db, gameIdentityId);
  const token = randomToken();
  const timestamp = now();
  const ttlDays = config.memberSessionTtlDays || 7;
  const expires = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  db.prepare(`INSERT INTO member_sessions
    (id, map_id, game_identity_id, token_hash, expires_at, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), mapId, gameIdentityId, hashToken(token), expires, timestamp, timestamp);
  return { token, expires };
}

export function setMemberCookie(res, config, token, expires) {
  res.cookie(MEMBER_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: config.publicBasePath,
    expires: new Date(expires)
  });
}

export function memberSessionForToken(db, token) {
  if (!token) return null;
  return db.prepare(`SELECT member_sessions.*, game_identities.game_id, game_identities.game_name
    FROM member_sessions JOIN game_identities ON game_identities.id = member_sessions.game_identity_id
    WHERE member_sessions.token_hash = ? AND member_sessions.expires_at > ? AND game_identities.is_observer = 0`)
    .get(hashToken(token), now());
}

export function optionalMemberAuth(req, res, next) {
  req.memberSession = memberSessionForToken(req.app.locals.db, cookies(req)[MEMBER_COOKIE]);
  next();
}

export function memberTokenFromWebSocketRequest(req) {
  return cookies(req)[MEMBER_COOKIE] || null;
}

export function viewerForMap(req, mapId) {
  const member = req.memberSession?.map_id === mapId ? req.memberSession : null;
  return {
    userId: req.user?.id || null,
    gameIdentityId: member?.game_identity_id || null,
    memberSession: member
  };
}

export function mapViewAuthenticated(req, res, next) {
  if (!req.user && !req.memberSession) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录或使用成员通行会话' } });
  }
  next();
}
