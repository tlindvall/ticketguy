import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { verifyToken, maskEmail } from '@/lib/security/tokens';
import { PreferencesForm } from '@/components/PreferencesForm';

export const dynamic = 'force-dynamic';

/** GET renders settings only; it never mutates (A30). Masked address; no conversation history. */
export default async function PreferencesPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const e = env();
  const key = e.PREFERENCE_TOKEN_SIGNING_KEY ?? (e.isProductionLike ? '' : 'dev-only-preference-key-not-secret-0123456789');
  const v = verifyToken(token, key, 'preferences');
  if (!v.ok) {
    return (
      <main className="tg-container">
        <h1 className="text-2xl font-bold">This link has expired</h1>
        <p className="mt-2 text-gray-700">Reply to any Ticket Guy email and we&apos;ll send a fresh preferences link.</p>
      </main>
    );
  }
  const { db } = await getDb();
  const [contact] = await db.select().from(t.contacts).where(eq(t.contacts.id, v.payload.c));
  if (!contact || contact.status === 'deleted') {
    return (
      <main className="tg-container">
        <h1 className="text-2xl font-bold">This link has expired</h1>
      </main>
    );
  }
  const [perm] = await db.select().from(t.marketingPermissions).where(and(eq(t.marketingPermissions.contactId, contact.id))).orderBy(desc(t.marketingPermissions.createdAt)).limit(1);
  const optIn = perm?.status === 'granted';
  return (
    <main className="tg-container">
      <h1 className="text-2xl font-bold">Your Ticket Guy preferences</h1>
      <p className="mt-1 text-sm text-gray-600">For {maskEmail(contact.emailOriginal)}</p>
      <PreferencesForm token={token} initialOptIn={optIn} initialCountry={(contact.countryConfirmed as 'US' | 'NON_US' | null) ?? null} />
      <p className="mt-8 text-xs text-gray-500">Saving does not affect any request you have open with us. To stop all emails including request replies, reply &ldquo;stop all emails&rdquo; to any message.</p>
    </main>
  );
}
