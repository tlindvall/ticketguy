import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { BEST_OPEN_ASK } from '@/lib/intake/pipeline';

/**
 * Live, Oct 9 2026: "Find me the best Metallica tickets" (an act, no count, no date) got a menu of dates and three
 * questions. The goal and the party are what decide the answer, so they are the one question, and the answer goes on as
 * an ordinary request. A team with no date still takes its next home game.
 */
const now = FIXTURE_NOW; // Sep 22, 2026
const ARENA = '10000000-0000-4000-8000-0000000000f1';
const BAND = '20000000-0000-4000-8000-0000000000f1';
const TEAM = '20000000-0000-4000-8000-0000000000f2';
const SHOW = '30000000-0000-4000-8000-0000000000f1';
const GAME = '30000000-0000-4000-8000-0000000000f2';

describe('"the best tickets" for an act is one question: the goal and the party', () => {
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
  const sends = async (requestId: string) => h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Garden Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values([
      { id: BAND, kind: 'artist', name: 'Metal Giants', slug: 'metal-giants', aliases: [], league: null, homeVenueId: null },
      { id: TEAM, kind: 'team', name: 'Metro Rangers', slug: 'metro-rangers-bt', aliases: ['Metro Rangers'], league: 'NHL', homeVenueId: ARENA },
    ]);
    await h.db.insert(t.events).values([
      { id: SHOW, name: 'Metal Giants', category: 'concert', venueId: ARENA, primaryEntityId: BAND, isHome: null, localStartAt: new Date('2026-10-20T00:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' },
      { id: GAME, name: 'Metro Rangers vs. Boston Bruins', category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-10-05T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' },
    ]);
    await h.db.update(t.adapterConfigs).set({ enabled: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it('asks the one question, no menu and no default pick, and the answer goes on as an ordinary request', async () => {
    const c = makeConcierge(h);
    const first = inbound({ text: 'Find me the best Metal Giants tickets', from: 'best@customer.example', subject: 'Metal Giants' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    expect(await interpretAll(c)).toEqual([]);
    const [one] = await sends(r.requestId);
    expect(one!.messageClass).toBe('clarification');
    expect(one!.bodyText).toContain(BEST_OPEN_ASK);
    expect(one!.bodyText.match(/\?/g)).toHaveLength(1); // the only question
    expect(one!.bodyText).not.toMatch(/Which .* date and venue|How many tickets do you need|the lowest price\?|I've assumed two tickets|Which show/);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('needs_clarification');
    // Answered: an ordinary request from here, never the question again.
    await c.ingestInbound(inbound({ text: 'Best view, 2 tickets', from: 'best@customer.example', subject: 'Re: Metal Giants', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    expect(await interpretAll(c)).toEqual([r.requestId]);
    const [after] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(after!.eventId).toBe(SHOW);
    expect((await sends(r.requestId)).filter((s) => s.bodyText.includes(BEST_OPEN_ASK))).toHaveLength(1);
  });

  it('a team with no date still takes its next home game', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Find me the best metro rangers tickets', from: 'team@customer.example', subject: 'Rangers' }))) as { requestId: string };
    await interpretAll(c);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(GAME);
    expect((await sends(r.requestId)).map((s) => s.bodyText).join('\n')).not.toContain(BEST_OPEN_ASK);
  });
});
