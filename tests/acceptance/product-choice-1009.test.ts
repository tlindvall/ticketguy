import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
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
const CLUB = '10000000-0000-4000-8000-0000000000a8';
const NIGHT = '30000000-0000-4000-8000-0000000000a8';
const DJ = '20000000-0000-4000-8000-0000000000a8';

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
    // The live case's depth: a club night, Guide under enforce, where the official-seller route would otherwise answer.
    await h.db.insert(t.venues).values({ id: CLUB, name: 'Basement Club', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: DJ, kind: 'artist', name: 'Nightshift Collective', slug: 'nightshift-collective', aliases: [], league: null, homeVenueId: null });
    await h.db.insert(t.events).values({ id: NIGHT, name: 'Nightshift Collective', category: 'club_concert', venueId: CLUB, primaryEntityId: DJ, isHome: null, localStartAt: new Date('2026-10-18T03:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
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
    // No prices in the thread: the pack first, in the framework's words, never "cheaper" without figures, each caveat once (Oct 10 review: "looks best",
    // then a paragraph saying there was nothing to base it on, and the terms caveat three times).
    expect(body).toContain('Hey,\n\nThe four-pack looks best for your group, provided its entry conditions suit you.\n\nWhether it works out cheaper per person than four GA tickets depends on two prices I haven’t seen: compare the pack with four singles at checkout, or send me both and I’ll check. Before you buy, confirm the pack’s admission terms (who it admits, whether everyone has to enter together, and any age or ID rule).');
    expect(body).not.toMatch(/cheaper per person than four GA tickets\./);
    // Each caveat once in the reply (the signature's "before you buy" is not a caveat).
    expect(body).not.toMatch(/Before you buy,.*Before you buy,|haven’t seen.*haven’t seen/s);
    expect(body.match(/haven’t seen/g)).toHaveLength(1);
    expect(body).not.toMatch(/resale|trend|going up|going down|buy now or wait|On buy or wait|\$\d|[–—]/);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('recommendation_sent');
    expect(req!.eventId).toBe(SHOW);
  });

  it('under enforce, a Guide-depth club night still gets the product answer, not the official-seller referral', async () => {
    // Oct 10 review: the Guide route's bypass for a ticket-type choice ran only in shadow mode in the suite.
    const c = makeConcierge(h, { env: testEnv({ SERVICE_POLICY_MODE: 'enforce' }) });
    const r = (await c.ingestInbound(inbound({ text: 'Which ticket should four of us buy for Nightshift Collective on Oct 17, the four-pack or GA? The four-pack is $200 and GA is $60 each.', from: 'club@customer.example', subject: 'MRAK club' }))) as { requestId: string };
    expect(await interpretAll(c)).toEqual([]);
    const [v] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.bodyText).toContain('The four-pack is the better buy for your group on the figures you gave: $50 each against $60 for GA.');
    expect(sends[0]!.bodyText).not.toMatch(/official seller|on general sale/);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(NIGHT);
    expect(req!.state).toBe('recommendation_sent');
    expect(v).toBeDefined();
  });

  it('cheaper per person is said only on the customer’s own figures, each way', () => {
    const ev = { name: 'MRAK', when: 'Sat, Oct 10' };
    expect(asksProductChoice('Which MRAK ticket should four of us buy, the four-pack or GA?')).toBe(true);
    expect(asksProductChoice('Which MRAK ticket should four of us buy?')).toBe(false); // no ticket type named: nothing to choose between
    expect(asksProductChoice('Four of us are going to MRAK, how much are tickets?')).toBe(false);
    // The verdict carries its reason from their figures; the next step is one line, its caveat said once.
    const cheaper = productChoiceAnswer('Which MRAK ticket should four of us buy? The four-pack is $200 and GA is $60 each.', '', ev, [], { quantity: 4 })!;
    expect(cheaper.lead).toBe('The four-pack is the better buy for your group on the figures you gave: $50 each against $60 for GA.');
    expect(cheaper.items).toEqual(['Before you buy, confirm the pack’s admission terms (who it admits, whether everyone has to enter together, and any age or ID rule) and the fees at checkout, which I haven’t seen for MRAK on Sat, Oct 10.']);
    const dearer = productChoiceAnswer('Which MRAK ticket should four of us buy? The four-pack is $280 and GA is $60 each.', '', ev, [], { quantity: 4 })!;
    expect(dearer.lead).toBe('Four individual GA tickets are the better buy for your group on the figures you gave: the four-pack works out at $70 each against $60.');
    expect(dearer.items).toEqual(['Before you buy, check the fees at checkout, which I haven’t seen for MRAK on Sat, Oct 10.']);
    // A pack for a different party size is not their pack: the ordinary product answer.
    expect(productChoiceAnswer('Which MRAK ticket should we buy, the four-pack or singles?', '', ev, [], { quantity: 2 })!.lead).toBe('Start with MRAK on Sat, Oct 10: that’s the concert ticket for that night on its own.');
  });
});
