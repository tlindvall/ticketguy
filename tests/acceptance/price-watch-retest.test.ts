import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { openTestDb, inbound, makeConcierge, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { SeatDataClient } from '@/lib/market/seatdata';
import { seedDiscovery } from './r1-discovery.harness';

/**
 * Research1 price-watch retest (Oct 1 2026, build a80744b): the exact L01–L03 texts for Kacey Musgraves at Moody
 * Center ATX, through the real intake path, over the Research 1 catalog. PW-ENTRY-REPLY-02: "I can only arrive
 * after the show starts; late entry must be allowed" vanished from the ordinary reply. PW-MULTI-INTENT-01: a scoped
 * stop swallowed the entry question beside it. PW-EMAIL-FOCUS-01: an event page read as "the listing you sent",
 * the same price twice, and three generic questions. PW-CALL-BUDGET-01: a 503 retried twice spent three calls of a
 * one-call allowance. Rules-path extraction, not the production model; no SeatData market data in this catalog.
 */
const NOW = new Date('2026-10-01T23:34:00Z');
const TM = 'https://www.ticketmaster.com/kacey-musgraves-middle-of-nowhere-tour-austin-texas-10-07-2026/event/3A006498F97064FD';
const L01 = `Hey Ticket Guy, please watch Kacey Musgraves at Moody Center ATX in Austin on October 7, 2026 for two tickets together. Alert me if the price comes down. ${TM}`;
const L02 = `Please watch Kacey Musgraves at Moody Center ATX in Austin on October 7, 2026: 2 tickets together, $500 total including fees. Only sections 101 through 105; other sections will not work. Alert me when you find them. ${TM}`;
const L03 = [
  `Please watch Kacey Musgraves at Moody Center ATX in Austin on October 7, 2026: 2 tickets, $500 total including fees. I can only arrive after the show starts; late entry must be allowed. Do not suggest a ticket unless that entry rule is confirmed. Alert me when you find them. ${TM}`,
  'My main question was late entry: I can only arrive after the show starts and entry then must be allowed. Have you verified that for this event? If not, say so and give the official venue policy or a verified contact route. Cancel only any price watch in this request; do not start or restart one.',
];
const CANCEL_ONLY = 'Cancel only any price watch for this request. Please confirm whether there was a watch running. Keep other requests and marketing preferences unchanged. I do not want you to create or restart a watch.';

describe('Research1 price-watch retest: entry rules, mixed commands, focus and call budget', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; html: string; requestId: string; state: string };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const [i, text] of turns.entries()) {
      const m = inbound({ text, from: `pw-rt-${n}@customer.example`, subject: prev ? 'Re: Kacey Musgraves October 7' : 'Kacey Musgraves October 7', receivedAt: new Date(NOW.getTime() + i * 60_000), inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let j = 0; j < 8; j++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10 * 60_000) });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
      const recs = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
      // The research reply (held for review) when there is one, else the last thing sent.
      const body = recs.at(-1)?.bodyText ?? sends.at(-1)?.bodyText ?? '';
      out.push({ text: body.split('\nTicket Guy\n')[0]!, html: recs.at(-1)?.bodyHtml ?? sends.at(-1)?.bodyHtml ?? '', requestId: r.requestId, state: req!.state });
    }
    return out;
  };
  const watches = (requestId: string) => h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId));

  beforeAll(async () => {
    h = await openTestDb();
    await seedDiscovery(h);
    // The act behind the catalog rows, and the exact event id the customer's link carries.
    const [kacey] = await h.db.insert(t.entities).values({ kind: 'performer', name: 'Kacey Musgraves', slug: 'pw-rt-kacey', aliases: [] }).returning();
    const rows = await h.db.select().from(t.events).where(like(t.events.name, 'Kacey Musgraves%'));
    for (const e of rows) await h.db.update(t.events).set({ primaryEntityId: kacey!.id }).where(eq(t.events.id, e.id));
    const oct7 = rows.find((e) => e.localStartAt.toISOString() === '2026-10-08T00:30:00.000Z')!;
    await h.db.insert(t.eventSourceMappings).values({ eventId: oct7.id, sourceId: 'ticketmaster', sourceEventId: '3A006498F97064FD', authoritativeUrl: TM, role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => {
    await h.close();
  });

  describe('L03: a relative late-entry rule is answered first, and survives a scoped stop', () => {
    it('the opening leads with late entry unverified, offers no ticket on that basis, and sets up no watch', async () => {
      const [first] = await converse([L03[0]!]);
      const parts = first!.text.split('\n\n');
      expect(parts[1]).toMatch(/^Late entry is unverified\. The 7:30pm start on the listing doesn’t tell us whether you can get in once it’s under way, so I wouldn’t buy on that basis yet\./);
      expect(first!.html).toContain('<strong>Late entry is unverified.</strong>');
      expect(first!.text).toContain('Before buying, confirm that this event admits people arriving after it starts. Nothing I have states Moody Center ATX’s late-entry policy for that night, and I don’t have a verified contact route for it on file.');
      expect(first!.text).toContain('I haven’t set up a price watch for this: listings don’t show whether a ticket admits people arriving after the start');
      expect(first!.text).not.toMatch(/My read|screenshot|When do you need|lock in seats|I can’t watch prices for you yet/);
      expect(await watches(first!.requestId)).toHaveLength(0);
      const audits = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'watch.not_created'), eq(t.auditLog.entityId, first!.requestId)));
      expect(audits.map((a) => (a.diff as { reason: string }).reason)).toContain('unverifiable:entry_rule');
    });
    it('the follow-up stops the (absent) watch and still answers the entry question, inventing no route', async () => {
      const [, second] = await converse(L03);
      expect(second!.text).toContain('There was no active price watch or alert on this request, so nothing was being monitored and there’s nothing to stop.');
      expect(second!.text).toContain('On late entry: I haven’t verified it for Kacey Musgraves - Middle of Nowhere Tour at Moody Center ATX, Wed, Oct 7 at 7:30pm. Nothing I have states Moody Center ATX’s late-entry policy, and I don’t have a verified contact route for it on file, so I can’t give you one. I wouldn’t buy a ticket for an arrival after the start until that’s confirmed.');
      expect(second!.html).toContain('<strong>On late entry: I haven’t verified it for Kacey Musgraves');
      expect(second!.text).not.toMatch(/box office|call the venue|\(\d{3}\)|@|https?:\/\//);
      expect(second!.text).toContain('Nothing else has changed');
      expect(await watches(second!.requestId)).toHaveLength(0);
      expect(second!.state).toBe('closed');
    });
    it('control: a plain scoped stop with no question gets the stop reply alone', async () => {
      const [, second] = await converse([L03[0]!, CANCEL_ONLY]);
      expect(second!.text).toContain('There was no active price watch');
      expect(second!.text).not.toContain('On late entry');
    });
  });

  describe('L01 and L02: an event page is not a listing; one summary and one next step', () => {
    it('L01: no budget and an event page: the reply asks for the all-in total and nothing generic', async () => {
      const [first] = await converse([L01]);
      expect(first!.text).not.toMatch(/the one you sent|not that listing|screenshot of it|When do you need|lock in seats now|My read/);
      expect(first!.text).toContain('I can’t watch prices for you yet, so nothing is being monitored for this request and no alert will come.');
      expect(first!.text).toContain('You sent the Ticketmaster event page rather than a particular listing, so there are no seats or price of yours to check yet.');
      expect(first!.text).toContain('What’s the most you’d pay in total for two, fees included?');
      expect(first!.text).toContain('Found seats you like on Ticketmaster? Send me the price and section (a screenshot works) and I’ll check them.');
      expect((first!.text.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(2);
      // The live reply ran to 407 words; the same request is answered in well under half that.
      expect(first!.text.split(/\s+/).length).toBeLessThan(240);
    });
    it('L02: a budget given: the cap is kept, no watch, and the one question is about seats they find', async () => {
      const [first] = await converse([L02]);
      expect(first!.text).toContain('I can’t watch prices for you yet');
      expect(first!.text).toContain('$500 in total for both, once fees are added');
      expect(first!.text).toContain('One thing that would help me:');
      expect(first!.text).not.toMatch(/the one you sent|When do you need|lock in seats now|What’s the most you’d/);
      expect(await watches(first!.requestId)).toHaveLength(0);
    });
  });

  describe('PW-CALL-BUDGET-01: attempts, retries included, stay inside the daily allowance', () => {
    const KEY = 'ab'.repeat(32);
    let reads = 0;
    let status = 503;
    const fetchImpl = (async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/v0.1/listings/get') {
        reads += 1;
        return status === 200 ? new Response(JSON.stringify({ has_refreshed: true, listings: [] }), { status: 200 }) : new Response('{}', { status });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const tracker = (limit: number) => new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY, SEATDATA_DAILY_CALL_LIMIT: String(limit) }), now: () => NOW, fetchImpl, sleep: async () => {} });
    const fetches = () => h.db.select().from(t.marketFetches).where(eq(t.marketFetches.kind, 'listings_watch'));
    beforeAll(async () => {
      await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
      await h.db.insert(t.trackedEvents).values({ eventId: FX.events.knicks, provider: 'seatdata', reasons: ['request'], nextPollAt: NOW, state: 'active', providerEventId: '555' });
    });
    const reset = async () => {
      reads = 0;
      await h.db.delete(t.marketFetches);
    };

    it('the client makes no more attempts than it is allowed', async () => {
      reads = 0;
      const api = new SeatDataClient(KEY, { fetchImpl, sleep: async () => {} });
      api.attemptsAllowed = 1;
      await expect(api.listings(555)).rejects.toMatchObject({ type: 'server_error', status: 503 });
      expect(reads).toBe(1);
      api.attemptsAllowed = 0;
      await expect(api.listings(555)).rejects.toMatchObject({ type: 'budget_exhausted' });
      expect(reads).toBe(1);
      api.attemptsAllowed = Infinity;
      await expect(api.listings(555)).rejects.toMatchObject({ type: 'server_error' });
      expect(reads).toBe(4);
    });

    it('one call left: a 503 is attempted once, logged as one call, and no alert follows', async () => {
      await reset();
      expect(await tracker(1).listingsForWatch(FX.events.knicks, 4)).toBeNull();
      expect(reads).toBe(1);
      const rows = await fetches();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'error', calls: 1, detail: 'server_error:503' });
    });

    it('room for retries: three attempts at most, all counted', async () => {
      await reset();
      expect(await tracker(5).listingsForWatch(FX.events.knicks, 4)).toBeNull();
      expect(reads).toBe(3);
      expect((await fetches())[0]).toMatchObject({ status: 'error', calls: 3 });
      // Two calls left after that: the next read gets its one retry and no more.
      expect(await tracker(5).listingsForWatch(FX.events.knicks, 4)).toBeNull();
      expect(reads).toBe(5);
      expect((await fetches()).map((r) => r.calls).sort()).toEqual([2, 3]);
    });

    it('nothing left: no attempt, and the skipped read is recorded', async () => {
      await reset();
      await tracker(1).listingsForWatch(FX.events.knicks, 4);
      expect(reads).toBe(1);
      expect(await tracker(1).listingsForWatch(FX.events.knicks, 4)).toBeNull();
      expect(reads).toBe(1);
      expect((await fetches()).map((r) => r.status).sort()).toEqual(['error', 'skipped_budget']);
    });

    it('two watches evaluated at once share the one call left', async () => {
      await reset();
      status = 200;
      const [a, b] = await Promise.all([tracker(1).listingsForWatch(FX.events.knicks, 4), tracker(1).listingsForWatch(FX.events.knicks, 4)]);
      expect(reads).toBe(1);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await fetches()).map((r) => r.status).sort()).toEqual(['skipped_budget', 'success']);
      status = 503;
    });
  });
});
