import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { DbHandle } from '@/lib/db';
import { FixtureExtractor } from '@/lib/ai/extraction';
import * as t from '@/lib/db/schema';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, makeConcierge, inbound } from '../harness';

const CLOCK = new Date('2026-09-30T23:15:00Z');
const feeQuestion = 'Two adults need Phoenix pop concert admission. Offer A: two concert admissions $80 TOTAL BEFORE FEES. Offer B: two concert admissions $100 TOTAL all-in. Budget $120 TOTAL. Which has a known price within budget?';
const idQuestion = 'Both of us are 16 and want a Portland indie concert. Copied policy: minimum age 16; ages 16 and above may enter unaccompanied. Bring government-issued photo ID AND school-issued photo ID; both forms are required. We only have school photo IDs. Can we enter alone on these supplied terms?';
type Turn = { text: string; require: RegExp[]; forbid?: RegExp[] };
const cases: Array<{ id: string; turns: Turn[] }> = [
  { id: 'V06-exact', turns: [
    { text: feeQuestion, require: [/Offer B.*\$100 for both/, /less than \$20/] },
    { text: "A's checkout adds a $12 fee per ticket on top of its $80 TOTAL. Other offers and terms unchanged. Which is cheaper for two and what are both totals?", require: [/Offer B.*\$100 for both/, /\$80 in total before fees, plus \$12 per ticket = \$104/, /already \$4 more with the charges you supplied/, /remaining fees come to \$16 or less/], forbid: [/\$4 more before (?:its )?fees/, /whatever they are/] },
    { text: 'No other charges on either offer. These are the final totals. Which costs less for two?', require: [/Offer B.*\$100 for both/, /\$4 (?:less|more)/], forbid: [/remaining fees|fees aren.t known|fees come to/] },
  ] },
  { id: 'fee-cheaper', turns: [
    { text: feeQuestion, require: [/Offer B/] },
    { text: "A's checkout adds a $4 fee per ticket on top of its $80 TOTAL. Other offers and terms unchanged. Which is cheaper?", require: [/plus \$4 per ticket = \$88/, /remaining fees come to less than \$12/, /remaining fees come to \$32 or less/], forbid: [/its fees come to less than \$12/] },
  ] },
  { id: 'fee-equal', turns: [
    { text: feeQuestion, require: [/Offer B/] },
    { text: "A's checkout adds a $10 fee per ticket on top of its $80 TOTAL. Other offers and terms unchanged. Which is cheaper?", require: [/plus \$10 per ticket = \$100/, /tie if (?:there are )?no remaining fees/], forbid: [/costs less whatever they are/] },
  ] },
  { id: 'fee-over-budget', turns: [
    { text: feeQuestion, require: [/Offer B/] },
    { text: "A's checkout adds a $25 fee per ticket on top of its $80 TOTAL. Other offers and terms unchanged. Which fits?", require: [/Offer B.*\$100 for both/, /plus \$25 per ticket = \$130/, /over your \$120 budget by \$10/i, /already \$30 more with the charges you supplied/] },
  ] },
  { id: 'fee-unstated-control', turns: [{ text: 'Two adults need pop concert admission. Offer A: two concert admissions $100 TOTAL BEFORE FEES. Offer B: two concert admissions $100 TOTAL all-in. Which is cheaper?', require: [/tie if (?:there are )?no fees/], forbid: [/costs less whatever they are|remaining fees/] }] },
  { id: 'fee-one-offer-closure', turns: [
    { text: 'Two adults need pop concert admission. Offer A: two concert admissions $80 TOTAL BEFORE FEES, plus a $4 fee per ticket. Offer B: two concert admissions $100 TOTAL BEFORE FEES, plus a $10 fee per ticket. Budget $140 TOTAL. Which fits?', require: [/can.t say which costs less until you see the checkout totals/] },
    { text: 'Offer A: nothing else charged. Other offers unchanged. Which is cheaper?', require: [/Offer A.*\$88 for both, fees included/, /Offer B.*remaining fees come to \$20 or less/], forbid: [/Also fits.*\$32 more/] },
  ] },
  { id: 'V04-exact-and-both-ids', turns: [
    { text: idQuestion, require: [/government-issued photo ID is still missing/, /requires both government-issued photo ID and school-issued photo ID/, /school photo ID covers one requirement/], forbid: [/age-rule change|school photo ID isn.t that form|both meet/] },
    { text: 'We now have government-issued photo ID AND school-issued photo ID. Same policy. Can we enter unaccompanied?', require: [/both meet the supplied entry requirements/, /haven.t independently verified/], forbid: [/ID still needs confirming|missing|age-rule change/] },
    { text: 'Correction: we only have school photo IDs. Same policy. Can we enter unaccompanied?', require: [/government-issued photo ID is still missing/], forbid: [/both meet/] },
  ] },
  { id: 'id-additive', turns: [
    { text: idQuestion, require: [/government-issued photo ID is still missing/] },
    { text: 'We now have government-issued photo IDs too. Same policy. Can we enter unaccompanied?', require: [/both meet the supplied entry requirements/], forbid: [/ID still needs confirming|missing/] },
  ] },
  { id: 'id-or-control', turns: [{ text: idQuestion.replace('AND', 'OR').replace('both forms are required', 'either form is accepted'), require: [/both meet the supplied entry requirements/], forbid: [/missing|does not meet/] }] },
  { id: 'id-government-only', turns: [{ text: idQuestion.replace('We only have school photo IDs', 'We only have government-issued photo IDs'), require: [/school-issued photo ID is still missing/], forbid: [/Their school photo ID|both meet/] }] },
  { id: 'id-negated-school', turns: [{ text: idQuestion.replace('We only have school photo IDs', 'We have government-issued photo IDs, but not school-issued photo IDs'), require: [/school-issued photo ID is still missing/], forbid: [/both meet/] }] },
  { id: 'id-negated-government', turns: [{ text: idQuestion.replace('We only have school photo IDs', 'We have school-issued photo IDs, not government ID'), require: [/government-issued photo ID is still missing/], forbid: [/both meet/] }] },
  { id: 'id-held-versus-required', turns: [{ text: idQuestion.replace('We only have school photo IDs', 'We have school photo IDs, but the venue requires government-issued photo ID too'), require: [/government-issued photo ID is still missing/], forbid: [/both meet/] }] },
  { id: 'id-addition-with-removal', turns: [
    { text: idQuestion, require: [/government-issued photo ID is still missing/] },
    { text: 'We now have government-issued photo IDs too, but not school-issued photo IDs. Same policy. Can we enter unaccompanied?', require: [/school-issued photo ID is still missing/], forbid: [/both meet/] },
  ] },
  { id: 'id-guardian-control', turns: [{ text: 'Both of us are 16 and want a Portland indie concert without adults. Copied policy: minimum age 16; under-18s must be accompanied by a parent or guardian; government-issued photo ID accepted. Both hold accepted government photo ID. Can we enter unaccompanied?', require: [/cannot attend unaccompanied/, /matches the ID you say they have/], forbid: [/confirm they each have|ID still needs confirming|both meet/] }] },
];

// The two exact R11 failures, then one-variable controls, through the actual email pipeline.
// Neither extraction mode calls a provider or sends mail; the second deliberately misreads the brief.
describe.each(['fixture', 'misread-model'] as const)('R11 complete reply regressions (%s extraction)', (mode) => {
  let h: DbHandle;
  const replies = new Map<string, typeof t.sendIntents.$inferSelect[]>();
  beforeAll(async () => {
    h = await openTestDb();
    const fixture = new FixtureExtractor();
    const c = makeConcierge(h, { now: () => CLOCK, extractor: mode === 'fixture' ? fixture : {
      name: 'adversarial-model-stub',
      async extract(input) {
        return { ...await fixture.extract(input), quantity: 1, budgetCents: 3333, budgetBasis: 'whole_party', eventName: 'Midnight', performerOrTeam: 'Midnight' };
      },
    } });
    for (const scenario of cases) {
      let parent: string | null = null;
      for (const [i, turn] of scenario.turns.entries()) {
        const prior = new Set((await h.db.select().from(t.sendIntents)).map((s) => s.id));
        const msg = inbound({ text: turn.text.replace(/(.{1,76})(\s+|$)/g, '$1\n'), subject: scenario.id, from: `r11-${mode}-${scenario.id}@customer.example`, inReplyTo: parent, references: parent, receivedAt: new Date(CLOCK.getTime() + i * 1000) });
        await c.ingestInbound(msg);
        parent ??= msg.rfcMessageId;
        for (let n = 0; n < 10; n++) {
          const events = await leaseDueOutbox(h.db, { limit: 100, now: new Date(CLOCK.getTime() + 10000) });
          if (!events.length) break;
          for (const ev of events) {
            const p = ev.payload as Record<string, string>;
            if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
            if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
            await markDispatched(h.db, ev.id, ev.leaseToken, CLOCK);
          }
        }
        replies.set(`${scenario.id}-${i + 1}`, (await h.db.select().from(t.sendIntents)).filter((s) => !prior.has(s.id)));
      }
    }
    if (process.env.PRINT_CONCERT_R11) writeFileSync(`${process.env.PRINT_CONCERT_R11}-${mode}.json`, JSON.stringify([...replies].map(([id, ss]) => ({ id, replies: ss.map((s) => ({ text: s.bodyText, html: s.bodyHtml })) })), null, 2));
  });
  afterAll(async () => { await h.close(); });
  for (const scenario of cases) for (const [i, turn] of scenario.turns.entries()) it(`${scenario.id} turn ${i + 1}`, () => {
    const ss = replies.get(`${scenario.id}-${i + 1}`)!;
    expect(ss).toHaveLength(1);
    const body = ss[0]!.bodyText;
    for (const required of turn.require) expect(body).toMatch(required);
    for (const forbidden of turn.forbid ?? []) expect(body).not.toMatch(forbidden);
    // The same claims appear in both formats; HTML keeps a prominent answer.
    expect(ss[0]!.bodyHtml).toContain('<strong>');
    for (const required of turn.require) expect(ss[0]!.bodyHtml.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')).toMatch(required);
    if (scenario.id === 'V06-exact' && i === 1) expect(body.match(/already \$4 more/g)).toHaveLength(1);
  });
});
