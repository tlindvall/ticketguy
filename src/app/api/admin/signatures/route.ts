import { z } from 'zod';
import { getDb } from '@/lib/db';
import { adminRoute } from '@/lib/admin/api';
import { audit } from '@/lib/util/audit';
import { MAX_SIGNATURE_LENGTH } from '@/lib/email/custom-templates';
import { TemplateValidationError, deleteSignature, saveSignature } from '@/lib/email/template-store';

export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), id: z.string().uuid().nullable().default(null), name: z.string().min(1).max(80), body: z.string().min(1).max(MAX_SIGNATURE_LENGTH), isDefault: z.boolean().default(false) }),
  z.object({ action: z.literal('delete'), id: z.string().uuid() }),
]);

/** Signatures are appended above the compliance footer; the footer itself is never editable. */
export async function POST(req: Request) {
  return adminRoute(req, { role: 'admin', body: Body }, async ({ staff, body }) => {
    const { db } = await getDb();
    try {
      if (body.action === 'save') {
        const r = await saveSignature(db, { id: body.id, name: body.name, body: body.body, isDefault: body.isDefault, staffUserId: staff.userId });
        await audit(db, { actor: staff.userId, action: 'email_signature.saved', entityKind: 'email_signature', entityId: r.id, diff: { name: body.name, isDefault: body.isDefault } });
        return Response.json({ ok: true, ...r });
      }
      const r = await deleteSignature(db, body.id);
      if (!r.deleted) return Response.json({ error: r.reason ?? 'not_found' }, { status: 409 });
      await audit(db, { actor: staff.userId, action: 'email_signature.deleted', entityKind: 'email_signature', entityId: body.id, diff: {} });
      return Response.json({ ok: true });
    } catch (e) {
      if (e instanceof TemplateValidationError) return Response.json({ error: 'validation', issues: e.errors }, { status: 422 });
      throw e;
    }
  });
}
