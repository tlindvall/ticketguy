/**
 * Local inbound simulator (fixture mode). Feeds the application-normalized inbound contract and drains the
 * outbox in-process. It does NOT exercise provider signature verification — that is proven separately in
 * staging against real Resend webhooks.
 *
 *   pnpm simulate:inbound --from alice@customer.example --subject "Rangers" --text "Five of us ..." [--reply-to "<msg-id>"]
 *   pnpm simulate:inbound --file tests/fixtures/emails/rangers-five.txt
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { applyMigrations } from '../src/lib/db/migrate';
import { env } from '../src/lib/config/env';
import { Concierge } from '../src/lib/intake/pipeline';
import { FixtureExtractor } from '../src/lib/ai/extraction';
import { FixtureDrafter } from '../src/lib/ai/drafting';
import { FIXTURE_OFFERS } from '../src/lib/fixtures';
import { leaseDueOutbox, markDispatched, markFailed } from '../src/lib/intake/outbox';
import { eq } from 'drizzle-orm';
import * as t from '../src/lib/db/schema';

const { values } = parseArgs({ options: { from: { type: 'string', default: 'alice@customer.example' }, subject: { type: 'string', default: 'Tickets' }, text: { type: 'string' }, file: { type: 'string' }, 'reply-to': { type: 'string' } } });
const e = env();
if (e.APP_MODE !== 'fixture') {
  console.error('simulator only runs in APP_MODE=fixture');
  process.exit(2);
}
const text = values.file ? readFileSync(values.file, 'utf8') : values.text;
if (!text) {
  console.error('provide --text or --file');
  process.exit(2);
}
const h = await openDatabase();
await applyMigrations(h);
const c = new Concierge({ db: h.db, env: e, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), emailProvider: null, fixtureOffers: FIXTURE_OFFERS });
const id = `sim-${Date.now()}`;
const outcome = await c.ingestInbound({ provider: 'simulator', providerEmailId: id, rfcMessageId: `<${id}@simulator.local>`, inReplyTo: values['reply-to'] ?? null, references: values['reply-to'] ?? null, from: values.from!, to: [e.CONCIERGE_INBOUND_ADDRESS], subject: values.subject ?? null, text, headers: {}, receivedAt: new Date(), attachments: [], authentication: { spf: null, dkim: null, dmarc: null }, signatureVerified: false });
console.log('[simulate] ingest:', JSON.stringify(outcome));
for (let i = 0; i < 8; i++) {
  const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date() });
  if (!leased.length) break;
  for (const ev of leased) {
    try {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') console.log('[simulate] interpret →', JSON.stringify(await c.interpret({ messageId: p.messageId!, requestId: p.requestId! })).slice(0, 300));
      else if (ev.eventType === 'research.requested') console.log('[simulate] research →', JSON.stringify(await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) })));
      else if (ev.eventType === 'email.send_requested') console.log('[simulate] dispatch →', JSON.stringify(await c.dispatchSend(p.sendIntentId!)));
      await markDispatched(h.db, ev.id, ev.leaseToken, new Date());
    } catch (err) {
      console.error('[simulate] handler failed:', err);
      await markFailed(h.db, ev, String(err), new Date());
    }
  }
}
if (outcome.kind === 'queued') {
  const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, outcome.requestId));
  const recs = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, outcome.requestId));
  const intents = await h.db.select({ cls: t.sendIntents.messageClass, state: t.sendIntents.state, err: t.sendIntents.lastError }).from(t.sendIntents).where(eq(t.sendIntents.requestId, outcome.requestId));
  console.log(`\n[simulate] request ${req!.id} state=${req!.state} rev=${req!.currentRevision} thread=<${id}@simulator.local>`);
  for (const r of recs) console.log(`\n--- draft (${r.reviewStatus}) ${r.subject}\n${r.bodyText}\n`);
  for (const i of intents) console.log(`[simulate] send intent ${i.cls}: ${i.state}${i.err ? ` (${i.err})` : ''}`);
  console.log(`\nReview it at ${e.APP_URL}/admin/requests/${req!.id}`);
}
await h.close();
