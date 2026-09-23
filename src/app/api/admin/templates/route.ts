import { z } from 'zod';
import { getDb } from '@/lib/db';
import { adminRoute } from '@/lib/admin/api';
import { audit } from '@/lib/util/audit';
import { isSlotName, renderAuthored, renderSubject, sampleVars, validateTemplateBody, MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH, type SlotName } from '@/lib/email/custom-templates';
import { TemplateValidationError, activateTemplate, deleteDraft, revertSlotToBuiltIn, saveTemplateVersion } from '@/lib/email/template-store';

export const dynamic = 'force-dynamic';

const Slot = z.string().refine(isSlotName, 'unknown template slot').transform((v) => v as SlotName);

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    slot: Slot,
    subject: z.string().max(MAX_SUBJECT_LENGTH).nullable().default(null),
    body: z.string().min(1).max(MAX_BODY_LENGTH),
    signatureId: z.string().uuid().nullable().default(null),
    note: z.string().max(500).nullable().default(null),
    activate: z.boolean().default(false),
  }),
  z.object({ action: z.literal('preview'), slot: Slot, subject: z.string().max(MAX_SUBJECT_LENGTH).nullable().default(null), body: z.string().max(MAX_BODY_LENGTH), signature: z.string().max(4000).nullable().default(null) }),
  z.object({ action: z.literal('activate'), id: z.string().uuid() }),
  z.object({ action: z.literal('delete_draft'), id: z.string().uuid() }),
  z.object({ action: z.literal('revert'), slot: Slot }),
]);

/**
 * Template authoring. Writing copy is admin-only: it changes what customers receive without a further
 * review step. Preview renders against sample data and never touches a real contact or send.
 */
export async function POST(req: Request) {
  return adminRoute(req, { role: 'admin', body: Body, maxBytes: 64 * 1024 }, async ({ staff, body }) => {
    const { db } = await getDb();
    try {
      if (body.action === 'preview') {
        const v = validateTemplateBody({ slot: body.slot, subject: body.subject, body: body.body, signature: body.signature });
        if (!v.ok) return Response.json({ error: 'validation', issues: v.errors }, { status: 422 });
        const vars = sampleVars(body.slot);
        const rendered = renderAuthored(body.body, vars);
        const sig = body.signature ? renderAuthored(body.signature, {}) : null;
        return Response.json({ ok: true, sample: true, subject: body.subject ? renderSubject(body.subject, vars) : null, text: rendered.text, html: rendered.html, signatureText: sig?.text ?? null });
      }
      if (body.action === 'save') {
        const r = await saveTemplateVersion(db, { slot: body.slot, subject: body.subject, body: body.body, signatureId: body.signatureId, note: body.note, staffUserId: staff.userId, activate: body.activate });
        await audit(db, { actor: staff.userId, action: body.activate ? 'email_template.activated' : 'email_template.drafted', entityKind: 'email_template', entityId: r.id, diff: { slot: body.slot, version: r.version } });
        return Response.json({ ok: true, ...r });
      }
      if (body.action === 'activate') {
        const r = await activateTemplate(db, body.id, staff.userId);
        await audit(db, { actor: staff.userId, action: 'email_template.activated', entityKind: 'email_template', entityId: body.id, diff: r });
        return Response.json({ ok: true, ...r });
      }
      if (body.action === 'delete_draft') {
        const deleted = await deleteDraft(db, body.id);
        if (!deleted) return Response.json({ error: 'not_a_draft' }, { status: 409 });
        await audit(db, { actor: staff.userId, action: 'email_template.draft_deleted', entityKind: 'email_template', entityId: body.id, diff: {} });
        return Response.json({ ok: true });
      }
      const reverted = await revertSlotToBuiltIn(db, body.slot);
      if (!reverted) return Response.json({ error: 'no_active_template' }, { status: 409 });
      await audit(db, { actor: staff.userId, action: 'email_template.reverted', entityKind: 'email_template', entityId: body.slot, diff: { slot: body.slot } });
      return Response.json({ ok: true });
    } catch (e) {
      if (e instanceof TemplateValidationError) return Response.json({ error: 'validation', issues: e.errors }, { status: 422 });
      throw e;
    }
  });
}
