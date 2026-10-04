/**
 * Runs the production screenshot reader on the original launch-review images (and later live screenshots), with each case's own question,
 * and prints what it read, the checks the replies depend on, and the screenshot answer those facts produce
 * (`pnpm tsx scripts/read-launch-images.ts`). The acceptance replays in tests/acceptance/launch-evidence-1002.test.ts
 * stand in for this reader; this is the operator gate that shows the real model reads the same facts.
 *
 * It makes four real model calls and costs real money, so it is a deliberate command. It reads only the committed
 * fixture images (tests/fixtures/launch-images), opens no database and sends nothing. It never prints the API key.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../src/lib/config/env';
import { selectModelClient } from '../src/lib/services';
import { ModelListingReader } from '../src/lib/ai/model-client';
import { fieldsFromRead, usableEvidence, type ListingRead } from '../src/lib/ai/listing-evidence';
import { answerFromEvidence } from '../src/lib/advice/evidence-answer';

type Case = { id: string; image: string; question: string; checks: Array<[string, (r: ListingRead) => boolean]> };
const cents = (r: ListingRead) => (r.offers ?? []).map((o) => (o.priceDollars == null ? null : Math.round(o.priceDollars * 100)));
const CASES: Case[] = [
  {
    id: 'B01-1', image: 'jigitz-morning.jpg', question: "We don't need the floor — what's the cheapest option for two in this screenshot?",
    checks: [
      ['three rows, each priced: $100.17, $104, $107.33', (r) => ['10017', '10400', '10733'].every((c) => cents(r).map(String).includes(c))],
      ['fees in, before tax', (r) => r.feeBasis === 'all_in' && r.beforeTaxes === true],
      ['floor Tier 2 is resale', (r) => (r.offers ?? []).some((o) => /tier 2/i.test(o.label) && o.listingType === 'resale')],
    ],
  },
  {
    id: 'S01-1', image: 'jigitz-afternoon.jpg', question: 'I grabbed this screenshot earlier. Is 8pm the actual show or the doors? And are the floor tickets seats or standing?',
    checks: [
      ['doors 20:00, show 21:00', (r) => r.doorsTime === '20:00' && r.showTime === '21:00'],
      ['Tier 3 $113.29 and Tier 2 $118.06 kept as two rows', (r) => cents(r).includes(11329) && cents(r).includes(11806)],
      ['floor rows read as standing', (r) => (r.offers ?? []).filter((o) => /tier/i.test(o.label)).every((o) => o.admission === 'standing')],
    ],
  },
  {
    id: 'P02-1', image: 'metallica-products.jpg', question: 'Hey, which of these should I click if I just want to see Metallica on October 8? Two of us. Just the normal concert, no extras.',
    checks: [
      ['an Oct 8 single-show product', (r) => (r.products ?? []).some((p) => p.kind === 'single_show' && p.date === '2026-10-08' && !p.promoted)],
      ['the 2-day ticket as multi_day with its "Cannot Split By Day"', (r) => (r.products ?? []).some((p) => p.kind === 'multi_day' && /cannot split/i.test(`${p.label} ${p.terms.join(' ')}`))],
      ['the suite as a suite', (r) => (r.products ?? []).some((p) => p.kind === 'suite')],
      ['the Usher & Chris Brown row marked promoted', (r) => [...(r.products ?? []).map((p) => ({ n: p.label, promoted: p.promoted })), ...(r.events ?? []).map((e) => ({ n: e.name, promoted: e.promoted }))].some((x) => /usher|chris brown|r&b/i.test(x.n) && x.promoted)],
      ['no prices invented', (r) => r.priceDollars == null && !(r.offers ?? []).some((o) => o.priceDollars != null)],
    ],
  },
  {
    id: 'S03-1', image: 'metallica-single-night-sold-out.jpg', question: 'This is what Ticketmaster showed me earlier for Metallica at Sphere on October 8. Does this mean I have to buy a hotel package to get in, or can you find two normal tickets another way?',
    checks: [
      ['sold out, verbatim', (r) => r.availability?.status === 'sold_out' && /sold out/i.test(r.availability.text)],
      ['the hotel-package notice kept', (r) => (r.notices ?? []).some((n) => /hotel|package/i.test(n))],
      ['Oct 8 at Sphere', (r) => r.eventDate === '2026-10-08' && /sphere/i.test(r.venue ?? '')],
    ],
  },
  {
    // Live Oct 4: a seat map with Sec 415, Row 6 selected, a $87.75 bubble over the map and a "Home Games" sidebar.
    id: 'R04-1', image: 'rangers-canucks-seatmap.webp', question: 'Is this a good deal for the two of us?',
    checks: [
      ['the header game: Oct 11, 18:00', (r) => r.eventDate === '2026-10-11' && (r.eventTime ?? '18:00') === '18:00'],
      ['the selected listing: section 415, row 6, 2 tickets', (r) => r.section === '415' && r.row === '6' && r.quantity === 2],
      ['$175.50 is the subtotal for two, never per ticket', (r) => (r.priceDollars === 175.5 && r.priceBasis === 'whole_party') || r.totalDollars === 175.5 || (r.priceDollars === 87.75 && r.priceBasis === 'per_ticket')],
      ['no $175.50-a-ticket row and no map bubble as a second row', (r) => !(r.offers ?? []).some((o) => o.priceDollars === 175.5 && o.priceBasis === 'per_ticket') && (r.offers ?? []).length <= 1],
      ['seated, together, not general admission', (r) => r.seatsTogether === true && r.admission !== 'standing'],
      ['no sidebar dates taken as events', (r) => !(r.events ?? []).some((e) => e.date && e.date !== '2026-10-11')],
    ],
  },
];

const e = env();
const selected = selectModelClient(e);
if (!selected) {
  console.error(`[read-launch-images] no model client for EXTRACTION_PROVIDER=${e.EXTRACTION_PROVIDER}; nothing to read.`);
  process.exit(1);
}
console.log(`[read-launch-images] provider=${selected.client.provider} model=${selected.model} effort=${selected.effort}`);
const reader = new ModelListingReader(selected.client, selected.model, selected.effort);
let failed = 0;
for (const c of CASES) {
  const base64 = readFileSync(join(import.meta.dirname, '../tests/fixtures/launch-images', c.image)).toString('base64');
  const mimeType = c.image.endsWith('.webp') ? 'image/webp' as const : 'image/jpeg' as const;
  const receivedAt = new Date('2026-10-02T21:00:00Z');
  try {
    const r = await reader.read({ image: { mimeType, base64 }, receivedAt, question: c.question });
    console.log(`\n=== ${c.id} · ${c.image}`);
    console.log(JSON.stringify(r, null, 2));
    for (const [name, ok] of c.checks) {
      const pass = ok(r);
      if (!pass) failed += 1;
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    }
    const answer = usableEvidence(r) ? answerFromEvidence({ items: [{ fields: fieldsFromRead(r), observedAt: receivedAt, messageId: c.id }], latest: c.question, thread: '', quantity: 2, budgetCents: null, started: false, mode: 'unmatched' }) : null;
    console.log(`--- reply from these facts:\n${answer ? [answer.lead, ...answer.items].join('\n') : '(no screenshot answer)'}`);
    console.log(`--- usage: ${JSON.stringify(reader.lastUsage)}`);
  } catch (err) {
    failed += 1;
    console.error(`\n=== ${c.id} FAILED:`, err instanceof Error ? err.message : err);
  }
}
console.log(`\n[read-launch-images] ${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
