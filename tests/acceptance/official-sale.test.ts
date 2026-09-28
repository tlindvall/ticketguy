import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { officialSellerFor } from '@/lib/intake/pipeline';
import { FIXTURE_NOW } from '@/lib/fixtures';

/**
 * Buy/wait is resale advice. An event still on general sale at the official seller is answered with that sale,
 * a line saying resale can be cheaper when it is not sold out, and "compare" to get the comparison.
 */
describe('still on general sale: point at the official sale', () => {
  let h: DbHandle;
  const ARENA = '10000000-0000-4000-8000-0000000000e1';
  const TEAM = '20000000-0000-4000-8000-0000000000e1';
  const ids = { open: '30000000-0000-4000-8000-0000000000e1', notYet: '30000000-0000-4000-8000-0000000000e2', offsale: '30000000-0000-4000-8000-0000000000e3' };
  const URL_OPEN = 'https://www.ticketmaster.com/metro-testers-vs-boston-new-york-ny-10-30-2026/event/ABC123';

  const interpretAll = async (c: ReturnType<typeof makeConcierge>) => {
    for (let i = 0; i < 5; i++) {
      const work = (await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW })).filter((ev) => ev.eventType === 'request.interpret');
      if (!work.length) return;
      for (const ev of work) {
        const p = ev.payload as Record<string, string>;
        await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
  };
  const researchQueued = async (requestId: string) => (await h.db.select().from(t.outboxEvents).where(and(eq(t.outboxEvents.eventType, 'research.requested'), eq(t.outboxEvents.entityId, requestId)))).length;
  const sendsFor = (requestId: string) => h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
  const stateOf = async (requestId: string) => (await h.db.select().from(t.requests).where(eq(t.requests.id, requestId)))[0]!.state;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Test Garden', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Testers', slug: 'metro-testers', aliases: ['Testers'], league: 'NBA', homeVenueId: ARENA });
    const game = (id: string, name: string, at: string, sale: Record<string, unknown>) => ({ id, name, category: 'nba', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, ...sale });
    await h.db.insert(t.events).values([
      game(ids.open, 'Metro Testers vs. Boston', '2026-10-30T23:30:00Z', { saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), publicSaleEndAt: new Date('2026-10-30T23:00:00Z') }),
      game(ids.notYet, 'Metro Testers vs. Chicago', '2026-11-12T00:30:00Z', { saleStatus: 'onsale', publicSaleStartAt: new Date('2026-10-01T14:00:00Z'), publicSaleEndAt: null }),
      game(ids.offsale, 'Metro Testers vs. Denver', '2026-11-20T00:30:00Z', { saleStatus: 'offsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), publicSaleEndAt: null }),
    ]);
    await h.db.insert(t.eventSourceMappings).values([
      { eventId: ids.open, sourceId: 'ticketmaster', sourceEventId: 'ABC123', authoritativeUrl: URL_OPEN, role: 'discovery', confidence: 'provider_id' },
      { eventId: ids.notYet, sourceId: 'ticketmaster', sourceEventId: 'DEF456', authoritativeUrl: 'https://www.ticketmaster.com/x/event/DEF456', role: 'discovery', confidence: 'provider_id' },
      { eventId: ids.offsale, sourceId: 'ticketmaster', sourceEventId: 'GHI789', authoritativeUrl: 'https://www.ticketmaster.com/x/event/GHI789', role: 'discovery', confidence: 'provider_id' },
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers with the official sale and an offer to compare, and runs no research', async () => {
    const c = makeConcierge(h);
    const first = inbound({ text: '4 Testers tickets Oct 30', from: 'official@customer.example', subject: 'Testers' });
    const r = await c.ingestInbound(first);
    await interpretAll(c);
    const requestId = (r as { requestId: string }).requestId;
    expect(await stateOf(requestId)).toBe('referred');
    expect(await researchQueued(requestId)).toBe(0);
    const [send] = await sendsFor(requestId);
    expect(send!.messageClass).toBe('acknowledgment'); // no prices, so no review gate
    expect(send!.bodyText).toContain('Metro Testers vs. Boston — Test Garden, New York');
    expect(send!.bodyText).toContain('is still on general sale on Ticketmaster, so that\'s the place to start for your 4 tickets.');
    expect(send!.bodyText).toContain(`Ticketmaster: ${URL_OPEN}`);
    expect(send!.bodyText).toContain('Games that aren\'t sold out often go for less on resale. Want me to compare? Just reply "compare".');
    expect(send!.bodyText).not.toMatch(/\$\d/); // never a price

    // "compare" opens the resale comparison on the same request.
    await c.ingestInbound(inbound({ text: 'compare', from: 'official@customer.example', subject: 'Re: Testers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(c);
    expect(await stateOf(requestId)).toBe('researching');
    expect(await researchQueued(requestId)).toBe(1);
    expect((await sendsFor(requestId)).map((s) => s.bodyText).join('\n')).toContain('checking options for Metro Testers vs. Boston');
  });

  it('goes straight to the comparison when resale is asked about up front', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: '2 Testers tickets Oct 30 — is resale cheaper?', from: 'resale@customer.example', subject: 'Testers' }));
    await interpretAll(c);
    const requestId = (r as { requestId: string }).requestId;
    expect(await stateOf(requestId)).toBe('researching');
    expect(await researchQueued(requestId)).toBe(1);
  });

  it('does not point at a sale that has not opened or has closed', async () => {
    const c = makeConcierge(h);
    for (const [text, from] of [['2 Testers tickets Nov 11', 'notyet@customer.example'], ['2 Testers tickets Nov 19', 'offsale@customer.example']] as const) {
      const r = await c.ingestInbound(inbound({ text, from, subject: 'Testers' }));
      await interpretAll(c);
      const requestId = (r as { requestId: string }).requestId;
      expect(await stateOf(requestId), text).toBe('researching');
      expect((await sendsFor(requestId)).map((s) => s.bodyText).join('\n'), text).not.toContain('general sale');
    }
  });

  it('only links the provider\'s own sale pages', () => {
    expect(officialSellerFor(URL_OPEN)).toBe('Ticketmaster');
    expect(officialSellerFor('https://concerts.livenation.com/event/1')).toBe('Live Nation');
    expect(officialSellerFor('http://www.ticketmaster.com/event/1')).toBeNull();
    expect(officialSellerFor('https://www.ticketmaster.com.evil.example/event/1')).toBeNull();
    expect(officialSellerFor('https://www.stubhub.com/event/1')).toBeNull();
    expect(officialSellerFor(null)).toBeNull();
  });
});
