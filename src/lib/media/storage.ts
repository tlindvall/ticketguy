import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import { mediaObjects } from '@/lib/db/schema';

/**
 * Database-backed private media (ENGINEERING_SPEC §2). put/get/delete behind an interface; list queries never
 * select the binary column; a configurable total budget alerts at 80% and refuses new blobs at the cap (A45).
 */
export interface MediaStore {
  put(args: { ownerKind: 'message' | 'attachment' | 'raw_mime'; ownerId: string; mimeType: string; bytes: Uint8Array; expiresAt: Date | null }): Promise<{ ok: true; id: string; sha256: string; warning: 'near_budget' | null } | { ok: false; reason: 'budget_exhausted' }>;
  get(id: string): Promise<{ id: string; mimeType: string; bytes: Uint8Array; byteLength: number; ownerKind: string; ownerId: string } | null>;
  delete(id: string): Promise<void>;
  usage(): Promise<{ totalBytes: number; budgetBytes: number; ratio: number }>;
}

export class DbMediaStore implements MediaStore {
  constructor(private readonly db: DbOrTx, private readonly budgetBytes: number) {}
  async usage() {
    const [r] = await this.db.select({ total: sql<number>`coalesce(sum(byte_length),0)::bigint` }).from(mediaObjects);
    const totalBytes = Number(r?.total ?? 0);
    return { totalBytes, budgetBytes: this.budgetBytes, ratio: this.budgetBytes ? totalBytes / this.budgetBytes : 0 };
  }
  async put(args: { ownerKind: 'message' | 'attachment' | 'raw_mime'; ownerId: string; mimeType: string; bytes: Uint8Array; expiresAt: Date | null }) {
    const u = await this.usage();
    if (u.totalBytes + args.bytes.byteLength > this.budgetBytes) return { ok: false as const, reason: 'budget_exhausted' as const };
    const sha256 = createHash('sha256').update(args.bytes).digest('hex');
    const [row] = await this.db.insert(mediaObjects).values({ ownerKind: args.ownerKind, ownerId: args.ownerId, mimeType: args.mimeType, byteLength: args.bytes.byteLength, sha256, bytes: args.bytes, expiresAt: args.expiresAt }).returning({ id: mediaObjects.id });
    const warning = (u.totalBytes + args.bytes.byteLength) / this.budgetBytes >= 0.8 ? ('near_budget' as const) : null;
    return { ok: true as const, id: row!.id, sha256, warning };
  }
  async get(id: string) {
    const [row] = await this.db.select().from(mediaObjects).where(eq(mediaObjects.id, id));
    if (!row) return null;
    return { id: row.id, mimeType: row.mimeType, bytes: row.bytes, byteLength: row.byteLength, ownerKind: row.ownerKind, ownerId: row.ownerId };
  }
  async delete(id: string) {
    await this.db.delete(mediaObjects).where(eq(mediaObjects.id, id));
  }
}

export function createMediaStore(db: DbOrTx, provider: 'db' | 's3', budgetBytes: number): MediaStore {
  if (provider !== 'db') throw new Error(`media provider ${provider} is not implemented`);
  return new DbMediaStore(db, budgetBytes);
}
