/**
 * Creates a staff account (invite-only). Usage:
 *   pnpm tsx scripts/create-staff.ts <email> <role admin|reviewer>
 * Password is read from STAFF_INITIAL_PASSWORD (min 12 chars) and must be rotated at first login.
 * The user must complete TOTP setup at /admin/setup-mfa before any staff route works.
 */
import { eq } from 'drizzle-orm';
import { openDatabase } from '../src/lib/db';
import { applyMigrations } from '../src/lib/db/migrate';
import { createAuth } from '../src/lib/auth';
import { user } from '../src/lib/db/schema';
import { env } from '../src/lib/config/env';

const [email, role = 'reviewer'] = process.argv.slice(2);
const password = process.env.STAFF_INITIAL_PASSWORD;
if (!email || !password || password.length < 12) {
  console.error('usage: STAFF_INITIAL_PASSWORD=<min 12 chars> pnpm tsx scripts/create-staff.ts <email> [admin|reviewer]');
  process.exit(2);
}
const e = env();
if (e.STAFF_EMAIL_ALLOWLIST.length && !e.STAFF_EMAIL_ALLOWLIST.includes(email.toLowerCase())) {
  console.error(`refusing: ${email} is not in STAFF_EMAIL_ALLOWLIST`);
  process.exit(2);
}
const h = await openDatabase();
await applyMigrations(h);
const auth = createAuth(h.db, { allowSignUp: true });
const res = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0] ?? email } });
await h.db.update(user).set({ role: role === 'admin' ? 'admin' : 'reviewer' }).where(eq(user.id, res.user.id));
console.log(`[staff] created ${email} as ${role}; TOTP enrollment required at /admin/setup-mfa`);
await h.close();
