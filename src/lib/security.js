import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { fail } from './errors.js';

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const normalizeEmail = (email) => email.trim().toLowerCase();
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const randomCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

export function hashEmailCode(secret, email, purpose, code) {
  return crypto.createHmac('sha256', secret).update(`${normalizeEmail(email)}\0${purpose}\0${code}`).digest('hex');
}

export function assertPasswordComplexity(password, field = 'password') {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (password.length < 8 || bytes > 72 || /\s/.test(password)) {
    fail(400, 'PASSWORD_INVALID', `${field} 须为 8–72 字节且不能包含空白字符`);
  }
  const classes = [/\p{L}/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u].filter((pattern) => pattern.test(password)).length;
  if (classes < 2) fail(400, 'PASSWORD_TOO_WEAK', `${field} 须包含字母、数字、特殊符号中的任意两类`);
}

export const hashPassword = (password, rounds) => bcrypt.hash(password, rounds);
export const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

export function publicUser(row) {
  return { id: row.id, email: row.email, username: row.username, createdAt: row.created_at };
}

export function consumeRateLimit(db, key, { limit, windowSeconds }) {
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const timestamp = Date.now();
  const result = db.transaction(() => {
    const row = db.prepare('SELECT window_started_at, count FROM rate_limits WHERE key_hash = ?').get(keyHash);
    if (!row || timestamp - Date.parse(row.window_started_at) >= windowSeconds * 1000) {
      db.prepare(`INSERT INTO rate_limits (key_hash, window_started_at, count) VALUES (?, ?, 1)
        ON CONFLICT(key_hash) DO UPDATE SET window_started_at = excluded.window_started_at, count = 1`)
        .run(keyHash, new Date(timestamp).toISOString());
      return;
    }
    if (row.count >= limit) fail(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试');
    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key_hash = ?').run(keyHash);
  });
  result();
}
