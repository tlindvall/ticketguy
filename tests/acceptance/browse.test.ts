import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW, FX } from '@/lib/fixtures';
import { TicketmasterDiscoveryAdapter } from '@/lib/sources/adapters';

/**
 * The first real "what's on" email — "I'm coming to New York and want to see some music gigs during the first
 * week on october. What options do I have?" — was answered with three questions: which event, how many
 * tickets, and which calendar date "the first week on october" means. These pin the browse answer instead.
 */
async function interpretAll(h: DbHandle, c: ReturnType<typeof makeConcierge>) {
  for (let i = 0; i < 5; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
    const work = leased.filter((ev) => ev.eventType === 'request.interpret');
    if (!work.length) return;
    for (const ev of work) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
}

const BROOKLYN_STEEL = '10000000-0000-4000-8000-0000000000c1';
const CHICAGO_HALL = '10000000-0000-4000-8000-0000000000c2';
const JACK_WHITE = '20000000-0000-4000-8000-0000000000c1';
const PHOEBE = '20000000-0000-4000-8000-0000000000c2';
const CHICAGO_ACT = '20000000-0000-4000-8000-0000000000c3';

describe('browsing: "what’s on?" gets what’s on', () => {
  let h: DbHandle;
  const lastSend = async (requestId: string) => {
    const rows = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
    return rows.at(-1)!;
  };
  const ask = async (c: ReturnType<typeof makeConcierge>, text: string, from: string, over: Record<string, unknown> = {}) => {
    const r = await c.ingestInbound(inbound({ text, from, subject: 'Gigs', ...over }));
    await interpretAll(h, c);
    return (r as { requestId: string }).requestId;
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: BROOKLYN_STEEL, name: 'Brooklyn Steel', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York' },
      { id: CHICAGO_HALL, name: 'Thalia Hall', city: 'Chicago', state: 'IL', country: 'US', timezone: 'America/Chicago' },
    ]);
    await h.db.insert(t.entities).values([
      { id: JACK_WHITE, kind: 'artist', name: 'Jack White', slug: 'jack-white', aliases: [], league: null, homeVenueId: null },
      { id: PHOEBE, kind: 'artist', name: 'Phoebe Bridgers', slug: 'phoebe-bridgers', aliases: [], league: null, homeVenueId: null },
      { id: CHICAGO_ACT, kind: 'artist', name: 'Chicago Band', slug: 'chicago-band', aliases: [], league: null, homeVenueId: null },
    ]);
    const ev = (name: string, venueId: string, entity: string, at: string, extra: Record<string, unknown> = {}) => ({ name, category: 'concert', venueId, primaryEntityId: entity, isHome: null, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, ...extra });
    await h.db.insert(t.events).values([
      ev('Jack White', FX.venues.msg, JACK_WHITE, '2026-10-02T23:30:00Z'),
      // The provider lists the same show twice (a package variant with the same name); one line is enough.
      ev('Jack White', FX.venues.msg, JACK_WHITE, '2026-10-02T23:30:00Z'),
      ev('Phoebe Bridgers', BROOKLYN_STEEL, PHOEBE, '2026-10-06T00:00:00Z'), // Mon Oct 5, 8pm in New York
      ev('Chicago Band', CHICAGO_HALL, CHICAGO_ACT, '2026-10-03T01:00:00Z'), // not New York
      ev('Jack White', FX.venues.msg, JACK_WHITE, '2026-10-09T23:30:00Z'), // outside the first week
      ev('Jack White Parking', FX.venues.msg, JACK_WHITE, '2026-10-02T22:00:00Z', { subtype: 'parking' }), // not a ticket to the show
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers the original email with the shows that week, and asks nothing up front', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, "Hello -\n\nI'm coming to New York and want to see some music gigs during the first week on october. What options do I have?", 'tobias@customer.example');
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('needs_clarification');
    const send = await lastSend(requestId);
    const body = send.bodyText;
    expect(body).toContain('Live music in New York, Oct 1–7 — here’s what’s on:');
    expect(body).toContain('• Fri, Oct 2 — Jack White at Madison Square Garden');
    expect(body).toContain('• Mon, Oct 5 — Phoebe Bridgers at Brooklyn Steel');
    expect(body.match(/Jack White at/g)).toHaveLength(1); // duplicate, parking and next week's show left out
    expect(body).not.toContain('Chicago');
    expect(body).toContain('Reply with the one you want and how many tickets');
    // None of the three questions the first reply asked.
    expect(body).not.toContain('How many tickets do you need');
    expect(body).not.toContain('calendar date');
    expect(body).not.toContain('Which event');
    // Place and dates were both given, so nothing was assumed.
    expect(body).not.toContain("I've looked at");
    expect(send.subject).toBe('Re: Gigs'); // the customer's subject, so the reply threads
  });

  it('picking one from the list goes on to the ordinary request', async () => {
    const c = makeConcierge(h);
    const first = inbound({ text: 'What concerts are on in NYC the first week of October?', from: 'pick@customer.example', subject: 'Concerts' });
    const r = await c.ingestInbound(first);
    await interpretAll(h, c);
    const reply = await c.ingestInbound(inbound({ text: 'Jack White please, 2 tickets together, up to $300 total.', from: 'pick@customer.example', subject: 'Re: Concerts', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(h, c);
    expect((reply as { requestId: string }).requestId).toBe((r as { requestId: string }).requestId);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, (r as { requestId: string }).requestId));
    const [event] = await h.db.select().from(t.events).where(eq(t.events.id, req!.eventId!));
    expect(event!.name).toBe('Jack White'); // bound to the show in the week browsed, not next week's
    expect(event!.localStartAt.toISOString()).toBe('2026-10-02T23:30:00.000Z');
  });

  it('says what it assumed when no dates or place were given', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any hockey games coming up?', 'hockey@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toMatch(/^Hey,\n\nHockey in New York, Sep 22 – Oct 5 — here’s what’s on:/);
    expect(body).toContain("I've looked at the next two weeks, in New York — tell me if you had something else in mind.");
    expect(body).toContain('New York Rangers vs. New York Islanders (preseason) at Madison Square Garden');
  });

  it('is honest when nothing is on file for the dates', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any gigs in New York the last week of November?', 'empty@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain("I don't have any live music in New York on file for Nov 24–30.");
    expect(body).toContain('Want me to look at different dates, or is there an artist or a kind of music you have in mind?');
    expect(body).not.toContain('official listings'); // no provider was asked, so no claim that it was
  });

  it('tells the customer plainly when the place or the kind of event is outside the pilot', async () => {
    const c = makeConcierge(h);
    const chicago = await ask(c, 'What concerts are on in Chicago next week?', 'chi@customer.example');
    expect((await lastSend(chicago)).bodyText).toContain('For now I only cover events in the New York area.');
    const theater = await ask(c, 'Any good Broadway musicals on next week?', 'bway@customer.example');
    expect((await lastSend(theater)).bodyText).toContain('For now I only cover concerts and NHL, NBA, MLB and NFL games in New York.');
  });

  it('answers "an american football game" with the NFL games that week, not every sport', async () => {
    const METLIFE = '10000000-0000-4000-8000-0000000000c5';
    await h.db.insert(t.venues).values({ id: METLIFE, name: 'MetLife Stadium', city: 'East Rutherford', state: 'NJ', country: 'US', timezone: 'America/New_York' });
    const nfl = (name: string, at: string, extra: Record<string, unknown> = {}) => ({ name, category: 'nfl', venueId: METLIFE, primaryEntityId: null, isHome: null, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, ...extra });
    await h.db.insert(t.events).values([
      nfl('New York Giants vs. Philadelphia Eagles', '2026-10-11T17:00:00Z'),
      nfl('Parking: New York Giants vs. Philadelphia Eagles', '2026-10-11T17:00:00Z', { subtype: 'parking' }),
      nfl('New York Jets vs. Buffalo Bills', '2026-10-25T17:00:00Z'),
    ]);
    const c = makeConcierge(h);
    const requestId = await ask(c, 'I want to see an american football game in or near new york the second week of october. Anything interesting? We need 4 tickets.', 'nfl@customer.example', { subject: 'American football' });
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('needs_clarification');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain('Football in New York, Oct 8–14 — here’s what’s on:');
    expect(body).toContain('• Sun, Oct 11 — New York Giants vs. Philadelphia Eagles at MetLife Stadium');
    expect(body).not.toContain('Parking');
    expect(body).not.toContain('Jets'); // outside the week asked for
    expect(body).not.toContain('Yankees');
    expect(body).not.toContain("isn't something I cover");
  });

  it('offers the next games when the week asked for has none', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any NFL games in New York Oct 12-18?', 'nfl-later@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain('Football in New York: nothing on Oct 12–18, but here are the next ones after that:');
    expect(body).toContain('• Sun, Oct 25 — New York Jets vs. Buffalo Bills at MetLife Stadium');
  });

  it('shows one line per game when the provider lists premium and package versions of it', async () => {
    const STADIUM = '10000000-0000-4000-8000-0000000000c3';
    await h.db.insert(t.venues).values({ id: STADIUM, name: 'Yankee Stadium', city: 'Bronx', state: 'NY', country: 'US', timezone: 'America/New_York' });
    const game = (name: string, at = '2026-10-08T23:08:00Z') => ({ name, category: 'mlb', venueId: STADIUM, primaryEntityId: null, isHome: null, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
    await h.db.insert(t.events).values([
      game('Pinstripe Pass * 2026 NY Yankees Division Series Home Game 2'),
      game('2026 NY Yankees Division Series Home Game 2 * Premium Seating *'),
      game('2026 NY Yankees Division Series Home Game 2'),
      game('2026 NY Yankees Division Series Home Game 3', '2026-10-09T23:08:00Z'),
    ]);
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any baseball in New York Oct 8-9?', 'mlb@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain('• Thu, Oct 8 — 2026 NY Yankees Division Series Home Game 2 at Yankee Stadium');
    expect(body).toContain('• Fri, Oct 9 — 2026 NY Yankees Division Series Home Game 3 at Yankee Stadium');
    expect(body).not.toContain('Premium Seating');
    expect(body).not.toContain('Pinstripe Pass');
  });

  it('suggests a team, not an artist, when no games are on file', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any basketball games in New York the last week of November?', 'nba-empty@customer.example');
    expect((await lastSend(requestId)).bodyText).toContain('Want me to look at different dates, or is there a team you have in mind?');
  });

  it('narrows the list when the reply names a kind of music and a borough', async () => {
    const PIANOS = '10000000-0000-4000-8000-0000000000c4';
    await h.db.insert(t.venues).values({ id: PIANOS, name: 'Union Pool', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York' });
    const show = (name: string, venueId: string, at: string, genre: string | null) => ({ name, category: 'concert', genre, venueId, primaryEntityId: null, isHome: null, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
    await h.db.insert(t.events).values([
      show('The Walkmen', PIANOS, '2026-10-03T01:00:00Z', 'rock / indie rock'),
      show('Big Thief', BROOKLYN_STEEL, '2026-10-04T00:30:00Z', 'alternative / alternative rock'),
      show('Brooklyn Jazz Trio', PIANOS, '2026-10-05T00:30:00Z', 'jazz'),
      show('Manhattan Indie Night', FX.venues.msg, '2026-10-03T00:30:00Z', 'rock'),
    ]);
    const c = makeConcierge(h);
    const first = inbound({ text: "I'm coming to New York and want to see some music gigs during the first week on october. What options do I have?", from: 'indie@customer.example', subject: 'Gigs' });
    const r = await c.ingestInbound(first);
    await interpretAll(h, c);
    await c.ingestInbound(inbound({ text: 'I like indie rock and roll. We are staying in brooklyn.', from: 'indie@customer.example', subject: 'Re: Gigs', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(h, c);
    const body = (await lastSend((r as { requestId: string }).requestId)).bodyText;
    expect(body).toContain('Rock and indie in Brooklyn, Oct 1–7 — here’s what’s on:');
    expect(body).toContain('The Walkmen at Union Pool');
    expect(body).toContain('Big Thief at Brooklyn Steel');
    expect(body).not.toContain('Jazz Trio'); // Brooklyn, but not the music asked for
    expect(body).not.toContain('Manhattan Indie Night'); // the music, but not Brooklyn
    expect(body).not.toContain('Jack White');
    expect(body).toContain("I've kept it to Brooklyn venues — say if you'd go further.");
    expect(body).not.toContain("kind of music and I'll narrow"); // the kind of music is already known
  });

  it('says so, and shows what is on, when nothing on file is the music asked for', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any reggaeton gigs in Brooklyn the first week of October?', 'latin@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain('Live music in Brooklyn, Oct 1–7 — here’s what’s on:');
    expect(body).toContain("I couldn't find any Latin music listed for those dates, so here's everything that's on.");
  });

  it('asks the provider by classification and place, with no keyword', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ _embedded: { events: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new TicketmasterDiscoveryAdapter('key', true, fetchImpl);
    await adapter.discoverEvents({ keyword: '', classificationName: 'music', city: 'Brooklyn', startDateTime: '2026-10-01T00:00:00Z', endDateTime: '2026-10-08T12:00:00Z' });
    const q = new URL(urls[0]!).searchParams;
    expect(q.get('classificationName')).toBe('music');
    expect(q.get('city')).toBe('Brooklyn');
    expect(q.has('keyword')).toBe(false);
  });
});
