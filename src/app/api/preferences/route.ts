import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { verifyToken } from '@/lib/security/tokens';
import { audit } from '@/lib/util/audit';
import { revokeMarketing } from '@/lib/domain/suppression';

export const dynamic = 'force-dynamic';
export const NOTICE_VERSION = 'prefs-2026-09-22';

const Body = z.object({ token: z.string().min(10), marketingOptIn: z.boolean(), country: z.enum(['US', 'NON_US']).nullable(), timezone: z.string().max(64).nullable() });

/** POST /api/preferences — explicit, token-scoped, unchecked-by-default opt-in. GET never mutates (A30). */
export async function POST(req: Request) {
  const e = env();
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(e.APP_URL).origin) return Response.json({ error: 'bad_origin' }, { status: 403 });
  const key = e.PREFERENCE_TOKEN_SIGNING_KEY ?? (e.isProductionLike ? '' : 'dev-only-preference-key-not-secret-0123456789');
  const raw = await req.text();
  if (raw.length > 4096) return Response.json({ error: 'too_large' }, { status: 413 });
  const parsed = Body.safeParse(JSON.parse(raw || '{}'));
  if (!parsed.success) return Response.json({ error: 'validation' }, { status: 422 });
  const v = verifyToken(parsed.data.token, key, 'preferences');
  if (!v.ok) return Response.json({ error: 'invalid_token' }, { status: 403 });
  const { db } = await getDb();
  const [contact] = await db.select().from(t.contacts).where(eq(t.contacts.id, v.payload.c));
  if (!contact) return Response.json({ ok: true }); // never reveal whether an address is a customer
  const evidence = { noticeVersion: NOTICE_VERSION, method: 'preference_form', tokenNonce: v.payload.n, at: new Date().toISOString(), userAgent: req.headers.get('user-agent') ?? null };
  if (parsed.data.marketingOptIn) {
    await db.insert(t.marketingPermissions).values({ contactId: contact.id, topic: 'ticket_offers', status: 'granted', noticeVersion: NOTICE_VERSION, method: 'preference_form', evidence, grantedAt: new Date() });
    await db.delete(t.suppressions).where(eq(t.suppressions.emailLookup, contact.emailLookup)).catch(() => undefined);
  } else {
    await revokeMarketing(db, { contactId: contact.id, emailLookup: contact.emailLookup, method: 'preference_form', evidence, noticeVersion: NOTICE_VERSION });
  }
  if (parsed.data.country) await db.update(t.contacts).set({ countryConfirmed: parsed.data.country }).where(eq(t.contacts.id, contact.id));
  await db.insert(t.contactPreferences).values({ contactId: contact.id, timezone: parsed.data.timezone, updateEvidence: evidence }).onConflictDoUpdate({ target: t.contactPreferences.contactId, set: { timezone: parsed.data.timezone, updateEvidence: evidence, updatedAt: new Date() } });
  await audit(db, { actor: 'customer', action: parsed.data.marketingOptIn ? 'marketing.opt_in' : 'marketing.opt_out', entityKind: 'contact', entityId: contact.id, diff: { noticeVersion: NOTICE_VERSION } });
  return Response.json({ ok: true });
}
