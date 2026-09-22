/** Runs one due-watch evaluation pass locally (what the Inngest cron does every 5 minutes). Fixture mode only needs no keys. */
import { openDatabase } from '../src/lib/db';
import { applyMigrations } from '../src/lib/db/migrate';
import { env } from '../src/lib/config/env';
import { Concierge } from '../src/lib/intake/pipeline';
import { FixtureExtractor } from '../src/lib/ai/extraction';
import { FixtureDrafter } from '../src/lib/ai/drafting';
import { FIXTURE_OFFERS } from '../src/lib/fixtures';

const h = await openDatabase();
await applyMigrations(h);
const e = env();
const c = new Concierge({ db: h.db, env: e, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), emailProvider: null, fixtureOffers: e.APP_MODE === 'fixture' ? FIXTURE_OFFERS : {} });
console.log('[watches]', JSON.stringify(await c.evaluateDueWatches(50)));
await h.close();
