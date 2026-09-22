import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Purpose-scoped signed capability tokens for /preferences/:token and /unsubscribe/:token (A30).
 * Payload: purpose, contact id, expiry, key version. No raw email in the URL. GET never mutates.
 */
export type TokenPurpose = 'preferences' | 'unsubscribe' | 'deletion_verify';

export type TokenPayload = { p: TokenPurpose; c: string; exp: number; v: number; n: string };

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signToken(payload: Omit<TokenPayload, 'n' | 'v'> & { v?: number }, key: string): string {
  if (!key || key.length < 16) throw new Error('signing key too short');
  const full: TokenPayload = { ...payload, v: payload.v ?? 1, n: b64url(randomBytes(8)) };
  const body = b64url(Buffer.from(JSON.stringify(full), 'utf8'));
  const sig = b64url(createHmac('sha256', key).update(body).digest());
  return `${body}.${sig}`;
}

export type TokenVerification = { ok: true; payload: TokenPayload } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_purpose' };

export function verifyToken(token: string, key: string, expectedPurpose: TokenPurpose, now = new Date()): TokenVerification {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[1], 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad_signature' };
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now.getTime()) return { ok: false, reason: 'expired' };
  if (payload.p !== expectedPurpose) return { ok: false, reason: 'wrong_purpose' };
  return { ok: true, payload };
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const shown = local.length <= 2 ? local[0] ?? '*' : local.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, local.length - shown.length))}@${domain}`;
}
