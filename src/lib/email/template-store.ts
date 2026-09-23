import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import { emailSignatures, emailTemplates } from '@/lib/db/schema';
import { isSlotName, validateTemplateBody, type SlotName, type TemplateOverrides } from './custom-templates';

/**
 * Persistence for staff-authored copy. Activated versions are immutable: editing produces a new version
 * and the previous one is archived, so a send's content hash (and therefore an approval) always refers to
 * copy that still exists. Reverting a slot archives its active row; the built-in template takes over again.
 */

export class TemplateValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(' '));
    this.name = 'TemplateValidationError';
  }
}

export type TemplateRow = typeof emailTemplates.$inferSelect;
export type SignatureRow = typeof emailSignatures.$inferSelect;

/** The active override per slot, resolved with its signature. Empty result means every slot uses the built-in. */
export async function loadActiveTemplates(db: DbOrTx): Promise<TemplateOverrides> {
  const rows = await db
    .select({ slot: emailTemplates.slot, subject: emailTemplates.subject, body: emailTemplates.bodyText, version: emailTemplates.version, signature: emailSignatures.bodyText })
    .from(emailTemplates)
    .leftJoin(emailSignatures, eq(emailTemplates.signatureId, emailSignatures.id))
    .where(eq(emailTemplates.state, 'active'));
  const out: TemplateOverrides = {};
  for (const r of rows) {
    if (!isSlotName(r.slot)) continue; // a slot removed from the catalog falls back to the built-in
    out[r.slot] = { slot: r.slot, subject: r.subject, body: r.body, signature: r.signature ?? null, version: r.version };
  }
  return out;
}

export async function listTemplates(db: DbOrTx): Promise<TemplateRow[]> {
  return db.select().from(emailTemplates).orderBy(asc(emailTemplates.slot), desc(emailTemplates.version));
}

export async function listSignatures(db: DbOrTx): Promise<SignatureRow[]> {
  return db.select().from(emailSignatures).orderBy(desc(emailSignatures.isDefault), asc(emailSignatures.name));
}

/**
 * Writes a new version of a slot. `activate` publishes it in the same transaction, archiving whatever was
 * live, so a slot is never briefly without copy and never has two active rows.
 */
export async function saveTemplateVersion(
  db: DbOrTx,
  args: { slot: SlotName; subject: string | null; body: string; signatureId: string | null; note: string | null; staffUserId: string; activate: boolean; now?: Date },
): Promise<{ id: string; version: number; active: boolean }> {
  const signature = args.signatureId
    ? (await db.select({ b: emailSignatures.bodyText }).from(emailSignatures).where(eq(emailSignatures.id, args.signatureId)))[0]?.b ?? null
    : null;
  if (args.signatureId && signature === null) throw new TemplateValidationError(['Signature: not found.']);
  const v = validateTemplateBody({ slot: args.slot, subject: args.subject, body: args.body, signature });
  if (!v.ok) throw new TemplateValidationError(v.errors);

  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    const [max] = await tx.select({ v: sql<number>`coalesce(max(${emailTemplates.version}), 0)::int` }).from(emailTemplates).where(eq(emailTemplates.slot, args.slot));
    const version = (max?.v ?? 0) + 1;
    if (args.activate) {
      await tx.update(emailTemplates).set({ state: 'archived' }).where(and(eq(emailTemplates.slot, args.slot), eq(emailTemplates.state, 'active')));
    }
    const [row] = await tx
      .insert(emailTemplates)
      .values({
        slot: args.slot,
        version,
        subject: args.subject,
        bodyText: args.body,
        signatureId: args.signatureId,
        note: args.note,
        state: args.activate ? 'active' : 'draft',
        createdBy: args.staffUserId,
        createdAt: now,
        activatedBy: args.activate ? args.staffUserId : null,
        activatedAt: args.activate ? now : null,
      })
      .returning({ id: emailTemplates.id });
    return { id: row!.id, version, active: args.activate };
  });
}

/** Publishes an existing draft. Re-validates, because the catalog may have changed since it was written. */
export async function activateTemplate(db: DbOrTx, id: string, staffUserId: string, now = new Date()): Promise<{ slot: string; version: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(emailTemplates).where(eq(emailTemplates.id, id));
    if (!row) throw new TemplateValidationError(['Template: not found.']);
    if (row.state === 'active') return { slot: row.slot, version: row.version };
    if (!isSlotName(row.slot)) throw new TemplateValidationError([`Template: slot ${row.slot} is no longer available.`]);
    const signature = row.signatureId ? (await tx.select({ b: emailSignatures.bodyText }).from(emailSignatures).where(eq(emailSignatures.id, row.signatureId)))[0]?.b ?? null : null;
    const v = validateTemplateBody({ slot: row.slot, subject: row.subject, body: row.bodyText, signature });
    if (!v.ok) throw new TemplateValidationError(v.errors);
    await tx.update(emailTemplates).set({ state: 'archived' }).where(and(eq(emailTemplates.slot, row.slot), eq(emailTemplates.state, 'active')));
    await tx.update(emailTemplates).set({ state: 'active', activatedBy: staffUserId, activatedAt: now }).where(eq(emailTemplates.id, id));
    return { slot: row.slot, version: row.version };
  });
}

/** Archives the active version of a slot; the built-in template takes over on the next send. */
export async function revertSlotToBuiltIn(db: DbOrTx, slot: SlotName): Promise<boolean> {
  const rows = await db.update(emailTemplates).set({ state: 'archived' }).where(and(eq(emailTemplates.slot, slot), eq(emailTemplates.state, 'active'))).returning({ id: emailTemplates.id });
  return rows.length > 0;
}

export async function deleteDraft(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db.delete(emailTemplates).where(and(eq(emailTemplates.id, id), eq(emailTemplates.state, 'draft'))).returning({ id: emailTemplates.id });
  return rows.length > 0;
}

export async function saveSignature(db: DbOrTx, args: { id?: string | null; name: string; body: string; isDefault: boolean; staffUserId: string; now?: Date }): Promise<{ id: string }> {
  const v = validateTemplateBody({ slot: 'acknowledgment', body: 'placeholder', signature: args.body });
  if (!v.ok) throw new TemplateValidationError(v.errors.filter((e) => e.startsWith('Signature')));
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    if (args.isDefault) await tx.update(emailSignatures).set({ isDefault: false }).where(eq(emailSignatures.isDefault, true));
    if (args.id) {
      const rows = await tx.update(emailSignatures).set({ name: args.name, bodyText: args.body, isDefault: args.isDefault, updatedBy: args.staffUserId, updatedAt: now }).where(eq(emailSignatures.id, args.id)).returning({ id: emailSignatures.id });
      if (!rows.length) throw new TemplateValidationError(['Signature: not found.']);
      return { id: rows[0]!.id };
    }
    const rows = await tx.insert(emailSignatures).values({ name: args.name, bodyText: args.body, isDefault: args.isDefault, updatedBy: args.staffUserId, createdAt: now, updatedAt: now }).returning({ id: emailSignatures.id });
    return { id: rows[0]!.id };
  });
}

/** A signature in use by any version stays, so archived copy keeps rendering the way it was approved. */
export async function deleteSignature(db: DbOrTx, id: string): Promise<{ deleted: boolean; reason?: string }> {
  const [used] = await db.select({ n: sql<number>`count(*)::int` }).from(emailTemplates).where(eq(emailTemplates.signatureId, id));
  if ((used?.n ?? 0) > 0) return { deleted: false, reason: 'signature_in_use' };
  const rows = await db.delete(emailSignatures).where(eq(emailSignatures.id, id)).returning({ id: emailSignatures.id });
  return { deleted: rows.length > 0 };
}
