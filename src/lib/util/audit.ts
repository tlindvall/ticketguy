import type { DbOrTx } from '@/lib/db';
import { auditLog } from '@/lib/db/schema';

const REDACT_KEYS = new Set(['bodyText', 'bodyHtml', 'sanitizedText', 'email', 'emailOriginal', 'emailLookup', 'recipient', 'bytes', 'password', 'secret']);

export function redact(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, REDACT_KEYS.has(k) ? '[redacted]' : redact(v)]));
  }
  return obj;
}

export async function audit(db: DbOrTx, entry: { actor: string; action: string; entityKind: string; entityId: string; revision?: number | null; diff?: Record<string, unknown> | null; traceId?: string | null }): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entityKind: entry.entityKind,
    entityId: entry.entityId,
    revision: entry.revision ?? null,
    diff: entry.diff ? (redact(entry.diff) as Record<string, unknown>) : null,
    traceId: entry.traceId ?? null,
  });
}
