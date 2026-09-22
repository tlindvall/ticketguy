import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { verifyToken } from '@/lib/security/tokens';
import { revokeMarketing } from '@/lib/domain/suppression';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';

/** RFC 8058 one-click: POST with List-Unsubscribe=One-Click body; idempotent; no login; no other data access. */
export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const e = env();
  const key = e.PREFERENCE_TOKEN_SIGNING_KEY ?? (e.isProductionLike ? '' : 'dev-only-preference-key-not-secret-0123456789');
  const v = verifyToken(token, key, 'unsubscribe');
  if (!v.ok) return new Response(null, { status: 200 }); // never reveal token validity to scanners
  const { db } = await getDb();
  const [contact] = await db.select().from(t.contacts).where(eq(t.contacts.id, v.payload.c));
  if (contact) {
    await revokeMarketing(db, { contactId: contact.id, emailLookup: contact.emailLookup, method: 'one_click', evidence: { tokenNonce: v.payload.n, at: new Date().toISOString() }, noticeVersion: 'rfc8058' });
    await audit(db, { actor: 'customer', action: 'marketing.one_click_unsubscribe', entityKind: 'contact', entityId: contact.id });
  }
  return new Response(null, { status: 200 });
}

export async function GET() {
  // GET must never mutate (A30); the page at /unsubscribe/[token] shows a confirm button.
  return new Response(null, { status: 405 });
}
