import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import type { Db } from '@/lib/db';
import * as schema from '@/lib/db/schema';
import { env } from '@/lib/config/env';

/**
 * Staff-only Better Auth. Public signup is disabled; staff are created by scripts/create-staff.ts against
 * STAFF_EMAIL_ALLOWLIST. TOTP two-factor is enforced for protected routes by requireStaff().
 */
export function createAuth(db: Db, opts: { allowSignUp?: boolean } = {}) {
  const e = env();
  return betterAuth({
    baseURL: e.BETTER_AUTH_URL ?? e.APP_URL,
    secret: e.BETTER_AUTH_SECRET ?? (e.isProductionLike ? undefined : 'dev-only-insecure-secret-change-me-0123456789'),
    database: drizzleAdapter(db, { provider: 'pg', schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification, twoFactor: schema.twoFactor } }),
    emailAndPassword: { enabled: true, disableSignUp: !opts.allowSignUp, minPasswordLength: 12 },
    user: { additionalFields: { role: { type: 'string', required: false, defaultValue: 'reviewer', input: false } } },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    plugins: [twoFactor({ issuer: 'Ticket Guy staff' })],
    advanced: { cookiePrefix: 'tg', useSecureCookies: e.isProductionLike },
    trustedOrigins: [e.APP_URL],
  });
}

export type Auth = ReturnType<typeof createAuth>;
const g = globalThis as unknown as { __tgAuth?: Promise<Auth> };
export function getAuth(): Promise<Auth> {
  if (!g.__tgAuth) g.__tgAuth = (async () => createAuth((await (await import('@/lib/db')).getDb()).db))();
  return g.__tgAuth;
}
