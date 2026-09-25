/**
 * Runs the catalog pre-warm now (`pnpm tsx scripts/catalog-prewarm.ts`) instead of waiting for the daily
 * schedule. Same enablement rule as the scheduled run: it does nothing unless the Discovery key is set AND
 * the ticketmaster adapter row is enabled with approval evidence. Prints one line per keyword.
 */
import { openDatabase } from '../src/lib/db';
import { env } from '../src/lib/config/env';
import { prewarmCatalog } from '../src/lib/catalog/prewarm';

const h = await openDatabase();
const r = await prewarmCatalog(h.db, env());
if (!r.ran) console.log(`[prewarm] did not run: ${r.reason}`);
for (const x of r.results) console.log(`[prewarm] ${x.keyword.padEnd(24)} ${x.status.padEnd(16)} seen=${x.eventsSeen} upserted=${x.eventsUpserted}`);
await h.close();
