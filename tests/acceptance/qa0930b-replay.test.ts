import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched, markFailed } from '@/lib/intake/outbox';
import { staffReasonLabel, type Concierge } from '@/lib/intake/pipeline';
import type { Extractor } from '@/lib/ai/extraction';
import { ModelOutputError } from '@/lib/ai/model-client';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import replay from '../fixtures/qa-0930b-cases.json';
import sharp from 'sharp';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';

/**
 * The Sep 30 "latest commits" live QA after #56 (18 sends, 13 threads), replayed word for word in send order.
 * Seven variants went unanswered or to a person live; each is asserted on what its answer must say. The same
 * run is then replayed with the AI budget already spent and a model extractor that must not be called: every
 * email is still answered (by the rules reader), and none becomes "a person will reply".
 * Harness as in qa0930-replay.test.ts.
 */
const CLOCK = new Date(replay.clock);
const FROM = 'qa-replay@customer.example';
const LIGHTNING = '20000000-0000-4000-8000-0000000000a1';
const RANGERS_TB = '30000000-0000-4000-8000-0000000000a1';
const CLUB = '10000000-0000-4000-8000-0000000000b1';
const COMIC = '20000000-0000-4000-8000-0000000000b1';
const COMEDY_OCT3 = '30000000-0000-4000-8000-0000000000b1';

type Case = (typeof replay.cases)[number];
const wrap = (s: string) => s.replace(/(.{1,76})(\s+|$)/g, '$1\n').trim();
const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
/** A11's synthetic image, read the way the live model read it: the $72 base price called all-in. */
class A11Reader implements ListingReader {
  readonly name = 'fake';
  async read(input: { image?: unknown }): Promise<ListingRead> {
    if (!input.image) return blank;
    return { ...blank, kind: 'ticket_listing', confidence: 'high', eventName: 'New York Rangers vs. Tampa Bay Lightning', eventDate: '2026-10-01', venue: 'Madison Square Garden', city: 'New York', quantity: 3, priceText: '$72 each + $48 per order', priceDollars: 72, priceBasis: 'per_ticket', feeBasis: 'all_in', totalDollars: 264, section: '212', row: '18', seatNumbers: ['7', '8', '9'], seatsTogether: true, restrictions: ['Obstructed view'], deliveryText: 'Mobile transfer, delivery by 6pm on game day', deliveryBy: '2026-10-01' };
  }
}
/** Stands in for the model: with the budget spent it must never be reached. */
class UnreachableModel implements Extractor {
  readonly name = 'model';
  calls = 0;
  async extract(): Promise<never> {
    this.calls += 1;
    throw new Error('the model was called with no budget left');
  }
}

async function seed(h: DbHandle) {
  await h.db.insert(t.entities).values({ id: LIGHTNING, kind: 'team', name: 'Tampa Bay Lightning', slug: 'tampa-bay-lightning', aliases: ['Lightning', 'Tampa Bay'], league: 'NHL' });
  // G02's one evening show: a stand-up night in Manhattan at 7pm, so the single-pick wording is exercised.
  await h.db.insert(t.venues).values({ id: CLUB, name: 'Village Comedy Room', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7295, longitude: -74.0005 });
  await h.db.insert(t.entities).values({ id: COMIC, kind: 'artist', name: 'Stand-Up Showcase', slug: 'stand-up-showcase', aliases: [] });
  await h.db.insert(t.events).values({ id: COMEDY_OCT3, name: 'Stand-Up Showcase', category: 'comedy', venueId: CLUB, primaryEntityId: COMIC, isHome: null, localStartAt: new Date('2026-10-03T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), publicSaleEndAt: null, faceMinCents: 5910, faceMaxCents: 5910 });
  await h.db.insert(t.eventSourceMappings).values({ eventId: COMEDY_OCT3, sourceId: 'ticketmaster', sourceEventId: 'TGQA0930COMEDY', authoritativeUrl: 'https://www.ticketmaster.com/event/TGQA0930COMEDY', role: 'discovery', confidence: 'provider_id' });
  await h.db.insert(t.events).values({ id: RANGERS_TB, name: 'New York Rangers vs. Tampa Bay Lightning', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, opponentEntityId: LIGHTNING, isHome: true, localStartAt: new Date('2026-10-01T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
}

/** Sends every case in order, each follow-up in its thread, and returns the replies each one produced. */
async function replayAll(h: DbHandle, c: Concierge) {
  const replies = new Map<string, string[]>();
  const requestOf = new Map<string, string>();
  const png = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).png().toBuffer());
  const firstMsg = new Map<string, string>();
  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: CLOCK });
      if (!leased.length) return;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, CLOCK);
      }
    }
  };
  for (const k of replay.cases as Case[]) {
    const parent = k.parent ? firstMsg.get(k.parent) : undefined;
    const attachments = k.attachment ? [{ providerAttachmentId: 'att-a11', filename: 'synthetic-offer.png', declaredMimeType: 'image/png', bytes: png, inline: false }] : [];
    const msg = inbound({ text: wrap(k.body), from: FROM, subject: k.subject, inReplyTo: parent ?? null, references: parent ?? null, attachments });
    if (!k.parent) firstMsg.set(k.id, msg.rfcMessageId!);
    const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
    const r = (await c.ingestInbound(msg)) as { requestId?: string };
    if (r.requestId) requestOf.set(k.id, r.requestId);
    await drain();
    const after = await h.db.select().from(t.sendIntents);
    replies.set(k.id, after.filter((s) => !before.has(s.id)).map((s) => s.bodyText));
  }
  return { replies, requestOf };
}

describe('the Sep 30 latest-commit live QA (post-#56), replayed exactly', () => {
  let h: DbHandle;
  let replies: Map<string, string[]>;

  beforeAll(async () => {
    h = await openTestDb();
    await seed(h);
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: FROM }), now: () => CLOCK, listingReader: new A11Reader() });
    ({ replies } = await replayAll(h, c));
  });
  afterAll(async () => {
    await h.close();
  });

  const all = (id: string) => (replies.get(id) ?? []).join('\n\n=====\n\n');
  // What the email says above the signature (whose tagline is "Your second opinion before you buy").
  const said = (id: string) => all(id).split(/\n\nTicket Guy\n/)[0]!;

  it('every replayed email got an answer, and none of them is "a person will reply"', () => {
    for (const k of replay.cases) {
      expect(replies.get(k.id)?.length, k.id).toBeGreaterThan(0);
      expect(all(k.id), k.id).not.toMatch(/A person is picking this up|a person on our team/i);
    }
  });

  it('what passed live still passes: M01 D, M01-F1 B, M03 none then A, X01 B, M02 break-even, G03 entry', () => {
    expect(all('M01')).toContain('Offer D is the one that meets what you asked for: $585 for all five, fees included.');
    expect(all('M01-F1')).toContain('Offer B wins this one: $480 for six tickets, fees included. That’s $105 less than Offer D.');
    expect(all('M03')).toContain('None of these meets all your requirements.');
    expect(all('M03-F1')).toContain('Offer A is the one that meets what you asked for: $230 for both, fees included.');
    expect(all('X01')).toContain('Offer B wins this one: $210 for both, fees included. That’s $10 less than Offer A.');
    expect(all('M02')).toContain('Offer A only beats it if its fees come to less than $40 in total');
    expect(all('G03')).toContain('Ask the seller for an official mobile transfer');
  });

  it('M02 opens with B as the straightforward choice, the $40 threshold right beside it (writing review)', () => {
    expect(all('M02')).toContain('Offer B is the straightforward choice if you’d rather skip another checkout: $210 for both, fees included. Offer A only beats it if its fees come to less than $40 in total');
  });

  it('one email per question: no "Got it" before a comparison or the parking answer', () => {
    for (const id of ['M01', 'M03', 'X01', 'M02', 'R05', 'V01', 'V02', 'V03', 'V04']) expect(replies.get(id), id).toHaveLength(1);
  });

  it('reasons, not labels: no "Left out:" or "Meets what you asked for" on the offer lines (writing review)', () => {
    for (const id of ['M01', 'M03', 'R05', 'V01', 'V02', 'V04']) expect(all(id), id).not.toMatch(/Left out:|Meets what you asked for\./);
    expect(all('M01')).toContain('It’s six tickets the seller won’t split, and you won’t buy an extra.');
    expect(all('M03')).toContain('Delivery by 6pm misses your noon deadline.');
  });

  it('A11: the total and per-ticket price first, the working and catches as points, no market or buying advice', () => {
    const body = said('A11');
    expect(body).toContain('The example image shows three tickets: $264 in total, $88 each including fees.\n\n- $72 × 3, plus $48 in fees for the whole order.\n- Section 212, row 18, seats 7, 8 and 9, together.\n- Limited or obstructed view; delivery by 6pm on Oct 1.');
    expect(body).toContain('Since it’s a fictional example, there’s no live offer to check.');
    expect(body).not.toMatch(/resale|sellers are charging|before you pay|before you buy|trading|checkout/);
    // Each figure once.
    expect(body.match(/\$264/g)).toHaveLength(1);
    expect(body.match(/6pm/g)).toHaveLength(1);
  });

  it('A11-F1: the correction first, and the $98.89-before-fees question answered from their numbers', () => {
    const body = said('A11-F1');
    expect(body.indexOf('Updated from your email: three tickets, $264 in total, $88 each including fees.')).toBeGreaterThan(0);
    expect(body).toContain('Larger. At $98.89 before fees it already costs $10.89 a ticket more than the $88 all-in, and its fees can only add to that.');
    expect(body).not.toMatch(/These replace|resale|before you pay/);
  });

  it('R05: ordinary B at $210; the wheelchair spaces are not an option for them', () => {
    const body = all('R05');
    expect(body).toContain('Offer B is the one that meets what you asked for: $210 for both, fees included.');
    expect(body).toContain('These are wheelchair or companion spaces, which no one in your group needs');
    expect(body).not.toMatch(/Offer A (is the one|wins)/);
  });

  it('V01: the green listing, four for $180; gold left out as a five-ticket block they won’t buy', () => {
    const body = all('V01');
    expect(body).toContain('The green listing is the one that meets what you asked for: $180 for all four, fees included.');
    expect(body).toContain('The gold listing (five together, unobstructed, can’t be split, immediate transfer): $150 in total including fees for five tickets. It’s five tickets the seller won’t split, and you won’t buy an extra.');
    expect(body).not.toMatch(/The gold listing (is the one|wins)/);
  });

  it('V02: both delivery times converted to New York time; A misses 1pm, B fits at $220', () => {
    const body = all('V02');
    expect(body).toContain('Offer B is the one that meets what you asked for: $220 for both, fees included.');
    expect(body).toContain('Offer A (ordinary seats, delivery by 1:30pm New York time (10:30am Los Angeles time)): $190 in total including fees. Delivery by 1:30pm New York time misses your 1pm New York time deadline.');
    expect(body).toContain('Offer B (ordinary seats, delivery by 12:30pm New York time (9:30am Los Angeles time)): $220 in total including fees.');
    expect(body).not.toMatch(/LOS ANGELES|\$380|\$440/);
  });

  it('V03: parking only admits nobody; two admissions at $95 are $190', () => {
    const body = all('V03');
    expect(body).toContain('a “parking only” listing is a parking pass, not a ticket to the game, so it won’t get either of you in');
    expect(body).toContain('$190 for both');
    expect(said('V03')).not.toMatch(/Found seats you like|price watch|haven’t been able to check|send me the listing|comparable history/i);
  });

  it('A11-F2: the updated example: four tickets, $70 before fees + $36 = $316, $79 each, delivery by 4pm, no market', () => {
    const body = said('A11-F2');
    expect(body).toContain('Updated from your email: four tickets, $316 in total, $79 each including fees.\n\n- $70 × 4, plus $36 in fees for the whole order.\n- Section 212, row 18, seats 7 to 10, together.\n- Limited or obstructed view; delivery by 4pm on Oct 1.');
    expect(body).toContain('These replace what the image showed. Since it’s a fictional example, there’s no live offer to check.');
    expect(body).not.toMatch(/\$264|\$88 each|6pm|resale|before you pay|checkout/);
  });

  it('V04: first seller $269 (per-ticket fee and order fee counted), second $272, both within $275, first saves $3', () => {
    const body = all('V04');
    expect(body).toContain('The first seller wins this one: $269 for all four, fees included. That’s $3 less than the second seller.');
    expect(body).toContain('The first seller (ordinary seats, immediate transfer): $52.50 each, plus $12.75 a ticket in fees and $8 for the whole order: $269 in total for all four.');
    expect(body).toContain('The second seller (ordinary seats, immediate transfer): $68 each including fees, $272 for all four. Also fits, $3 more.');
    expect(body).not.toContain('check its delivery time');
  });

  it('R05-F1: B alone, two seats at $210 with immediate transfer, no wheelchair terms carried over', () => {
    const body = said('R05-F1');
    expect(body).toContain('Looking at Offer B on its own, with nothing from Offer A applied: it meets what you asked for, at $210 for both, fees included.');
    expect(body).toContain('immediate transfer');
    expect(body).not.toMatch(/have a look at the cheaper listings|Offer A \(|wheelchair|up to \$210|Found seats you like|most you’d want to pay/);
  });

  it('G02: one evening option, the time checked, one age check said once, and not called a fit', () => {
    const body = all('G02');
    expect(body).toContain('This is one evening option: the only comedy show I found in');
    expect(body).toContain('The time fits; I haven\'t confirmed it works for your group yet');
    expect(body).not.toMatch(/gone ahead with it/);
    expect((body.match(/16-year-old/g) ?? []).length).toBe(1);
    // The pick and what's unchecked lead; the price floor we can check is checked (3 × $59.10 = $177.30).
    expect(body.indexOf('This is one evening option')).toBeLessThan(body.indexOf('is on general sale'));
    expect(body).toContain('$150 in total: Ticketmaster lists these from $59.10 a ticket before fees, so three already come to $177.30 before fees, over your $150');
    expect(replies.get('G02')).toHaveLength(1);
  });

  it('prints', () => {
    if (process.env.PRINT_REPLAY) writeFileSync(process.env.PRINT_REPLAY, replay.cases.map((k) => `##### ${k.id}\n${all(k.id)}`).join('\n\n'));
    expect(replay.cases.length).toBe(18);
  });
});

describe('the same run with the AI budget already spent (R05 and V01 went to a person live)', () => {
  let h: DbHandle;
  let replies: Map<string, string[]>;
  let requestOf: Map<string, string>;
  const model = new UnreachableModel();

  beforeAll(async () => {
    h = await openTestDb();
    await seed(h);
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: FROM, AI_GLOBAL_DAILY_BUDGET_USD: '0' }), now: () => CLOCK, extractor: model, listingReader: new A11Reader() });
    ({ replies, requestOf } = await replayAll(h, c));
  });
  afterAll(async () => {
    await h.close();
  });

  const all = (id: string) => (replies.get(id) ?? []).join('\n\n=====\n\n');

  it('the model is never called, and each stop is recorded for the operations page', async () => {
    expect(model.calls).toBe(0);
    const stops = await h.db.select().from(t.auditLog).where(eq(t.auditLog.action, 'ai.budget_rules_fallback'));
    expect(stops.length).toBeGreaterThanOrEqual(replay.cases.length);
    expect(stops.every((s) => (s.diff as { scope?: string }).scope === 'global_daily')).toBe(true);
  });

  it('every email is answered from what the customer wrote; none is parked for a person', async () => {
    for (const k of replay.cases) {
      expect(replies.get(k.id)?.length, k.id).toBeGreaterThan(0);
      expect(all(k.id), k.id).not.toMatch(/A person is picking this up/);
    }
    const parked = await h.db.select().from(t.requests).where(eq(t.requests.state, 'manual_attention'));
    expect(parked.map((r) => r.id)).toEqual([]);
    expect(requestOf.get('R05')).toBeDefined();
  });

  it('R05 and V01 get the same answers as with a budget', () => {
    expect(all('R05')).toContain('$210');
    expect(all('V01')).toContain('The green listing is the one that meets what you asked for: $180 for all four, fees included.');
  });
});

describe('customer work that keeps failing is handed to a person, once, saying why', () => {
  let h: DbHandle;
  class DownModel implements Extractor {
    readonly name = 'model';
    async extract(): Promise<never> {
      throw new ModelOutputError('transport', 'api: Connection error.');
    }
  }

  beforeAll(async () => {
    h = await openTestDb();
    await seed(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('after four failed tries the request is manual_attention, the customer is told, and staff see the provider error', async () => {
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: FROM }), now: () => CLOCK, extractor: new DownModel() });
    const k = replay.cases.find((x) => x.id === 'R05')!;
    const r = (await c.ingestInbound(inbound({ text: k.body, from: FROM, subject: k.subject }))) as { requestId?: string };
    let at = CLOCK.getTime();
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const leased = (await leaseDueOutbox(h.db, { limit: 50, now: new Date(at) })).filter((e) => e.eventType === 'request.interpret');
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        try {
          await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          await markDispatched(h.db, ev.id, ev.leaseToken, new Date(at));
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          const res = await markFailed(h.db, ev, error, new Date(at));
          outcomes.push(res);
          if (res === 'dead') outcomes.push(await c.handOffFailedWork({ eventType: ev.eventType, payload: ev.payload, error }));
        }
      }
      at += 3_600_000;
    }
    expect(outcomes).toEqual(['retry', 'retry', 'retry', 'dead', 'handed_off']);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId!));
    expect(req!.state).toBe('manual_attention');
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId!));
    expect(sends.filter((s) => s.dedupeKey === `holding:${r.requestId}`)).toHaveLength(1);
    const alerts = await h.db.select().from(t.outboxEvents).where(eq(t.outboxEvents.eventType, 'staff.alert'));
    expect(alerts).toHaveLength(1);
    // What staff are told: why it stopped, with the provider's own words.
    const [why] = await h.db.select().from(t.requestTransitions).where(eq(t.requestTransitions.toState, 'manual_attention'));
    expect(staffReasonLabel(why!.reason!)).toBe('the AI provider kept failing, so this was stopped after several tries: api: Connection error.');
    // A second dead event for the same request changes nothing: one hand-off, one holding reply.
    expect(await c.handOffFailedWork({ eventType: 'request.interpret', payload: { requestId: r.requestId!, messageId: 'x' }, error: 'again' })).toBe('already_handled');

    // Recovery once the provider is back ("Read the latest email again"): the same email is read and answered,
    // and the customer doesn't get the holding reply a second time.
    const fixed = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: FROM }), now: () => CLOCK });
    const [msg] = await h.db.select().from(t.messages).where(and(eq(t.messages.conversationId, req!.conversationId), eq(t.messages.direction, 'inbound')));
    await fixed.interpret({ messageId: msg!.id, requestId: r.requestId! });
    for (const ev of await leaseDueOutbox(h.db, { limit: 50, now: new Date(at) })) if (ev.eventType === 'research.requested') await fixed.research({ requestId: r.requestId!, revision: Number(ev.payload.revision) });
    const after = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId!));
    expect(after.map((s) => s.bodyText).join('\n')).toContain('Offer B is the one that meets what you asked for: $210 for both, fees included.');
    expect(after.filter((s) => s.dedupeKey === `holding:${r.requestId}`)).toHaveLength(1);
  });
});
