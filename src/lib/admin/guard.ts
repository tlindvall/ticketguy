import { redirect } from 'next/navigation';
import { requireStaff, AuthError, type StaffRole } from '@/lib/auth/require-staff';

/** Page-level guard: unauthenticated → login; missing MFA → setup; wrong role → 403 page text. */
export async function guardPage(minRole: StaffRole = 'reviewer') {
  try {
    return await requireStaff(minRole);
  } catch (e) {
    if (e instanceof AuthError) {
      if (process.env.TG_DEBUG_AUTH === 'true') console.error('[guardPage]', e.status, e.message);
      if (e.status === 401) redirect('/admin/login');
      if (e.message === 'mfa_required') redirect('/admin/setup-mfa');
      throw e;
    }
    if (process.env.TG_DEBUG_AUTH === 'true') console.error('[guardPage] unexpected', e);
    throw e;
  }
}
