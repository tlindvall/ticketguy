import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { BEST_ASSUMED, BEST_GOAL_ASK, BEST_OPEN_ASK, elsewhereQuestion, questionRound, withCount } from '@/lib/intake/pipeline';
import type { NearbyShow } from '@/lib/intake/pipeline';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Oct 10 CTO audit, gaps 14 and 16, and the brief's "'Best' is not a universal ranking":
 * - a clarification asks ONE compact question (at most two asks in one sentence), never a stack of three under "A couple
 *   of quick questions", and the not-in-your-city list asks which show and how many together;
 * - only consecutive unanswered rounds count towards the hand-off to a person;
 * - "the best tickets" with no goal is asked whenever the event is settled, not only for an act on file with no date
 *   or count, and is never silently ranked as cheapest.
 */
const now = FIXTURE_NOW; // Sep 22, 2026
const ARENA = '10000000-0000-4000-8000-0000000000a1';
const TEAM = '20000000-0000-4000-8000-0000000000a1';
const BAND = '20000000-0000-4000-8000-0000000000a2';
const GAME_1 = '30000000-0000-4000-8000-0000000000a1';
const GAME_2 = '30000000-0000-4000-8000-0000000000a2';
const SHOW = '30000000-0000-4000-8000-0000000000a3';

describe('one compact question', () => {
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
  const sends = async (requestId: string) => (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  /** The body above the signature, where the questions are. */
  const body = (text: string) => text.split('\n\nTicket Guy\n')[0]!;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Harbor Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values([
      { id: TEAM, kind: 'team', name: 'Harbor Knights', slug: 'harbor-knights', aliases: ['Knights'], league: 'NHL', homeVenueId: ARENA },
      { id: BAND, kind: 'artist', name: 'Velvet Engines', slug: 'velvet-engines', aliases: [], league: null, homeVenueId: null },
    ]);
    await h.db.insert(t.events).values([
      { id: GAME_1, name: 'Harbor Knights vs. Boston Bruins', category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-10-14T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' },
      { id: GAME_2, name: 'Harbor Knights vs. Chicago Blackhawks', category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-10-21T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' },
      { id: SHOW, name: 'Velvet Engines', category: 'concert', venueId: ARENA, primaryEntityId: BAND, isHome: null, localStartAt: new Date('2026-10-20T00:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' },
    ]);
    await h.db.update(t.adapterConfigs).set({ enabled: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it('gap 14: which game and how many are one sentence, not a list of asks', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Harbor Knights tickets in October', from: 'one-q@customer.example', subject: 'Knights' }))) as { requestId: string };
    expect(await interpretAll(c)).toEqual([]);
    const [ask] = await sends(r.requestId);
    expect(ask!.messageClass).toBe('clarification');
    expect(ask!.subject).toBe('Re: Knights');
    const text = body(ask!.bodyText);
    expect(text.match(/\?/g)).toHaveLength(1);
    expect(text).toMatch(/Which game: .+, and how many tickets\?/);
    expect(text).not.toContain('How many tickets do you need');
  });

  it('gap 14: the not-in-your-city choice and the count are asked together', () => {
    const show = (iso: string) => ({ e: { localStartAt: new Date(iso) }, v: { id: 'v1', timezone: 'America/New_York' }, miles: 90, kind: 'artist' }) as unknown as NearbyShow;
    const x = { quantity: null } as unknown as RequestExtraction;
    expect(elsewhereQuestion([show('2026-11-20T00:00:00Z'), show('2026-11-22T00:00:00Z')], x)).toBe('Which night works, and how many tickets? Or tell me how far you’d travel.');
    expect(elsewhereQuestion([show('2026-11-20T00:00:00Z')], x)).toBe('Want that one, and how many tickets? Or tell me how far you’d travel.');
    expect(withCount('Which Velvet Engines date and venue are you looking at? A link works too.')).toBe('Which Velvet Engines date and venue are you looking at, and how many tickets? A link works too.');
    // Already asking for the count, or no question to fold it into: unchanged.
    expect(withCount('How many tickets do you need in total?')).toBe('How many tickets do you need in total?');
    expect(withCount('Send me the link and I’ll check it.')).toBe('Send me the link and I’ll check it.');
  });

  it('gap 16: only consecutive unanswered rounds count', () => {
    // Waiting on an answer that settled something it asked: the count starts again.
    expect(questionRound({ state: 'needs_clarification', clarificationCount: 3 }, ['event', 'quantity', 'event_ambiguous'], ['quantity'])).toBe(1);
    // Nothing it asked was settled: one more in a row.
    expect(questionRound({ state: 'needs_clarification', clarificationCount: 2 }, ['quantity', 'quantity_unclear'], ['quantity', 'quantity_unclear'])).toBe(3);
    // Not waiting on an answer (researched, referred): a fresh question is the first in a row.
    expect(questionRound({ state: 'recommendation_sent', clarificationCount: 3 }, [], ['quantity'])).toBe(1);
  });

  it('gap 16: a fourth question after three answered rounds is asked, not parked with a person', async () => {
    const c = makeConcierge(h);
    const first = inbound({ text: 'Harbor Knights tickets in October', from: 'rounds@customer.example', subject: 'Knights' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await interpretAll(c);
    // Three earlier rounds on this request, each answered (the counter used to only ever grow).
    await h.db.update(t.requests).set({ clarificationCount: 3 }).where(eq(t.requests.id, r.requestId));
    await c.ingestInbound(inbound({ text: 'The Oct 14 game, a few tickets', from: 'rounds@customer.example', subject: 'Re: Knights', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(c);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(GAME_1);
    expect(req!.state).toBe('needs_clarification');
    expect(req!.clarificationCount).toBe(1);
    const last = (await sends(r.requestId)).at(-1)!;
    expect(last.messageClass).toBe('clarification');
    expect(body(last.bodyText)).toContain('How many tickets');
    expect(await h.db.select().from(t.outboxEvents).where(and(eq(t.outboxEvents.eventType, 'staff.alert'), eq(t.outboxEvents.entityId, r.requestId)))).toHaveLength(0);
  });

  it('gap 4: "best" with the date named (not the A4 route) asks the goal with the count, in one question', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Find me the best Velvet Engines tickets on Oct 19', from: 'best-date@customer.example', subject: 'Velvet Engines' }))) as { requestId: string };
    expect(await interpretAll(c)).toEqual([]);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(SHOW);
    const [ask] = await sends(r.requestId);
    const text = body(ask!.bodyText);
    expect(text).toContain(withCount(BEST_GOAL_ASK));
    expect(text.match(/\?/g)).toHaveLength(1);
    // The A4 wording stays the A4 route's own.
    expect(text).not.toContain(BEST_OPEN_ASK);
  });

  it('gap 4: "best" with the date and count named asks the goal before research, and the answer goes on', async () => {
    const c = makeConcierge(h);
    const first = inbound({ text: '2 best tickets for Velvet Engines on Oct 19 please', from: 'best-count@customer.example', subject: 'Velvet Engines' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    // Never straight to research, which ranks on price.
    expect(await interpretAll(c)).toEqual([]);
    const [ask] = await sends(r.requestId);
    expect(ask!.messageClass).toBe('clarification');
    expect(body(ask!.bodyText)).toContain(BEST_GOAL_ASK);
    expect(body(ask!.bodyText).match(/\?/g)).toHaveLength(1);
    await c.ingestInbound(inbound({ text: 'Best view please', from: 'best-count@customer.example', subject: 'Re: Velvet Engines', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    expect(await interpretAll(c)).toEqual([r.requestId]);
    const all = (await sends(r.requestId)).map((s) => s.bodyText).join('\n');
    expect(all.split(BEST_GOAL_ASK)).toHaveLength(2);
    expect(all).not.toContain(BEST_ASSUMED);
  });

  it('gap 4: asked and answered without a goal, research goes on and the reply says it went by price', async () => {
    const c = makeConcierge(h);
    const first = inbound({ text: '2 best tickets for Velvet Engines on Oct 19 please', from: 'best-nogoal@customer.example', subject: 'Velvet Engines' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await interpretAll(c);
    await c.ingestInbound(inbound({ text: 'Whatever you think is good', from: 'best-nogoal@customer.example', subject: 'Re: Velvet Engines', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    expect(await interpretAll(c)).toEqual([r.requestId]);
    const later = (await sends(r.requestId)).slice(1).map((s) => s.bodyText).join('\n');
    expect(later).toContain(BEST_ASSUMED);
    expect(later).not.toContain(BEST_GOAL_ASK);
  });

  it('gap 4: behind an unsettled event the goal waits, then is the question once the game is chosen', async () => {
    const c = makeConcierge(h);
    const first = inbound({ text: 'Find me the best Harbor Knights tickets in October', from: 'best-later@customer.example', subject: 'Knights' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await interpretAll(c);
    const [ask] = await sends(r.requestId);
    expect(body(ask!.bodyText)).toMatch(/Which game: .+, and how many tickets\?/);
    expect(body(ask!.bodyText)).not.toContain('best view');
    await c.ingestInbound(inbound({ text: 'The Oct 14 game, 2 tickets', from: 'best-later@customer.example', subject: 'Re: Knights', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    // Not straight to a price-ranked search: the goal is asked now there is a game to rank seats for.
    expect(await interpretAll(c)).toEqual([]);
    const second = (await sends(r.requestId)).at(-1)!;
    expect(body(second.bodyText)).toContain(BEST_GOAL_ASK);
    expect(body(second.bodyText).match(/\?/g)).toHaveLength(1);
  });

  it('gap 4: the A4 route keeps its own question', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Find me the best Velvet Engines tickets', from: 'best-a4@customer.example', subject: 'Velvet Engines' }))) as { requestId: string };
    await interpretAll(c);
    const [ask] = await sends(r.requestId);
    expect(body(ask!.bodyText)).toContain(BEST_OPEN_ASK);
    expect(body(ask!.bodyText).match(/\?/g)).toHaveLength(1);
  });
});
