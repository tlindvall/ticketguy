import { z } from 'zod';
import { env } from '@/lib/config/env';
import { adminRoute } from '@/lib/admin/api';
import { getConcierge } from '@/lib/services';
import { runOutboxBatch } from '@/inngest/functions';

export const dynamic = 'force-dynamic';
const Body = z.object({ from: z.string().email(), subject: z.string().max(200).nullable(), text: z.string().min(1).max(20000), inReplyTo: z.string().nullable().default(null), drain: z.boolean().default(true) });

/** Development-only simulator of the normalized inbound contract. Never claims provider signature verification. */
export async function POST(req: Request) {
  return adminRoute(req, { body: Body }, async ({ body }) => {
    const e = env();
    // Development only, at any APP_MODE: the model extractor is unreachable in fixture mode, so gating this
    // on fixture mode left the provider that actually ships with no way to be exercised at all.
    if (e.isProductionLike) return Response.json({ error: 'simulator_disabled_in_production' }, { status: 403 });
    const c = await getConcierge();
    const id = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outcome = await c.ingestInbound({ provider: 'simulator', providerEmailId: id, rfcMessageId: `<${id}@simulator.local>`, inReplyTo: body.inReplyTo, references: body.inReplyTo, from: body.from, to: [e.CONCIERGE_INBOUND_ADDRESS], subject: body.subject, text: body.text, headers: {}, receivedAt: new Date(), attachments: [], authentication: { spf: null, dkim: null, dmarc: null }, signatureVerified: false });
    const drained = { processed: 0, failed: 0 };
    if (body.drain) {
      for (let i = 0; i < 6; i++) {
        const r = await runOutboxBatch(50);
        drained.processed += r.processed;
        drained.failed += r.failed;
        if (r.processed + r.failed === 0) break;
      }
    }
    return Response.json({ outcome, drained, rfcMessageId: `<${id}@simulator.local>` });
  });
}
