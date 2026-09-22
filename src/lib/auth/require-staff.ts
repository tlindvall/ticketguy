import { headers } from 'next/headers';
import { getAuth } from './index';
import { env } from '@/lib/config/env';

export type StaffRole = 'admin' | 'reviewer';
export type Staff = { userId: string; email: string; role: StaffRole; twoFactorEnabled: boolean };

export class AuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
  }
}

/**
 * Server-side staff authorization for every /admin page and /api/admin route (A33/A46).
 * Requires a valid session, an allowlisted staff email, the required role, and TOTP enabled.
 * In development only, DEV_ALLOW_STAFF_WITHOUT_MFA=true relaxes the MFA requirement (never production-like).
 */
export async function requireStaff(minRole: StaffRole = 'reviewer'): Promise<Staff> {
  const auth = await getAuth();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) throw new AuthError(401, 'unauthenticated');
  const e = env();
  const u = session.user as unknown as { id: string; email: string; role?: string; twoFactorEnabled?: boolean | null };
  const email = u.email.toLowerCase();
  if (e.STAFF_EMAIL_ALLOWLIST.length && !e.STAFF_EMAIL_ALLOWLIST.includes(email)) throw new AuthError(403, 'not_staff');
  const role = (u.role === 'admin' ? 'admin' : 'reviewer') as StaffRole;
  if (minRole === 'admin' && role !== 'admin') throw new AuthError(403, 'admin_required');
  const mfa = !!u.twoFactorEnabled;
  const devRelax = !e.isProductionLike && process.env.DEV_ALLOW_STAFF_WITHOUT_MFA === 'true';
  if (!mfa && !devRelax) throw new AuthError(403, 'mfa_required');
  return { userId: u.id, email, role, twoFactorEnabled: mfa };
}

/** CSRF / origin check for session-authenticated mutations. */
export function assertSameOrigin(req: Request): void {
  const e = env();
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const allowed = new URL(e.APP_URL).origin;
  if (origin && origin !== allowed) throw new AuthError(403, 'bad_origin');
  if (!origin && referer && new URL(referer).origin !== allowed) throw new AuthError(403, 'bad_origin');
}

export function authErrorResponse(e: unknown): Response | null {
  if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
  return null;
}
