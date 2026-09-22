import { z } from 'zod';
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';
import { audit } from '@/lib/util/audit';
import { addSuppression } from '@/lib/domain/suppression';

export const dynamic = 'force-dynamic';
const Body = z.object({ verifiedBy: z.enum(['customer_reply_confirm', 'staff_identity_check']), note: z.string().min(3).max(2000) });

/**
 * POST — verified deletion (A36/A37): stops watches, suppresses, deletes/redacts personal content and media,
 * blocks queued sends, keeps a minimal keyed suppression + deletion ledger entry so a restore can re-apply it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { role: 'admin', body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const { db } = await getDb();
    const [contact] = await db.select().from(t.contacts).where(eq(t.contacts.id, id));
    if (!contact) return Response.json({ error: 'not_found' }, { status: 404 });
    const now = new Date();
    await db.transaction(async (tx) => {
      const convs = await tx.select({ id: t.conversations.id }).from(t.conversations).where(eq(t.conversations.contactId, id));
      const convIds = convs.map((c) => c.id);
      if (convIds.length) {
        const msgs = await tx.select({ id: t.messages.id }).from(t.messages).where(inArray(t.messages.conversationId, convIds));
        const msgIds = msgs.map((m) => m.id);
        if (msgIds.length) {
          await tx.delete(t.mediaObjects).where(and(inArray(t.mediaObjects.ownerId, msgIds)));
          await tx.update(t.attachments).set({ mediaId: null, validationState: 'purged', filename: null }).where(inArray(t.attachments.messageId, msgIds));
          await tx.update(t.messages).set({ sanitizedText: '[deleted]', subject: null, rawMediaId: null, fromAddress: '[deleted]', toAddresses: [] }).where(inArray(t.messages.id, msgIds));
        }
        await tx.update(t.sendIntents).set({ state: 'blocked', lastError: 'contact_deleted', bodyText: '[deleted]', bodyHtml: '[deleted]' }).where(and(inArray(t.sendIntents.conversationId, convIds), inArray(t.sendIntents.state, ['queued', 'uncertain'])));
      }
      await tx.update(t.watches).set({ state: 'cancelled' }).where(eq(t.watches.contactId, id));
      await tx.delete(t.interestObservations).where(eq(t.interestObservations.contactId, id));
      await tx.delete(t.contactInterests).where(eq(t.contactInterests.contactId, id));
      await tx.update(t.requestVersions).set({ brief: { deleted: true } }).where(inArray(t.requestVersions.requestId, tx.select({ id: t.requests.id }).from(t.requests).where(eq(t.requests.contactId, id))));
      await addSuppression(tx, { emailLookup: contact.emailLookup, scope: 'global', reason: 'deletion' });
      await tx.update(t.contacts).set({ status: 'deleted', deletedAt: now, emailOriginal: '[deleted]' }).where(eq(t.contacts.id, id));
      await tx.insert(t.deletionLedger).values({ emailLookupHash: createHash('sha256').update(contact.emailLookup).digest('hex'), contactId: id, requestedAt: now, verifiedAt: now, completedAt: now, actor: staff.userId, scope: ['messages', 'attachments', 'media', 'requests', 'interests', 'watches', 'send_intents'] });
      await audit(tx, { actor: staff.userId, action: 'contact.deleted', entityKind: 'contact', entityId: id, diff: { verifiedBy: body.verifiedBy } });
    });
    return Response.json({ ok: true, note: 'Personal content deleted/redacted; keyed suppression retained; provider and backup copies expire per retention policy (see RUNBOOK).' });
  });
}
