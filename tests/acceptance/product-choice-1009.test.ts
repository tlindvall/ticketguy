import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { asksProductChoice, productChoiceAnswer } from '@/lib/advice/product-choice';

/**
 * Live, Oct 9 2026: "Which MRAK ticket should four of us buy?" (a four-pack and GA on the page) is a choice of ticket
 * type. The reply is the recommendation first, on the pack's terms, cheaper per person only on the customer's own
 * figures, with the admission terms and fees to confirm; never a resale trend block, which has nothing to say about it.
 */
const now = FIXTURE_NOW; // Sep 22, 2026
const HALL = '10000000-0000-4000-8000-0000000000a7';
const ACT = '20000000-0000-4000-8000-0000000000a7';
const SHOW = '30000000-0000-4000-8000-0000000000a7';

describe('a ticket-type choice for a group: the pack recommended first, its terms and fees to confirm, no trend', () => {
  let h: DbHandle;
  const interpretAll = async (c: ReturnType<typeof makeConcierge>) => {
    const research: string[] = [];
    for (let i = 0; i < 5; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(now.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') research.push(p.requestId!);
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
    return research;
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: HALL, name: 'Warehouse Hall', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: ACT, kind: 'artist', name: 'MRAK', slug: 'mrak', aliases: [], league: null, homeVenueId: null });
    await h.db.insert(t.events).values({ id: SHOW, name: 'MRAK', category: 'concert', venueId: HALL, primaryEntityId: ACT, isHome: null, localStartAt: new Date('2026-10-11T02:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
    await h.db.update(t.adapterConfigs).set({ enabled: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it('the live wording: the four-pack first, on its terms, with no price claimed and no trend', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Which MRAK ticket should four of us buy? There is a four-pack and regular GA tickets on the page.', from: 'mrak@customer.example', subject: 'MRAK' }))) as { requestId: string };
    expect(await interpretAll(c)).toEqual([]);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(sends).toHaveLength(1);
    const body = sends[0]!.bodyText;
    expect(body).toContain('Hey,\n\nThe four-pack looks best for your group, provided its entry conditions suit you.\n\nWhether it works out cheaper per person than four individual GA tickets depends on the prices at checkout, which I haven’t seen: compare the pack price with four singles before you buy.\n\nBefore you buy, confirm the pack’s admission terms (who it admits, whether everyone has to enter together, and any age or ID rule) and the fees at checkout, which I haven’t seen for MRAK on');
    expect(body).not.toMatch(/resale|trend|going up|going down|buy now or wait|On buy or wait|\$\d|[–—]/);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('recommendation_sent');
    expect(req!.eventId).toBe(SHOW);
  });

  it('cheaper per person is said only on the customer’s own figures, each way', () => {
    const ev = { name: 'MRAK', when: 'Sat, Oct 10' };
    expect(asksProductChoice('Which MRAK ticket should four of us buy, the four-pack or GA?')).toBe(true);
    expect(asksProductChoice('Which MRAK ticket should four of us buy?')).toBe(false); // no ticket type named: nothing to choose between
    expect(asksProductChoice('Four of us are going to MRAK, how much are tickets?')).toBe(false);
    const cheaper = productChoiceAnswer('Which MRAK ticket should four of us buy? The four-pack is $200 and GA is $60 each.', '', ev, [], { quantity: 4 })!;
    expect(cheaper.lead).toBe('The four-pack looks best for your group, provided its entry conditions suit you.');
    expect(cheaper.items[0]).toBe('On the figures you gave, it works out cheaper per person than four individual GA tickets: $50 each against $60.');
    const dearer = productChoiceAnswer('Which MRAK ticket should four of us buy? The four-pack is $280 and GA is $60 each.', '', ev, [], { quantity: 4 })!;
    expect(dearer.lead).toBe('Four individual GA tickets look like the better buy for your group, unless the four-pack’s terms suit you better.');
    expect(dearer.items[0]).toContain('isn’t cheaper per person than four individual GA tickets ($70 each against $60)');
    // A pack for a different party size is not their pack: the ordinary product answer.
    expect(productChoiceAnswer('Which MRAK ticket should we buy, the four-pack or singles?', '', ev, [], { quantity: 2 })!.lead).toBe('Start with MRAK on Sat, Oct 10: that’s the concert ticket for that night on its own.');
  });
});
