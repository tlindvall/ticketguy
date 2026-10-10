import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { eventConstraints } from '@/lib/domain/event-constraints';
import type { RequestExtraction } from '@/lib/domain/types';
import { seedDiscovery } from './r1-discovery.harness';
import sharp from 'sharp';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';

/**
 * Conversation state across follow-ups (CTO audit, Oct 10, gaps 4, 9, 11, 15 and the settled-game items): one thread,
 * replies chained by In-Reply-To, the brief and the reply checked after every turn. A customer never repeats what they
 * already told us in a thread: a side question doesn't end the request it interrupted, a new request in the thread
 * starts from the last one's event and party, a reply that names nothing new keeps the game, and a new act clears the
 * old act's event. Rules-path extraction, with fields pinned where the production model would read them (as
 * RecordedModelExtractor does in the R8 replay).
 */
const NOW = new Date('2026-10-01T14:00:00Z'); // a Thursday
const id = (n: number) => `7e300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ARENA = id(1);
const HALL = id(2);
const HAWKS = id(10);
const LUMEN = id(11);
// Harbor Hawks home games: Mon Oct 5, Thu Oct 8, Sun Oct 11, Wed Oct 14, Sat Oct 17, 7pm.
const GAMES = [5, 8, 11, 14, 17].map((d, i) => ({ id: id(100 + i), day: d }));
const game = (d: number) => GAMES.find((g) => g.day === d)!.id;
const LUMEN_SHOW = id(200);

class Script implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  over: Partial<RequestExtraction> = {};
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    return { ...(await this.rules.extract(input)), ...this.over } as RequestExtraction;
  }
}

type Turn = { text: string; over?: Partial<RequestExtraction>; before?: (requestId: string) => Promise<void>; image?: Uint8Array<ArrayBuffer> };
type Seen = { requestId: string; state: string; eventId: string | null; brief: RequestExtraction; text: string; requests: number };

let n = 0;
async function thread(h: DbHandle, turns: Turn[], env = testEnv(), listingReader?: ListingReader): Promise<Seen[]> {
  const x = new Script();
  const c = new Concierge({ db: h.db, env, extractor: x, drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null, listingReader });
  const from = `thread-${++n}@customer.example`;
  let prev: ReturnType<typeof inbound> | null = null;
  let rid = '';
  const out: Seen[] = [];
  for (const tu of turns) {
    if (tu.before) await tu.before(rid);
    const seenSends = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((r) => r.id));
    const seenRecs = new Set((await h.db.select({ id: t.recommendations.id }).from(t.recommendations)).map((r) => r.id));
    x.over = tu.over ?? {};
    const m = inbound({ text: tu.text, from, subject: prev ? 'Re: Tickets' : 'Tickets', receivedAt: NOW, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, attachments: tu.image ? [{ providerAttachmentId: `img-${n}`, filename: 'listing.png', declaredMimeType: 'image/png', bytes: tu.image, inline: false }] : [] });
    const r = (await c.ingestInbound(m)) as { requestId: string; conversationId: string };
    prev = m;
    rid = r.requestId;
    for (let i = 0; i < 6; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, rid));
    const [v] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, rid)).orderBy(desc(t.requestVersions.revision)).limit(1);
    const inThread = (await h.db.select({ id: t.requests.id }).from(t.requests).where(eq(t.requests.conversationId, r.conversationId))).map((q) => q.id);
    const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.conversationId, r.conversationId))).filter((s) => !seenSends.has(s.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const recs = (await h.db.select().from(t.recommendations).where(inArray(t.recommendations.requestId, inThread))).filter((s) => !seenRecs.has(s.id));
    // Opt-in: prints each turn's emails for a read-through.
    if (process.env.PRINT_TURNS) console.log(`>>> ${tu.text}\n${[...sends.map((s) => s.bodyText), ...recs.map((s) => s.bodyText)].join('\n----\n')}`);
    out.push({ requestId: rid, state: req!.state, eventId: req!.eventId, brief: v!.brief as RequestExtraction, text: [...sends.map((s) => s.bodyText), ...recs.map((s) => s.bodyText)].join('\n----\n'), requests: inThread.length });
  }
  return out;
}

describe('one thread, one memory', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: ARENA, name: 'Harbor Arena', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' },
      { id: HALL, name: 'Pier Hall', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' },
    ]);
    await h.db.insert(t.entities).values([
      { id: HAWKS, kind: 'team', name: 'Harbor Hawks', slug: 'harbor-hawks-cs', aliases: ['Harbor Hawks'], league: 'NHL', homeVenueId: ARENA },
      { id: LUMEN, kind: 'artist', name: 'Lumen Tide', slug: 'lumen-tide-cs', aliases: [] },
    ]);
    for (const g of GAMES) await h.db.insert(t.events).values({ id: g.id, name: `Harbor Hawks vs. Team ${g.day}`, category: 'nhl', venueId: ARENA, primaryEntityId: HAWKS, isHome: true, localStartAt: new Date(`2026-10-${String(g.day).padStart(2, '0')}T23:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.insert(t.events).values({ id: LUMEN_SHOW, name: 'Lumen Tide', category: 'concert', genre: 'pop / pop', venueId: HALL, primaryEntityId: LUMEN, localStartAt: new Date('2026-10-10T00:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.update(t.adapterConfigs).set({ enabled: false });
  });
  afterAll(async () => {
    await h.close();
  });

  const OCT8: Turn = { text: '2 Harbor Hawks tickets for the Oct 8 game please, seats together, $300 total for both' };

  describe('audit gap 4: a side question in an open thread', () => {
    // Which request does it close? The one it interrupted: it was attached there, answered there, and closed it.
    for (const side of [
      { name: 'a dinner question', text: 'Unrelated: any good dinner spots near Harbor Arena before the game?', says: 'Restaurant and bar suggestions are outside what I do' },
      { name: 'a capability question', text: 'Also, is the automatic on-sale alert feature actually available? I am only asking.', says: 'Automatic on-sale alerts are switched off for now' },
    ]) {
      it(`${side.name} is answered without closing the request, and the next reply keeps every fact`, async () => {
        const [first, aside, next] = await thread(h, [OCT8, { text: side.text }, { text: 'Are the seats together?' }]);
        expect(first!.eventId).toBe(game(8));
        expect(aside!.text).toContain(side.says);
        // The side question was answered in the request it interrupted, and that request is still open.
        expect(aside!.requestId).toBe(first!.requestId);
        expect(aside!.state).not.toBe('closed');
        expect(aside!.brief).toMatchObject({ performerOrTeam: 'Harbor Hawks', quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party' });
        // The follow-up is still that request: same game, same party, nothing asked again.
        expect(next!.requestId).toBe(first!.requestId);
        expect(next!.requests).toBe(1);
        expect(next!.eventId).toBe(game(8));
        expect(next!.brief).toMatchObject({ performerOrTeam: 'Harbor Hawks', quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party', togetherRequired: true });
        expect(next!.text).not.toMatch(/Which (?:game|date|event)|How many tickets|tell me what you want to see/);
      });
    }

    it('after "thanks, we bought them" a new request in the thread starts from the game and the party', async () => {
      const [first, bought, more] = await thread(h, [OCT8, { text: 'Thanks, we bought them!' }, { text: 'Could you find 2 more seats for my brothers?' }]);
      expect(bought!.state).toBe('closed');
      expect(more!.requestId).not.toBe(first!.requestId);
      expect(more!.requests).toBe(2);
      expect(more!.eventId).toBe(game(8));
      expect(more!.brief).toMatchObject({ performerOrTeam: 'Harbor Hawks', resolvedLocalDate: '2026-10-08', quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party' });
      expect(more!.text).not.toMatch(/Which (?:game|date|event)|tell me what you want to see/);
    });

    it('after entry help (they bought) the next request in the thread keeps the game; a new count replaces the old one', async () => {
      const [first, help, more] = await thread(h, [OCT8, { text: 'We already bought them, but the seller sent a PDF screenshot of the barcode. Will that get us in?' }, { text: 'Can you find 4 more seats for the same game? Separate from ours is fine.' }]);
      expect(help!.text).toContain('Ask the seller for an official mobile transfer');
      expect(more!.requestId).not.toBe(first!.requestId);
      expect(more!.eventId).toBe(game(8));
      expect(more!.brief).toMatchObject({ performerOrTeam: 'Harbor Hawks', quantity: 4 });
    });

    it('control: after "stop", nothing is carried into the next request', async () => {
      const [, stopped, next] = await thread(h, [OCT8, { text: 'Please stop watching this for me.' }, { text: 'I need 2 tickets please.' }]);
      expect(stopped!.state).toBe('closed');
      expect(next!.eventId).toBeNull();
      expect(next!.brief.performerOrTeam).toBeNull();
      expect(next!.brief.budgetCents).toBeNull();
      expect(next!.text).toMatch(/Which event/);
    });
  });

  describe('settled game: a follow-up that names nothing new keeps it', () => {
    // The Oct 11 game was chosen from a list we sent, so the brief holds no date for it (the ranked-games reply and the
    // list choice leave it that way). Before the fix the bare follow-up resolved to the next home game, Oct 5.
    const chose11 = async (rid: string) => {
      await h.db.update(t.requests).set({ eventId: game(11) }).where(eq(t.requests.id, rid));
    };
    it('"are the seats together?" stays on the game they chose, not the next home game', async () => {
      const [first, , after] = await thread(h, [
        { text: '4 Harbor Hawks tickets please, $400 total' },
        { text: 'Are the seats together?', before: chose11 },
        { text: 'There are 5 of us now, same game.' },
      ]);
      expect(first!.eventId).toBe(game(5));
      expect(after!.eventId).toBe(game(11));
      expect(after!.brief.quantity).toBe(5);
      expect(after!.text).not.toMatch(/Mon, Oct 5|Monday, October 5/);
    });
    it('second turn: the bare question itself keeps Oct 11', async () => {
      const [, together] = await thread(h, [{ text: '4 Harbor Hawks tickets please, $400 total' }, { text: 'Are the seats together?', before: chose11 }]);
      expect(together!.eventId).toBe(game(11));
      expect(together!.text).not.toMatch(/Mon, Oct 5|Monday, October 5/);
    });
    it('control: "when do they play home next?" asks for the next game, so it gets that one', async () => {
      const [, next] = await thread(h, [{ text: '4 Harbor Hawks tickets please, $400 total' }, { text: 'When are they playing home next?', before: chose11 }]);
      expect(next!.eventId).toBe(game(5));
    });
    it('control: a date they name still moves it', async () => {
      const [, moved] = await thread(h, [{ text: '4 Harbor Hawks tickets please, $400 total' }, { text: 'Make it the Oct 14 game instead.', before: chose11 }]);
      expect(moved!.eventId).toBe(game(14));
    });
  });

  describe('audit gap 11: a different act clears the old act’s event', () => {
    const FIRST: Turn = { text: '2 tickets for Harbor Hawks vs Team 8 on Oct 8 https://www.stubhub.com/harbor-hawks-new-york-tickets-10-8-2026/event/159000111', over: { eventName: 'Harbor Hawks vs. Team 8' } };
    it('"Actually make it Lumen Tide instead": no Oct 8, no hockey game name, no old link', async () => {
      const [first, changed] = await thread(h, [FIRST, { text: 'Actually make it Lumen Tide instead', over: { performerOrTeam: 'Lumen Tide' } }]);
      expect(first!.eventId).toBe(game(8));
      expect(changed!.brief).toMatchObject({ performerOrTeam: 'Lumen Tide', eventName: null, dateExpression: null, resolvedLocalDate: null, submittedUrls: [], quantity: 2 });
      expect(changed!.eventId).toBe(LUMEN_SHOW);
      expect(changed!.text).not.toMatch(/Oct 8|October 8|Harbor Hawks/);
    });
    it('"What about Lumen Tide instead?" is a new act, not "did you check another date?"', async () => {
      const [, changed] = await thread(h, [FIRST, { text: 'What about Lumen Tide instead?', over: { performerOrTeam: 'Lumen Tide' } }]);
      expect(changed!.eventId).toBe(LUMEN_SHOW);
      expect(changed!.brief).toMatchObject({ performerOrTeam: 'Lumen Tide', resolvedLocalDate: null });
    });
    it('control: the new act with its own date keeps that date', async () => {
      const [, changed] = await thread(h, [FIRST, { text: 'Actually make it Lumen Tide on Oct 9 instead', over: { performerOrTeam: 'Lumen Tide' } }]);
      expect(changed!.brief).toMatchObject({ performerOrTeam: 'Lumen Tide', resolvedLocalDate: '2026-10-09' });
      expect(changed!.eventId).toBe(LUMEN_SHOW);
    });
    it('control: the same team said again keeps its game', async () => {
      const [, same] = await thread(h, [FIRST, { text: 'Harbor Hawks, still 2 tickets. Are they together?', over: { performerOrTeam: 'Harbor Hawks' } }]);
      expect(same!.brief).toMatchObject({ performerOrTeam: 'Harbor Hawks', resolvedLocalDate: '2026-10-08' });
      expect(same!.eventId).toBe(game(8));
    });
  });

  describe('audit gap 9: "$220 for both" answering per ticket or total', () => {
    it('is the quoted price’s basis, not a budget', async () => {
      const [first, answer] = await thread(h, [{ text: 'Is $220 a good price for 2 Harbor Hawks tickets on Oct 8?' }, { text: '$220 for both' }]);
      expect(first!.brief).toMatchObject({ quotedPriceCents: 22000, quotedPriceBasis: null, budgetCents: null });
      expect(answer!.brief).toMatchObject({ quotedPriceCents: 22000, quotedPriceBasis: 'whole_party', budgetCents: null, budgetBasis: null });
      expect(answer!.text).not.toMatch(/\$220 (?:in total|budget)|your \$220|under your/);
      expect(answer!.text).toContain('$110');
    });
    it('describing the offer the same way: "they want $220 for both"', async () => {
      const [, answer] = await thread(h, [{ text: 'Is $220 a good price for 2 Harbor Hawks tickets on Oct 8?' }, { text: 'They want $220 for both, not each.' }]);
      expect(answer!.brief).toMatchObject({ quotedPriceCents: 22000, quotedPriceBasis: 'whole_party', budgetCents: null });
    });
    it('on the screenshot route: our "Is $220 the price per ticket, or for all 2?" is answered and not asked again', async () => {
      const blank: ListingRead = { kind: 'ticket_listing', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'high', unreadable: [] };
      const read: ListingRead = { ...blank, seller: 'StubHub', eventName: 'Harbor Hawks vs. Team 8', eventDate: '2026-10-08', venue: 'Harbor Arena', city: 'New York', quantity: 2, priceText: '$220', priceDollars: 220, section: '214', row: '10' };
      const reader: ListingReader = { name: 'fake', read: async (input: { image?: unknown }) => (input.image ? read : { ...blank, kind: 'unrelated' }) } as ListingReader;
      const png = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).png().toBuffer());
      const [first, answer] = await thread(h, [{ text: 'Is this a good price?', image: png }, { text: '$220 for both' }], testEnv(), reader);
      expect(first!.text).toContain('Is $220 the price per ticket, or for all 2?');
      expect(answer!.brief).toMatchObject({ quotedPriceCents: 22000, quotedPriceBasis: 'whole_party', budgetCents: null });
      expect(answer!.text).not.toContain('Is $220 the price per ticket');
      expect(answer!.text).toContain('$110');
    });
    it('control: "we can spend $220 for both" is a budget', async () => {
      const [, answer] = await thread(h, [{ text: 'Is $220 a good price for 2 Harbor Hawks tickets on Oct 8?' }, { text: 'We can spend $220 for both' }]);
      expect(answer!.brief).toMatchObject({ budgetCents: 22000, budgetBasis: 'whole_party', quotedPriceBasis: null });
    });
  });

  describe('stale event after an early exit (product choice, official sale)', () => {
    it('after the official-sale reply, a different act is not bound to the old event', async () => {
      await h.db.update(t.events).set({ saleStatus: 'onsale', publicSaleStartAt: new Date('2026-09-01T14:00:00Z') }).where(eq(t.events.id, game(8)));
      await h.db.insert(t.eventSourceMappings).values({ eventId: game(8), sourceId: 'ticketmaster', sourceEventId: 'CS8', authoritativeUrl: 'https://www.ticketmaster.com/event/CS8', role: 'discovery', confidence: 'provider_id' }).onConflictDoNothing();
      try {
        const [first, other] = await thread(h, [OCT8, { text: 'What about Lumen Tide instead?', over: { performerOrTeam: 'Lumen Tide' } }]);
        expect(first!.eventId).toBe(game(8));
        expect(other!.eventId).toBe(LUMEN_SHOW);
        expect(other!.text).not.toMatch(/Harbor Hawks/);
      } finally {
        await h.db.update(t.events).set({ saleStatus: 'offsale', publicSaleStartAt: null }).where(eq(t.events.id, game(8)));
        await h.db.delete(t.eventSourceMappings).where(and(eq(t.eventSourceMappings.eventId, game(8)), eq(t.eventSourceMappings.sourceEventId, 'CS8')));
      }
    });
  });
});

describe('audit gap 15 and the other-date answer, over the Research 1 catalog', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await seedDiscovery(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('"this weekend" includes Friday night for a club, and keeps Saturday or Sunday for sports', () => {
    const at = { receivedAt: NOW, timeZone: 'America/New_York', venues: [] };
    expect(eventConstraints(['Anything good at Elsewhere this weekend?'], at).weekdays).toEqual([5, 6, 0]);
    expect(eventConstraints(['Knicks tickets for next weekend'], { ...at, sports: true }).weekdays).toEqual([6, 0]);
    expect(eventConstraints(['Saturday or Sunday only'], at).weekdays).toEqual([6, 0]);
  });

  it('"Anything good at Elsewhere this weekend?" lists the Friday night there', async () => {
    // As the production model reads it: a browse in Brooklyn this weekend (the rules path finds no category in it).
    const [r] = await thread(h, [{ text: 'Anything good at Elsewhere in Brooklyn this weekend?', over: { intent: 'browse', city: 'Brooklyn', state: 'NY', dateExpression: 'this weekend' } }]);
    expect(r!.text).toContain('Dusky');
  });

  it('"did you check Saturday too?" is answered when the request goes on to research', async () => {
    const [, second] = await thread(h, [{ text: 'Dusky at Elsewhere in Brooklyn on Friday Oct 2. Two tickets.' }, { text: 'Did you check Saturday Oct 3 too?' }]);
    expect(second!.text).toContain('I checked Sat, Oct 3 too: no Dusky that night, but there’s Night Shift: Deep House at Brooklyn Basement, Sat, Oct 3 at 11pm, also listed as house.');
    expect(second!.brief.resolvedLocalDate).toBe('2026-10-02');
  });
});
