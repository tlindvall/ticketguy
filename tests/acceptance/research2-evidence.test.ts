import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW, FX } from '@/lib/fixtures';
import { basketKeyFor } from '@/lib/intake/pipeline';

/**
 * Research 2 (Sep 30 2026): price evidence and useful answers. The three live conversations (R2-01 to R2-03),
 * each two turns in one thread, replayed through the pipeline, plus the trend gates (time and rights) through
 * the real research path and the approval recheck.
 *
 * The message texts are rebuilt from the report's descriptions; WAVE_1_CASES.json and the raw captures weren't
 * available here. Rules-path extraction (fixture world), not the production model.
 */
const NOW = FIXTURE_NOW;
// Wording that would undo a correct calculation (the report's "complete-reply" check).
const CONTRADICTS = /\b(?:fair|under (?:your )?budget|buy now|i(?:’|')d buy|i wouldn(?:’|')t wait|no need to rush|plenty|selling fast|prices will)\b|(?<!whether |shows |show )demand (?:is|has been) (?:rising|growing|up)/i;
// Event intake the report saw instead of an answer.
const INTAKE = /which (?:event|show|game)|how many tickets (?:do )?you|do they need to be together|got it/i;

describe('Research 2: supplied evidence is answered, and trends are gated', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; html: string; state: string; eventId: string | null; requestId: string };
  const drain = async (c: ReturnType<typeof makeConcierge>) => {
    for (let i = 0; i < 8; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: NOW });
      if (!leased.length) return;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
    }
  };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW });
    n += 1;
    const from = `r2-${n}@customer.example`;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const text of turns) {
      const m = inbound({ text, from, subject: prev ? 'Re: Prices' : 'Prices', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      await drain(c);
      const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
      const last = sends.at(-1)!;
      out.push({ text: last.bodyText.split('\nTicket Guy\n')[0]!.trim(), html: last.bodyHtml, state: req!.state, eventId: req!.eventId, requestId: r.requestId });
    }
    return out;
  };
  // The answer first and in bold, no event search or intake, no links, nothing that undoes the arithmetic.
  const answered = (r: Turn, lead: string) => {
    expect(r.text.split('\n\n')[0]).toBe(lead);
    const body = r.html.slice(r.html.indexOf('<p'), r.html.indexOf('Ticket Guy'));
    expect(body).toMatch(/^<p[^>]*><strong>/);
    expect((body.match(/<strong>/g) ?? []).length).toBe(1);
    expect(body).not.toContain('<a ');
    expect(r.text).not.toMatch(INTAKE);
    expect(r.text).not.toMatch(CONTRADICTS);
    expect(r.state).toBe('recommendation_sent');
    expect(r.eventId).toBeNull();
  };

  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  describe('live wave, two turns each', () => {
    it('R2-01: singles fell, the group basket is unassessed; then the supplied group totals rose', async () => {
      const [first, second] = await converse([
        'Yesterday single tickets were $90 each and today they are $60. We need five adjacent upper-tier seats. Does that mean our seats got cheaper too?',
        'Here are comparable group totals for the five seats: $450 yesterday and $500 today. What does that tell us?',
      ]);
      answered(first!, 'Singles fell $30, from $90 to $60 (33.3% lower).');
      expect(first!.text).toContain('It doesn’t tell us what five adjacent upper-tier seats cost');
      expect(first!.text).toContain('If you have the total for the five adjacent upper-tier seats at both times, send it');
      answered(second!, 'For the five of you, the latest total is $500: $50 more than the earlier $450 (11.1%).');
      expect(second!.text).toContain('Singles got cheaper over the same time ($90 to $60), but they aren’t the tickets the five of you need');
      expect(second!.text).toContain('Two quotes don’t prove a continuing rise, or that those seats are still there.');
      // Observation days are not event dates; the five-seat basket is their quantity.
      const [ver] = await h.db.select().from(t.requestVersions).where(and(eq(t.requestVersions.requestId, second!.requestId), eq(t.requestVersions.revision, 2)));
      expect(ver!.brief).toMatchObject({ dateExpression: null, resolvedLocalDate: null, quantity: 5 });
    });

    it('R2-03: $200 before unknown fees against $250 all-in, then the old fees make it $260 against $250', async () => {
      const [first, second] = await converse([
        'Yesterday I was quoted $100 per ticket before fees, and the fees weren’t shown. Today’s quote is $125 per ticket all-in. I need two tickets. Which is cheaper?',
        'Yesterday’s fees came to $60 total for the order.',
      ]);
      answered(first!, 'It depends on yesterday’s fees: today’s $250 is cheaper only if they came to more than $50.');
      expect(first!.text).toContain('Yesterday: $100 a ticket, so $200 for two before fees, plus fees I don’t know. Today: $125 a ticket, so $250 for two with fees included.');
      expect(first!.text).not.toContain('at exactly $50 they tie'); // said once, in the lead
      answered(second!, 'Today’s pair is $250 with fees included: $10 cheaper than yesterday’s $260 (3.85%).');
      expect(second!.text).toContain('Yesterday was $200 plus $60 in fees, so $260 complete.');
      const [ver] = await h.db.select().from(t.requestVersions).where(and(eq(t.requestVersions.requestId, second!.requestId), eq(t.requestVersions.revision, 2)));
      expect(ver!.brief).toMatchObject({ dateExpression: null, quantity: 2 });
    });

    it('R2-02: a net drop of 30 listings is not 30 sales; then a separate report of 12 orders / 24 tickets, demand unproven', async () => {
      const [first, second] = await converse([
        'Active listings for the show went from 100 yesterday to 70 today. Does that mean 30 tickets sold?',
        'A separate sales report says 12 orders and 24 tickets sold over the same period.',
      ]);
      answered(first!, 'Listings fell by 30, from 100 to 70 (30% fewer). That’s a count of listings, not of tickets, orders or sales.');
      expect(first!.text).toContain('the drop doesn’t say how many tickets sold, or whether demand is rising');
      answered(second!, 'Your report records 12 orders covering 24 tickets; that doesn’t show thirty fewer listings were thirty sales.');
      expect(second!.text).toContain('The listing count still fell from 100 to 70.');
      expect(second!.text).toContain('we can’t attribute that net change to those orders without listing-level reconciliation');
      expect(second!.text).toContain('Neither figure shows demand is rising');
      expect(second!.text).toContain('The report is yours; I haven’t checked where it comes from or how it counts.');
      // Tickets in a sales report are not how many they need.
      const [ver] = await h.db.select().from(t.requestVersions).where(and(eq(t.requestVersions.requestId, second!.requestId), eq(t.requestVersions.revision, 2)));
      expect((ver!.brief as { quantity: number | null }).quantity).not.toBe(24);
    });
  });

  // Research2 post-deploy (Oct 1 2026, commit 1d4b2a4): the exact live texts, where both follow-ups failed. The
  // group follow-up said "five adjacent reserved seats … $450 TOTAL including fees", which wasn't read as group
  // totals, so the singles answer came back; the sales follow-up's question ("those 30 fewer listings were 30
  // sales … now") overwrote 100 → 70 with 30 → 30, and "12 completed orders" wasn't read as a sales report.
  describe('post-deploy live wave, exact texts', () => {
    const brief = async (requestId: string) => (await h.db.select().from(t.requestVersions).where(and(eq(t.requestVersions.requestId, requestId), eq(t.requestVersions.revision, 2))))[0]!.brief as { quantity: number | null; budgetCents: number | null; dateExpression: string | null };

    it('R2-01: five-seat all-in totals rose $50 (11.1%) while singles fell', async () => {
      const [first, second] = await converse([
        'These are supplied hypothetical snapshots for the same US concert, not independently verified inventory. Yesterday the cheapest single ticket was $90 including fees; today it\'s $60 including fees. We need FIVE reserved seats together in the same upper-tier zone. Can you say our tickets are trending down, and should we wait? No five-seat offers or comparable group history have been supplied yet.',
        'Now add two comparable supplied observations for five adjacent reserved seats in our upper-tier zone: yesterday $450 TOTAL including fees; today $500 TOTAL including fees, with the same admission and fee basis. This is still hypothetical supplied data, not a verified source or forecast. What changed for our group, and does it prove prices will keep rising?',
      ]);
      answered(first!, 'Singles fell $30, from $90 to $60 (33.3% lower).');
      // Their seats as they said them: "five reserved seats together in the upper tier", not "five reserved together seats".
      expect(first!.text).toContain('It doesn’t tell us what five reserved seats together in the upper tier cost');
      answered(second!, 'For the five of you, the latest total is $500 with fees included: $50 more than the earlier $450 (11.1%).');
      expect(second!.text).toContain('Singles got cheaper over the same time ($90 to $60), but they aren’t the tickets the five of you need');
      expect(second!.text).toContain('Two quotes don’t prove a continuing rise');
      expect(second!.text).not.toContain('That’s single tickets only');
      expect(await brief(second!.requestId)).toMatchObject({ quantity: 5, budgetCents: null, dateExpression: null });
    });

    it('R2-02: 100 → 70 listings kept; the report’s 12 orders / 24 tickets beside it; no quantity taken from it', async () => {
      const [first, second] = await converse([
        'For a hypothetical US concert, a listing feed showed 100 active listings yesterday and 70 today. We have no completed-sales records, listing-level removal reasons or inventory reconciliation. Can you say 30 tickets sold or that demand is up? Tell me what we can actually conclude from these supplied counts.',
        'I now have a separate supplied report recording 12 completed orders for 24 tickets during that period. Nothing else about the listing feed changed. Can we say those 30 fewer listings were 30 sales, and what can we now report about sales?',
      ]);
      answered(first!, 'Listings fell by 30, from 100 to 70 (30% fewer). That’s a count of listings, not of tickets, orders or sales.');
      answered(second!, 'Your report records 12 orders covering 24 tickets; that doesn’t show thirty fewer listings were thirty sales.');
      expect(second!.text).toContain('The listing count still fell from 100 to 70.');
      expect(second!.text).toContain('Neither figure shows demand is rising');
      expect(second!.text).not.toMatch(/30 both times|didn’t change/);
      expect(await brief(second!.requestId)).toMatchObject({ quantity: null, budgetCents: null });
    });

    it('R2-03: the fee fact completes the old quote and is not a budget', async () => {
      const [first, second] = await converse([
        'For the same hypothetical US concert and equivalent pair of adjacent reserved seats, yesterday\'s supplied quote was $100 per ticket BEFORE fees. Today\'s quote is $125 per ticket INCLUDING all fees. We need two tickets. Is that a 25% price increase, and which is cheaper? Yesterday\'s fees are unknown. Please calculate the party totals and separate known facts from missing ones; don\'t search for real inventory.',
        'Change only the missing fee fact: yesterday\'s fees were $60 TOTAL for the pair. All other supplied facts are unchanged. Which complete quote is cheaper, by how much, and what percentage changed?',
      ]);
      answered(first!, 'It depends on yesterday’s fees: today’s $250 is cheaper only if they came to more than $50.');
      answered(second!, 'Today’s pair is $250 with fees included: $10 cheaper than yesterday’s $260 (3.85%).');
      expect(second!.text).toContain('Yesterday was $200 plus $60 in fees, so $260 complete.');
      expect(await brief(second!.requestId)).toMatchObject({ quantity: 2, budgetCents: null });
    });

    it('a budget they do state in a figures thread is kept', async () => {
      const [, second] = await converse([
        'Yesterday single tickets were $90 each and today they are $60. We need five adjacent upper-tier seats. Does that mean our seats got cheaper too?',
        'Our budget is $500 total. Here are comparable group totals for the five seats: $450 yesterday and $500 today. What does that tell us?',
      ]);
      expect((await brief(second!.requestId)).budgetCents).toBe(50000);
    });
  });

  describe('trend gates through the research path (Rangers preseason, five upper together, $475 → $425 over 24h)', () => {
    const DS = '00000000-0000-4000-8000-0000000000d5';
    const basket = basketKeyFor(FX.events.rangersPreseason, 5, 'upper');
    const ask = 'Hi! Five of us want to see the New York Rangers preseason game at MSG on Oct 3. We need to sit together, budget is $450 total. We definitely have to go.';
    const draft = async () => {
      const [r] = await converse([ask]);
      const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r!.requestId));
      return rec!;
    };
    const snapshots = () => h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, FX.events.rangersPreseason), eq(t.marketSnapshots.basketKey, basket)));
    let original: Array<{ id: string; observedAt: Date }> = [];

    beforeAll(async () => {
      original = (await snapshots()).map((s) => ({ id: s.id, observedAt: s.observedAt }));
      expect(original).toHaveLength(4);
      // The current-event series as real (non-fixture) data under one dataset whose state each case sets.
      await h.db.insert(t.marketDatasets).values({ id: DS, provider: 'TEST', licenseReference: 'test licence reference', approvedUses: ['tracking', 'advice', 'customer_display'], status: 'approved', isFixture: false, approvedBy: 'test' });
      for (const s of original) await h.db.update(t.marketSnapshots).set({ datasetId: DS, isFixture: false }).where(eq(t.marketSnapshots.id, s.id));
    });
    const setDataset = (over: Partial<typeof t.marketDatasets.$inferInsert>) => h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'advice', 'customer_display'], rawRetentionUntil: null, derivedRetentionUntil: null, ...over }).where(eq(t.marketDatasets.id, DS));
    const shift = async (hours: number) => { for (const s of original) await h.db.update(t.marketSnapshots).set({ observedAt: new Date(s.observedAt.getTime() + hours * 3_600_000) }).where(eq(t.marketSnapshots.id, s.id)); };

    it('positive control: an approved dataset gives the trend, and the draft can be approved', async () => {
      await setDataset({});
      const rec = await draft();
      expect(rec.bodyText).toMatch(/fallen from \$475 to \$425 over the last 24 hours/);
      const c = makeConcierge(h, { now: () => NOW });
      expect(await c.approveRecommendation({ recommendationId: rec.id, reviewerUserId: 'staff-1', expectedRevision: 1, draftHash: rec.draftHash, note: null })).toEqual({ ok: true, sendIntentId: expect.any(String) });
    });
    it.each([
      ['revoked', { status: 'revoked' }],
      ['quarantined', { status: 'quarantined' }],
      ['expired', { status: 'expired' }],
      ['retention ended', { rawRetentionUntil: new Date(NOW.getTime() - 3_600_000), derivedRetentionUntil: new Date(NOW.getTime() - 3_600_000) }],
      ['no advice use', { approvedUses: ['tracking', 'customer_display'] }],
    ] as const)('%s dataset: no trend is derived or shown', async (_label, over) => {
      await setDataset(over as Partial<typeof t.marketDatasets.$inferInsert>);
      const rec = await draft();
      expect(rec.bodyText).not.toMatch(/fallen from \$475|risen from|over the last 24 hours/);
    });
    it('advice without display: the trend steers nothing visible', async () => {
      await setDataset({ approvedUses: ['tracking', 'advice'] });
      const rec = await draft();
      expect(rec.bodyText).not.toMatch(/fallen from \$475/);
    });
    it('a draft written while approved is blocked at approval once the dataset is revoked', async () => {
      await setDataset({});
      const rec = await draft();
      expect(rec.bodyText).toMatch(/fallen from \$475/);
      await setDataset({ status: 'revoked' });
      const c = makeConcierge(h, { now: () => NOW });
      expect(await c.approveRecommendation({ recommendationId: rec.id, reviewerUserId: 'staff-1', expectedRevision: 1, draftHash: rec.draftHash, note: null })).toEqual({ ok: false, status: 409, reason: 'trend_rights_changed' });
      const [after] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.id, rec.id));
      expect(after!.reviewStatus).toBe('pending');
      expect(after!.reviewNote).toContain('trend_rights_changed');
    });
    it('the same series ending 14 days ago is history, never "the last 24 hours"', async () => {
      await setDataset({});
      await shift(-14 * 24);
      const rec = await draft();
      expect(rec.bodyText).not.toMatch(/over the last 24 hours|fallen from \$475 to \$425 over/);
      expect(rec.bodyText).toContain('too old to say how prices are moving now');
      await shift(0);
    });
    it('the same series moved 48 hours into the future is not read at all', async () => {
      await setDataset({});
      await shift(48);
      const rec = await draft();
      expect(rec.bodyText).not.toMatch(/fallen from \$475|over the last 24 hours|too old/);
      await shift(0);
    });
  });
});
