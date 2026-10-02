import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { parseTicketLink } from '@/lib/domain/ticket-links';
import { FIXTURE_NOW, FX } from '@/lib/fixtures';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { testEnv } from '../harness';

/**
 * Live, Oct 2 2026 (admin request a5583c91): "Are these a good deal? should I hold off?" with a StubHub checkout link.
 * The link carries a cart, a listing number and a ticket count, and no event: we never open marketplace pages, so the
 * game can't come from it. The reply still asked "Which event (performer or team, city, and date) are you looking at?
 * A link or screenshot works." to someone who had just sent a link. It now says what the link does and doesn't tell
 * us, and asks for the game; the link stays on the thread for when they name it.
 */
const LINK = 'https://checkout.stubhub.com/secure/buy/checkout?ID=0213e7be-859d-4bd5-b95f-1a6ae41980d0%7c14301890103%7c2%7c0';
const TEXT = `Are these a good deal? should I hold off?\n${LINK}`;

describe('a checkout link that names no event', () => {
  let h: DbHandle;
  const send = async (text: string, from: string, parent: ReturnType<typeof inbound> | null, at: Date) => {
    const c = makeConcierge(h, { now: () => at });
    const m = inbound({ text, from, subject: parent ? 'Re: Tickets' : 'Tickets', receivedAt: at, inReplyTo: parent?.rfcMessageId ?? null, references: parent?.rfcMessageId ?? null });
    const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
    const r = (await c.ingestInbound(m)) as { requestId: string };
    for (let j = 0; j < 8; j++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(at.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, at);
      }
    }
    const sends = (await h.db.select().from(t.sendIntents)).filter((s) => !before.has(s.id));
    return { m, requestId: r.requestId, text: (sends.at(-1)?.bodyText ?? '').split('\nTicket Guy\n')[0]! };
  };

  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('reads the listing number and the count from the link, and nothing else', () => {
    expect(parseTicketLink(LINK)).toMatchObject({ marketplace: 'stubhub', listingId: '14301890103', quantity: 2, eventId: null, localDate: null, slugText: null });
  });

  it('says the link names no game, what it does carry, and asks for the game, not for a link', async () => {
    const { text } = await send(TEXT, 'checkout-1@customer.example', null, FIXTURE_NOW);
    expect(text).toContain('I can’t open StubHub pages, and that checkout link doesn’t say which game or show it is. It only has the listing number and 2 tickets. Which event and date is it?');
    expect(text).toContain('A screenshot of the checkout page with the section, row and total works too.');
    expect(text).not.toMatch(/A link or screenshot works|A link works too|performer or team, city, and date/);
  });

  it('once they name the game, the thread resolves it and keeps the two tickets and the link', async () => {
    const first = await send(TEXT, 'checkout-2@customer.example', null, FIXTURE_NOW);
    await send('It’s the Knicks game at Madison Square Garden.', 'checkout-2@customer.example', first.m, new Date(FIXTURE_NOW.getTime() + 60_000));
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, first.requestId));
    expect(req!.eventId).not.toBeNull();
    const [v] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, first.requestId)).orderBy(t.requestVersions.revision);
    const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, first.requestId));
    const latest = versions.sort((a, b) => b.revision - a.revision)[0]!.brief as { quantity: number; submittedUrls: string[] };
    expect(v).toBeDefined();
    expect(latest.quantity).toBe(2);
    expect(latest.submittedUrls.some((u) => u.includes('14301890103'))).toBe(true);
  });

  it('a listings read the tracker already makes keeps each listing number under its event', async () => {
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    // An earlier email in this file already put the game on the tracker's list; matched to SeatData, it reads like this.
    await h.db.delete(t.trackedEvents).where(eq(t.trackedEvents.eventId, FX.events.knicks));
    await h.db.insert(t.trackedEvents).values({ eventId: FX.events.knicks, provider: 'seatdata', reasons: ['request'], nextPollAt: FIXTURE_NOW, state: 'active', providerEventId: '555' });
    const fetchImpl = (async (input: string) => (new URL(input).pathname.endsWith('/listings/get')
      ? new Response(JSON.stringify({ has_refreshed: true, listings: [{ listing_id: 14301890103, source: 'sh', price: 180, quantity: 2, section: '210', row: 'E' }, { listing_id: 'VS-77', source: 'vs', price: 150, quantity: 4, section: '224', row: 'A' }] }), { status: 200 })
      : new Response('{}', { status: 404 }))) as unknown as typeof fetch;
    const tracker = new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: 'ab'.repeat(32), SEATDATA_DAILY_CALL_LIMIT: '10' }), now: () => FIXTURE_NOW, fetchImpl, sleep: async () => {} });
    expect(await tracker.currentListings(FX.events.knicks)).not.toBeNull();
    const rows = await h.db.select().from(t.marketListingSightings);
    expect(rows.map((r) => [r.marketplace, r.listingId, r.eventId]).sort()).toEqual([['stubhub', '14301890103', FX.events.knicks], ['vividseats', 'VS-77', FX.events.knicks]]);
  });

  it('seen at one event: the exact checkout email is answered for that game, with no question about which one', async () => {
    const { requestId, text } = await send(TEXT, 'checkout-3@customer.example', null, FIXTURE_NOW);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.eventId).toBe(FX.events.knicks);
    expect(text).not.toMatch(/Which event|doesn’t say which game/);
  });

  it('seen at two events, or not for three weeks: no guess, the question about which game', async () => {
    await h.db.insert(t.marketListingSightings).values({ marketplace: 'stubhub', listingId: '14301890103', eventId: FX.events.rangersRegular, firstSeenAt: FIXTURE_NOW, lastSeenAt: FIXTURE_NOW }).onConflictDoNothing();
    const two = await send(TEXT, 'checkout-4@customer.example', null, FIXTURE_NOW);
    expect(two.text).toContain('that checkout link doesn’t say which game or show it is');
    await h.db.delete(t.marketListingSightings);
    await h.db.insert(t.marketListingSightings).values({ marketplace: 'stubhub', listingId: '14301890103', eventId: FX.events.knicks, firstSeenAt: new Date(FIXTURE_NOW.getTime() - 30 * 86_400_000), lastSeenAt: new Date(FIXTURE_NOW.getTime() - 22 * 86_400_000) });
    const stale = await send(TEXT, 'checkout-5@customer.example', null, FIXTURE_NOW);
    expect(stale.text).toContain('that checkout link doesn’t say which game or show it is');
  });
});
