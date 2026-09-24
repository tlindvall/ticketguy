/**
 * Runs the configured extractor against a stored message and prints what the model actually did
 * (`pnpm tsx scripts/diagnose-extraction.ts [messageId]`, newest message when no id is given).
 *
 * This exists because a failed extraction only ever reached the database as a state transition; the
 * provider's own answer was never written down. It makes one real model call and costs real money, so it
 * is a deliberate command, never part of a page render. It prints the extracted fields and the failure
 * kind — never the API key, and never more of the customer's message than the short preview below.
 */
import { desc, eq } from 'drizzle-orm';
import { openDatabase } from '../src/lib/db';
import { env } from '../src/lib/config/env';
import { selectModelClient } from '../src/lib/services';
import { ModelExtractor } from '../src/lib/ai/model-client';
import { ModelOutputError } from '../src/lib/ai/model-client';
import * as t from '../src/lib/db/schema';

const h = await openDatabase();
const e = env();
const selected = selectModelClient(e);
if (!selected) {
  console.error(`[diagnose-extraction] no model client for EXTRACTION_PROVIDER=${e.EXTRACTION_PROVIDER}; nothing to test.`);
  await h.close();
  process.exit(1);
}
console.log(`[diagnose-extraction] provider=${selected.client.provider} model=${selected.model} effort=${selected.effort}`);

const id = process.argv[2];
const rows = id
  ? await h.db.select().from(t.messages).where(eq(t.messages.id, id))
  : await h.db.select().from(t.messages).orderBy(desc(t.messages.receivedAt)).limit(1);
const msg = rows[0];
if (!msg) {
  console.error('[diagnose-extraction] no message found.');
  await h.close();
  process.exit(1);
}
const text = msg.sanitizedText ?? '';
console.log(`[diagnose-extraction] message ${msg.id.slice(0, 8)} · subject=${JSON.stringify(msg.subject)} · ${text.length} chars`);
console.log(`[diagnose-extraction] first 120 chars: ${JSON.stringify(text.slice(0, 120))}`);

const entities = await h.db.select({ name: t.entities.name, aliases: t.entities.aliases, kind: t.entities.kind, league: t.entities.league }).from(t.entities);
const known = entities.map((x) => ({ name: x.name, aliases: x.aliases, kind: (x.kind === 'team' ? 'team' : 'artist') as 'team' | 'artist', category: x.league?.toLowerCase() ?? 'concert' }));
console.log(`[diagnose-extraction] known entities in database: ${known.length}`);

const extractor = new ModelExtractor(selected.client, selected.model, selected.effort);
try {
  const out = await extractor.extract({ messageId: msg.id, text, subject: msg.subject, receivedAt: msg.receivedAt, venueTimeZone: null, knownEntities: known });
  console.log('[diagnose-extraction] SUCCESS');
  console.log(JSON.stringify({ intent: out.intent, performerOrTeam: out.performerOrTeam, city: out.city, dateExpression: out.dateExpression, resolvedLocalDate: out.resolvedLocalDate, quantity: out.quantity, budgetCents: out.budgetCents, budgetBasis: out.budgetBasis, togetherRequired: out.togetherRequired, ambiguities: out.ambiguities }, null, 2));
  console.log(`[diagnose-extraction] usage: ${JSON.stringify(extractor.lastUsage)}`);
} catch (err) {
  if (err instanceof ModelOutputError) {
    console.error(`[diagnose-extraction] FAILED kind=${err.kind}`);
    console.error(`[diagnose-extraction] message: ${err.message}`);
  } else {
    console.error('[diagnose-extraction] FAILED with an unexpected error:', err);
  }
}
await h.close();
