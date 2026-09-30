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
    expect(body).toContain('Live music in New York, Oct 1 to 7. Here are my two picks:');
    expect(body).toContain('• Fri, Oct 2: Jack White at Madison Square Garden');
    expect(body).toContain('• Mon, Oct 5: Phoebe Bridgers at Brooklyn Steel');
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
    expect(body).toMatch(/^Hey,\n\nHockey in New York, Sep 22 to Oct 5. There’s one on:/);
    expect(body).toContain('Want me to check prices? Just tell me how many tickets.'); // one option is not "the one you want"
    expect(body).not.toContain('Reply with the one you want');
    expect(body).toContain("I've looked at the next two weeks, in New York. Tell me if you had something else in mind.");
    expect(body).toContain('New York Rangers vs. New York Islanders (preseason) at Madison Square Garden');
  });

  it('is honest when nothing is on file for the dates', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any gigs in New York the last week of November?', 'empty@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain("I don't have any live music in New York on file for Nov 24 to 30.");
    expect(body).toContain('Want me to look at different dates, or is there an artist or a kind of music you have in mind?');
    expect(body).not.toContain('official listings'); // no provider was asked, so no claim that it was
  });

  it('answers for any US city, and says plainly what is outside the US or not covered', async () => {
    const c = makeConcierge(h);
    const chicago = await ask(c, 'What concerts are on in Chicago next week?', 'chi@customer.example');
    const body = (await lastSend(chicago)).bodyText;
    expect(body).toContain('Live music in Chicago');
    expect(body).toContain('Chicago Band at Thalia Hall');
    expect(body).not.toContain('Jack White'); // a New York show is not a Chicago answer
    const london = await ask(c, 'What concerts are on in London next week?', 'ldn@customer.example');
    expect((await lastSend(london)).bodyText).toContain('For now I only cover events in the US.');
    const theater = await ask(c, 'Any good Broadway musicals on next week?', 'bway@customer.example');
    expect((await lastSend(theater)).bodyText).toContain('Theater in New York'); // covered now
    const soccer = await ask(c, 'Any soccer on next week?', 'soccer@customer.example');
    expect((await lastSend(soccer)).bodyText).toContain('Soccer in New York'); // everything the provider lists is covered unless blocked
    expect((await lastSend(soccer)).bodyText).not.toContain("isn't something I cover");
  });

  it('"LA" is the metro: Inglewood and Anaheim count, San Diego does not', async () => {
    const FORUM = '10000000-0000-4000-8000-0000000000f1';
    const HONDA = '10000000-0000-4000-8000-0000000000f2';
    const SD = '10000000-0000-4000-8000-0000000000f3';
    await h.db.insert(t.venues).values([
      { id: FORUM, name: 'Kia Forum', city: 'Inglewood', state: 'CA', country: 'US', timezone: 'America/Los_Angeles', latitude: 33.958, longitude: -118.3419 },
      { id: HONDA, name: 'Honda Center', city: 'Anaheim', state: 'CA', country: 'US', timezone: 'America/Los_Angeles', latitude: 33.8078, longitude: -117.8765 },
      { id: SD, name: 'Petco Park', city: 'San Diego', state: 'CA', country: 'US', timezone: 'America/Los_Angeles', latitude: 32.7076, longitude: -117.157 },
    ]);
    const show = (name: string, venueId: string, at: string) => ({ name, category: 'concert', genre: null, venueId, primaryEntityId: null, isHome: null, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
    await h.db.insert(t.events).values([show('Forum Headliner', FORUM, '2026-10-03T03:00:00Z'), show('Anaheim Act', HONDA, '2026-10-04T03:00:00Z'), show('San Diego Act', SD, '2026-10-03T03:00:00Z')]);
    const body = (await lastSend(await ask(makeConcierge(h), 'Any concerts in LA the first week of October?', 'la@customer.example'))).bodyText;
    expect(body).toContain('Live music in Los Angeles, Oct 1 to 7');
    expect(body).toContain('Forum Headliner at Kia Forum');
    expect(body).toContain('Anaheim Act at Honda Center');
    expect(body).not.toContain('San Diego Act');
    expect(body).not.toContain('Jack White');
  });

  it('a show that runs all week is one pick with its other dates, and the email says so', async () => {
    const THEATRE = '10000000-0000-4000-8000-0000000000f4';
    await h.db.insert(t.venues).values({ id: THEATRE, name: 'Richard Rodgers Theatre', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    const perf = (name: string, at: string) => ({ name, category: 'broadway', genre: 'theatre / musical', venueId: THEATRE, primaryEntityId: null, isHome: null, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
    await h.db.insert(t.events).values([
      perf('Hamilton', '2026-10-06T23:00:00Z'), perf('Hamilton', '2026-10-07T23:00:00Z'), perf('Hamilton', '2026-10-08T23:00:00Z'), perf('Hamilton', '2026-10-10T18:00:00Z'), perf('Hamilton', '2026-10-10T23:00:00Z'),
    ]);
    const body = (await lastSend(await ask(makeConcierge(h), 'Any Broadway musicals Oct 6-10?', 'hamilton@customer.example'))).bodyText;
    expect(body.match(/Hamilton at Richard Rodgers Theatre/g)).toHaveLength(1);
    expect(body).toContain('• Tue, Oct 6: Hamilton at Richard Rodgers Theatre. Musical. Also 3 more performances through Sat, Oct 10.');
    expect(body).not.toContain("gone ahead with it"); // one show over five nights is not one match: the night is theirs to pick
  });

  it('with no place named, looks where the customer asked last time, and says so', async () => {
    const c = makeConcierge(h);
    await ask(c, 'What concerts are on in Chicago next week?', 'regular@customer.example', { subject: 'Chicago' });
    const again = await ask(c, 'Any gigs next week?', 'regular@customer.example', { subject: 'More gigs' });
    const body = (await lastSend(again)).bodyText;
    expect(body).toContain('Chicago Band at Thalia Hall');
    expect(body).toContain("I've looked at Chicago. Tell me if you had something else in mind.");
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
    // One game that week is the answer, not a menu of one: it goes on to prices for the four tickets asked for.
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('researching');
    const [event] = await h.db.select().from(t.events).where(eq(t.events.id, req!.eventId!));
    expect(event!.name).toBe('New York Giants vs. Philadelphia Eagles');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain('Game: New York Giants vs. Philadelphia Eagles');
    expect(body).toContain('Where: MetLife Stadium');
    expect(body).toContain('Tickets: 4');
    expect(body).toContain("It's the only football game I found in New York for Oct 8 to 14, so I've gone ahead with it. Tell me if you had something else in mind.");
    expect(body).not.toContain('how many tickets');
    expect(body).not.toContain('Reply with the one you want');
    expect(body).not.toContain("isn't something I cover");
  });

  it('offers the next games when the week asked for has none', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any NFL games in New York Oct 12-18?', 'nfl-later@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain('Football in New York: nothing on Oct 12 to 18, but here are the next ones after that:');
    expect(body).toContain('• Sun, Oct 25: New York Jets vs. Buffalo Bills at MetLife Stadium');
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
    expect(body).toContain('• Thu, Oct 8: 2026 NY Yankees Division Series Home Game 2 at Yankee Stadium');
    expect(body).toContain('• Fri, Oct 9: 2026 NY Yankees Division Series Home Game 3 at Yankee Stadium');
    expect(body).not.toContain('Premium Seating');
    expect(body).not.toContain('Pinstripe Pass');
    expect(body).toContain('Reply with the one you want and how many tickets');
    const withCount = await ask(makeConcierge(h), 'Any baseball in New York Oct 8-9? We need 3 tickets.', 'mlb3@customer.example');
    const counted = (await lastSend(withCount)).bodyText;
    expect(counted).toContain('Reply with the one you want, and I’ll check prices for 3 tickets.'); // the number they gave is not asked again
    expect(counted).not.toContain('how many tickets');
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
    expect(body).toContain('Rock and indie in Brooklyn, Oct 1 to 7. Here are my two picks:');
    expect(body).toContain('The Walkmen at Union Pool');
    expect(body).toContain('Big Thief at Brooklyn Steel');
    expect(body).not.toContain('Jazz Trio'); // Brooklyn, but not the music asked for
    expect(body).not.toContain('Manhattan Indie Night'); // the music, but not Brooklyn
    expect(body).not.toContain('Jack White');
    expect(body).toContain("I've kept it to Brooklyn venues. Say if you'd go further.");
    expect(body).not.toContain("kind of music and I'll narrow"); // the kind of music is already known
  });

  it('says so, and shows what is on, when nothing on file is the music asked for', async () => {
    const c = makeConcierge(h);
    const requestId = await ask(c, 'Any reggaeton gigs in Brooklyn the first week of October?', 'latin@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain('Live music in Brooklyn, Oct 1 to 7. Here are my three picks:');
    expect(body).toContain("I couldn't find any Latin music listed for those dates, so here's everything that's on.");
  });

  it('"more" pages through the rest, three at a time, and then says that is everything', async () => {
    const HALL = '10000000-0000-4000-8000-0000000000c6';
    await h.db.insert(t.venues).values({ id: HALL, name: 'Music Hall of Williamsburg', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York' });
    const names = ['Act One', 'Act Two', 'Act Three', 'Act Four', 'Act Five', 'Act Six', 'Act Seven'];
    await h.db.insert(t.events).values(names.map((name, i) => ({ name, category: 'concert', genre: null, venueId: HALL, primaryEntityId: null, isHome: null, localStartAt: new Date(`2026-10-1${i < 4 ? 0 : 1}T${String(20 + (i % 4)).padStart(2, '0')}:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true })));
    const c = makeConcierge(h);
    const first = inbound({ text: 'What concerts are on in Brooklyn Oct 10-11?', from: 'more@customer.example', subject: 'Brooklyn gigs' });
    const r = await c.ingestInbound(first);
    await interpretAll(h, c);
    const requestId = (r as { requestId: string }).requestId;
    const listed = (body: string) => names.filter((n) => body.includes(`${n} at`));
    const one = (await lastSend(requestId)).bodyText;
    expect(one).toContain('Here are my three picks:');
    expect(one).toContain('There are 4 more in that window. Reply "more" to see them');
    const page1 = listed(one);
    expect(page1).toHaveLength(3);
    const reply = (text: string) => c.ingestInbound(inbound({ text, from: 'more@customer.example', subject: 'Re: Brooklyn gigs', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await reply('can you give me the other 4');
    await interpretAll(h, c);
    const two = (await lastSend(requestId)).bodyText;
    expect(two).toContain('More live music in Brooklyn, Oct 10 to 11:');
    const page2 = listed(two);
    expect(page2).toHaveLength(3);
    expect(page2.some((n) => page1.includes(n))).toBe(false); // nothing from the first page again
    expect(two).toContain('There is 1 more in that window');
    await reply('more');
    await interpretAll(h, c);
    const page3 = listed((await lastSend(requestId)).bodyText);
    expect(page3).toHaveLength(1);
    expect([...page1, ...page2, ...page3].sort()).toEqual([...names].sort());
    await reply('any others?');
    await interpretAll(h, c);
    expect((await lastSend(requestId)).bodyText).toContain("That's everything I have for live music in Brooklyn, Oct 10 to 11.");
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
