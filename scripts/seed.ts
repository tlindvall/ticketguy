import { openDatabase } from '../src/lib/db';
import { applyMigrations } from '../src/lib/db/migrate';
import { seedRegistry, seedFixtures } from '../src/lib/db/seed';
import { env } from '../src/lib/config/env';

const h = await openDatabase();
await applyMigrations(h);
const n = await seedRegistry(h.db);
console.log(`[seed] registry: ${n} sources imported as not_integrated (driver=${h.driver})`);
if (env().APP_MODE === 'fixture') {
  await seedFixtures(h.db);
  console.log('[seed] fixture world seeded (synthetic venues/events/offers/history) — FIXTURE DATA ONLY');
} else {
  console.log('[seed] APP_MODE=live: fixtures skipped');
}
await h.close();
