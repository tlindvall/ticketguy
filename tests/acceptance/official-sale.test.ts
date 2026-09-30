import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import { AFFILIATE_DISCLOSURE } from '@/lib/email/links';
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
    expect(send!.bodyText).toContain("Metro Testers vs. Boston (Fri, Oct 30 at 7:30pm at Test Garden) is still on general sale on Ticketmaster, and that's where I'd buy your 4 tickets.");
    expect(send!.bodyText).toContain(`Buy tickets on Ticketmaster: ${URL_OPEN}`);
    expect(send!.bodyText).toContain('Games that aren\'t sold out often go for less on resale. Want me to compare? Just reply "compare".');
    expect(send!.bodyText).not.toMatch(/\$\d/); // never a price

    // "compare" opens the resale comparison on the same request.
    await c.ingestInbound(inbound({ text: 'compare', from: 'official@customer.example', subject: 'Re: Testers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(c);
    expect(await stateOf(requestId)).toBe('researching');
    expect(await researchQueued(requestId)).toBe(1);
    expect((await sendsFor(requestId)).map((s) => s.bodyText).join('\n')).toContain('Game: Metro Testers vs. Boston');
  });

  it('uses the affiliate link when one is configured, says so, and recommends exactly the same thing', async () => {
    const env = testEnv({ AFFILIATE_LINK_TEMPLATES: JSON.stringify({ Ticketmaster: 'https://aff.example/c/1?u={url}' }) });
    const r = await makeConcierge(h, { env }).ingestInbound(inbound({ text: '4 Testers tickets Oct 30', from: 'affiliate@customer.example', subject: 'Testers' }));
    await interpretAll(makeConcierge(h, { env }));
    const requestId = (r as { requestId: string }).requestId;
    const [send] = await sendsFor(requestId);
    expect(send!.bodyText).toContain('Metro Testers vs. Boston'); // the same event as without the affiliate format
    expect(send!.bodyText).toContain(`Buy tickets on Ticketmaster: https://aff.example/c/1?u=${encodeURIComponent(URL_OPEN)}`);
    expect(send!.bodyText).toContain(AFFILIATE_DISCLOSURE);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.eventId).toBe(ids.open);
  });

  it('keeps the buying email to one recommendation and one seller link, even when the team has a page', async () => {
    await h.db.update(t.entities).set({ links: { official: 'https://www.metro-testers.example' } }).where(eq(t.entities.id, TEAM));
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: '2 Testers tickets Oct 30', from: 'teampage@customer.example', subject: 'Testers' }));
    await interpretAll(c);
    const [send] = await sendsFor((r as { requestId: string }).requestId);
    expect(send!.bodyText).not.toContain('metro-testers.example');
    expect(send!.bodyHtml.match(/<a href=/g)?.length).toBe(3); // the event page, the seller, and the signature's own link
    expect(send!.bodyText).not.toContain(AFFILIATE_DISCLOSURE);
  });

  it('a discovery email links each pick to its own page and the event\'s ticket page, not to our site', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Any basketball games in New York Oct 29-31?', from: 'browse-links@customer.example', subject: 'Hoops' }));
    await interpretAll(c);
    const [send] = await sendsFor((r as { requestId: string }).requestId);
        expect(send!.bodyText).toContain('• Fri, Oct 30: Metro Testers vs. Boston at Test Garden. Home game against Boston.');
    expect(send!.bodyText).toContain('Team page: https://www.metro-testers.example');
    expect(send!.bodyText).toContain(`Tickets: ${URL_OPEN}`);
    expect(send!.bodyHtml).toContain(`href="${URL_OPEN}"`);
  });

  it('a comedy show on general sale gets the drink-minimum note at a club, not at an arena', async () => {
    const COMIC = '20000000-0000-4000-8000-0000000000e2';
    const SHOW = '30000000-0000-4000-8000-0000000000e9';
    await h.db.insert(t.entities).values({ id: COMIC, kind: 'performer', name: 'Testy McJokes', slug: 'testy-mcjokes', aliases: [], league: null, homeVenueId: null });
    await h.db.insert(t.events).values({ id: SHOW, name: 'Testy McJokes', category: 'comedy', venueId: ARENA, primaryEntityId: COMIC, isHome: null, localStartAt: new Date('2026-10-17T00:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), publicSaleEndAt: null });
    await h.db.insert(t.eventSourceMappings).values({ eventId: SHOW, sourceId: 'ticketmaster', sourceEventId: 'JOKE1', authoritativeUrl: 'https://www.ticketmaster.com/x/event/JOKE1', role: 'discovery', confidence: 'provider_id' });
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: '2 tickets for Testy McJokes Oct 16', from: 'comedy@customer.example', subject: 'Comedy' }));
    await interpretAll(c);
    const [send] = await sendsFor((r as { requestId: string }).requestId);
    expect(send!.bodyText).toContain('is still on general sale on Ticketmaster');
    // An arena has no drink minimum: the club boilerplate only where it applies (TGQA-R6 writing review).
    expect(send!.bodyText).not.toContain('Comedy clubs often add a drink or food minimum');
    expect(send!.bodyText).toContain("Events that aren't sold out often go for less on resale.");
    const CLUB = '10000000-0000-4000-8000-0000000000e3';
    await h.db.insert(t.venues).values({ id: CLUB, name: 'Test Comedy Cellar', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.update(t.events).set({ venueId: CLUB }).where(eq(t.events.id, SHOW));
    const r2 = await c.ingestInbound(inbound({ text: '2 tickets for Testy McJokes Oct 16', from: 'comedy2@customer.example', subject: 'Comedy' }));
    await interpretAll(c);
    const [send2] = await sendsFor((r2 as { requestId: string }).requestId);
    expect(send2!.bodyText).toContain("Comedy clubs often add a drink or food minimum on top of the ticket, so check the venue's page before you go.");
  });

  it('"is $106 a good deal?" is answered against face value and the official sale, not with a list of our integrations', async () => {
    await h.db.update(t.events).set({ faceMinCents: 5500, faceMaxCents: 9500 }).where(eq(t.events.id, ids.open));
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Is $106 for the Testers Oct 30 a good deal?', from: 'quote@customer.example', subject: 'Price check' }));
    await interpretAll(c);
    const requestId = (r as { requestId: string }).requestId;
    const [v] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId));
    expect((v!.brief as { quotedPriceCents: number; budgetCents: number | null }).quotedPriceCents).toBe(10600);
    expect((v!.brief as { budgetCents: number | null }).budgetCents).toBeNull(); // a price they saw is not their budget
    expect(await stateOf(requestId)).toBe('researching'); // the full answer, not the bare official-sale pointer
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    const body = rec!.bodyText;
    expect(body).toContain('You mentioned $106 (I’ve taken that as per ticket). That’s a little above the face value Ticketmaster lists ($55 to $95 a ticket before fees); fees alone can add that much, so it may be close to the original price all-in.');
    // No resale in the email, so no "unless a resale seat is cheaper" hedge.
    expect(body).toContain('It’s on general sale on Ticketmaster, and that’s where I’d buy.');
    expect(body).not.toContain('unless a resale seat');
    expect(body).toContain(`Buy on Ticketmaster: ${URL_OPEN}`);
    for (const noise of ['not integrated', 'packet', 'check primary', 'marketplaces directly', 'Sources checked']) expect(body, noise).not.toContain(noise);
    // No listing was offered, so nothing needs a person's judgement: it goes out without review, and says so.
    expect(rec!.reviewStatus).toBe('auto_sent');
    expect(body).not.toContain('human-reviewed');
    const sends = await sendsFor(requestId);
    const answer = sends.filter((s) => s.messageClass === 'no_result');
    expect(answer).toHaveLength(1);
    expect(answer[0]!.bodyText).toContain('You mentioned $106');
    expect(answer[0]!.approvalId).toBeNull();
    expect(await stateOf(requestId)).toBe('recommendation_sent');
  });

  it('goes straight to the comparison when resale is asked about up front', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: '2 Testers tickets Oct 30 — is resale cheaper?', from: 'resale@customer.example', subject: 'Testers' }));
    await interpretAll(c);
    const requestId = (r as { requestId: string }).requestId;
    expect(await stateOf(requestId)).toBe('researching');
    expect(await researchQueued(requestId)).toBe(1);
    // The acknowledgment names the resolved game once, and promises no comparison it may not be able to make.
    const ack = (await sendsFor(requestId)).find((s) => s.messageClass === 'acknowledgment')!.bodyText;
    expect(ack).toContain('Metro Testers vs. Boston');
    expect(ack).not.toContain('Event:');
    expect(ack).not.toContain('reviewed the comparison');
    expect(ack).toContain('Tickets: 2');
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

  // TG-B01 (audit A05, Hamilton): "that's where I'd buy your 3 tickets" with a $450 total and access needs,
  // while the cheapest 3 on the page were $476. The sale being open is not a seat: nothing is endorsed, the
  // needs are listed as still to check, and the page's default of 2 tickets is called out.
  it('an open sale never stands in for their seats, budget or access: it lists what to check instead', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: '3 Testers tickets Oct 30, together, $450 total. We need wheelchair accessible seats.', from: 'hard@customer.example', subject: 'Testers for three' }))) as { requestId: string };
    await interpretAll(c);
    const [send] = await sendsFor(r.requestId);
    const body = send!.bodyText;
    expect(body).not.toMatch(/where I'd buy/);
    expect(body).toContain('is on general sale on Ticketmaster. I haven’t seen its seats or prices, so I can’t tell you yet whether any fit what you need.');
    expect(body).toContain('Check these on the event page before you buy (set the number of tickets to 3 first; the page may start at 2):');
    expect(body).toContain('- 3 seats together');
    expect(body).toContain('- $450 in total for all 3, once fees are added');
    expect(body).toMatch(/- Wheelchair/);
    expect(body).toContain('Event page on Ticketmaster:');
  });
});
