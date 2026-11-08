import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function integer(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value ?? '', 10);
  const selected = Number.isFinite(parsed) ? parsed : fallback;
  if (selected < min || selected > max) throw new Error(`Invalid integer configuration: ${value}`);
  return selected;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean configuration: ${value}`);
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const codeHmacSecret = env.CODE_HMAC_SECRET || '';
  if (nodeEnv === 'production' && codeHmacSecret.length < 32) {
    throw new Error('CODE_HMAC_SECRET must contain at least 32 characters in production');
  }

  const smtp = {
    host: env.SMTP_HOST || '',
    port: integer(env.SMTP_PORT, 465, { max: 65535 }),
    secure: env.SMTP_SECURE !== 'false',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || ''
  };
  if (nodeEnv === 'production' && (!smtp.host || !smtp.user || !smtp.pass || !smtp.from)) {
    throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM are required in production');
  }

  return {
    nodeEnv,
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 9200, { max: 65535 }),
    trustProxy: integer(env.TRUST_PROXY, 1, { min: 0, max: 10 }),
    publicBasePath: env.PUBLIC_BASE_PATH || '/project/lagrange',
    dbPath: path.resolve(rootDir, env.DB_PATH || './data/lagrange.db'),
    codeHmacSecret,
    sessionTtlDays: integer(env.SESSION_TTL_DAYS, 30, { max: 365 }),
    memberSessionTtlDays: integer(env.MEMBER_SESSION_TTL_DAYS, 7, { max: 30 }),
    bcryptRounds: integer(env.BCRYPT_ROUNDS, 12, { min: 10, max: 14 }),
    cookieSecure: env.COOKIE_SECURE !== 'false',
    betaInviteRequired: boolean(env.BETA_INVITE_REQUIRED, false),
    smtp,
    emailCodeTtlMinutes: integer(env.EMAIL_CODE_TTL_MINUTES, 10, { max: 60 }),
    emailCodeMaxAttempts: integer(env.EMAIL_CODE_MAX_ATTEMPTS, 5, { max: 20 }),
    emailCodeResendSeconds: integer(env.EMAIL_CODE_RESEND_SECONDS, 60, { max: 3600 })
  };
}
