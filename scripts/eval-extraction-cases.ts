/**
 * Runs the regression set's `brief` expectations through the configured model — the extractor production
 * uses — and prints what it got right and wrong (`pnpm tsx scripts/eval-extraction-cases.ts --yes`).
 *
 * The same cases run free on every `pnpm test` against the rules extractor; this is the check that the model
 * reads them the same way, to run after a prompt, lexicon or model change. It makes one real call per case
 * (about fifty) and costs real money, hence `--yes`. `--only=<id prefix>` narrows it. It prints case ids and
 * field names with expected/received values — never message bodies beyond the case text, never keys.
 *
 * Strings are compared loosely (case-insensitive, either containing the other), because the model may return
 * "Rangers" where the rules extractor canonicalises to "New York Rangers"; numbers, booleans and null are exact.
 */
import { openDatabase } from '../src/lib/db';
import { env } from '../src/lib/config/env';
import { selectModelClient } from '../src/lib/services';
import { ModelExtractor, ModelOutputError } from '../src/lib/ai/model-client';
import * as t from '../src/lib/db/schema';
import { FIXTURE_NOW } from '../src/lib/fixtures';
import { REGRESSION_CASES } from '../tests/regression/cases';

if (!process.argv.includes('--yes')) {
  console.error('[eval] this makes one model call per case and costs money. Re-run with --yes.');
  process.exit(1);
}
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const h = await openDatabase();
const selected = selectModelClient(env());
if (!selected) {
  console.error('[eval] no model client configured (EXTRACTION_PROVIDER); nothing to evaluate.');
  await h.close();
  process.exit(1);
}
const entities = await h.db.select({ name: t.entities.name, aliases: t.entities.aliases, kind: t.entities.kind, league: t.entities.league }).from(t.entities);
const known = entities.map((x) => ({ name: x.name, aliases: x.aliases, kind: (x.kind === 'team' ? 'team' : 'artist') as 'team' | 'artist', category: x.league?.toLowerCase() ?? 'concert' }));
const extractor = new ModelExtractor(selected.client, selected.model, selected.effort);
console.log(`[eval] provider=${selected.client.provider} model=${selected.model} entities=${known.length}`);

const same = (want: unknown, got: unknown): boolean => {
  if (typeof want === 'string' && typeof got === 'string') {
    const a = want.toLowerCase();
    const b = got.toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  }
  if (Array.isArray(want)) return Array.isArray(got) && want.every((w) => got.includes(w));
  return want === got;
};

let pass = 0;
let fail = 0;
const cases = REGRESSION_CASES.filter((c) => c.brief && (!only || c.id.startsWith(only)));
for (const c of cases) {
  try {
    const out = (await extractor.extract({ messageId: `eval-${c.id}`, text: c.text, subject: null, receivedAt: FIXTURE_NOW, venueTimeZone: 'America/New_York', knownEntities: known })) as unknown as Record<string, unknown>;
    const misses = Object.entries(c.brief!).filter(([k, v]) => !same(v, out[k]));
    if (misses.length) {
      fail += 1;
      console.log(`FAIL ${c.id}: ${misses.map(([k, v]) => `${k} expected ${JSON.stringify(v)} got ${JSON.stringify(out[k])}`).join('; ')}`);
    } else {
      pass += 1;
      console.log(`ok   ${c.id}`);
    }
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${c.id}: ${e instanceof ModelOutputError ? `model ${e.kind}: ${e.message}` : String(e)}`);
  }
}
console.log(`[eval] ${pass} passed, ${fail} failed of ${cases.length}`);
await h.close();
process.exit(fail ? 2 : 0);
