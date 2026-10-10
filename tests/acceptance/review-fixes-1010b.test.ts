import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, like } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { BEST_ASSUMED, BEST_GOAL_ASK, Concierge, mergeExtraction } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor, type ExtractionInput } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import type { RequestExtraction } from '@/lib/domain/types';
import { inbound, makeConcierge, openTestDb, testEnv } from '../harness';

/**
 * Review findings on the brief-journeys integration (Oct 10): what "best" means is never asked again once the brief
 * holds it; a budget set aside as an offer's price takes its fee basis with it; a new request in a thread never inherits
 * a deadline that has passed; "find me tickets now" ends a watch request; an expired draft is researched again only for
 * a request still waiting on it; research without a party size is left alone, not retried until dead; and "asked twice,
 * assume two" counts the rounds that asked the count, whatever else a reply answered.
 */
const id = (n: number) => `7e1010bb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ARENA = id(1);
const HALL = id(2);
const HAWKS = id(10);
const LUMEN = id(11);
// Harbor Hawks home games: Thu Oct 8, Wed Oct 14, Sat Oct 17, 7pm in New York.
const GAMES = [8, 14, 17].map((d, i) => ({ id: id(100 + i), day: d }));
const game = (d: number) => GAMES.find((g) => g.day === d)!.id;
const LUMEN_SHOW = id(200); // Mon Oct 19, 8pm
const HOUR = 3_600_000;

class Script implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  over: Partial<RequestExtraction> = {};
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    return { ...(await this.rules.extract(input)), ...this.over } as RequestExtraction;
  }
}

type Turn = { text: string; over?: Partial<RequestExtraction>; at?: Date };
type Seen = { requestId: string; state: string; eventId: string | null; brief: RequestExtraction; text: string; researched: boolean; deadlineAt: Date | null };

let n = 0;
/** One thread, each reply chained by In-Reply-To, drained after every turn; each turn may arrive at its own time. */
async function thread(h: DbHandle, turns: Turn[]): Promise<Seen[]> {
  const x = new Script();
  let clock = FIXTURE_NOW;
  const c = new Concierge({ db: h.db, env: testEnv(), extractor: x, drafter: new FixtureDrafter(), clock: () => clock, emailProvider: null });
  const from = `fixes-${++n}@customer.example`;
  let prev: ReturnType<typeof inbound> | null = null;
  const out: Seen[] = [];
  for (const tu of turns) {
    clock = tu.at ?? clock;
    const seenSends = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((r) => r.id));
    const seenRecs = new Set((await h.db.select({ id: t.recommendations.id }).from(t.recommendations)).map((r) => r.id));
    x.over = tu.over ?? {};
    const m = inbound({ text: tu.text, from, subject: prev ? 'Re: Tickets' : 'Tickets', receivedAt: clock, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
    const r = (await c.ingestInbound(m)) as { requestId: string; conversationId: string };
    prev = m;
    let researched = false;
    for (let i = 0; i < 6; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(clock.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') {
          researched = researched || p.requestId === r.requestId;
          await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        }
        await markDispatched(h.db, ev.id, ev.leaseToken, clock);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const [v] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId)).orderBy(desc(t.requestVersions.revision)).limit(1);
    const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.conversationId, r.conversationId))).filter((s) => !seenSends.has(s.id));
    const recs = (await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).filter((s) => !seenRecs.has(s.id));
    out.push({ requestId: r.requestId, state: req!.state, eventId: req!.eventId, brief: v!.brief as RequestExtraction, text: [...sends.map((s) => s.bodyText), ...recs.map((s) => s.bodyText)].join('\n----\n'), researched, deadlineAt: req!.deadlineAt });
  }
  return out;
}

describe('review fixes on the brief journeys', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: ARENA, name: 'Harbor Arena', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' },
      { id: HALL, name: 'Pier Hall', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' },
    ]);
    await h.db.insert(t.entities).values([
      { id: HAWKS, kind: 'team', name: 'Harbor Hawks', slug: 'harbor-hawks-rf', aliases: ['Harbor Hawks'], league: 'NHL', homeVenueId: ARENA },
      { id: LUMEN, kind: 'artist', name: 'Lumen Tide', slug: 'lumen-tide-rf', aliases: [] },
    ]);
    for (const g of GAMES) await h.db.insert(t.events).values({ id: g.id, name: `Harbor Hawks vs. Team ${g.day}`, category: 'nhl', venueId: ARENA, primaryEntityId: HAWKS, isHome: true, localStartAt: new Date(`2026-10-${String(g.day).padStart(2, '0')}T23:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.insert(t.events).values({ id: LUMEN_SHOW, name: 'Lumen Tide', category: 'concert', genre: 'pop / pop', venueId: HALL, primaryEntityId: LUMEN, localStartAt: new Date('2026-10-20T00:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.update(t.adapterConfigs).set({ enabled: false });
  });
  afterAll(async () => {
    await h.close();
  });

  describe('what "best" means, once the brief holds it', () => {
    it('"best seats" is the view: no goal question, straight to research', async () => {
      const [s] = await thread(h, [{ text: '2 best seats for Lumen Tide on Oct 19 please' }]);
      expect(s!.eventId).toBe(LUMEN_SHOW);
      expect(s!.brief.rankingGoal).toBe('view');
      expect(s!.text).not.toContain(BEST_GOAL_ASK);
      expect(s!.researched).toBe(true);
    });
    it('"most bang for the buck" answers the goal question: never told it went by the lowest price', async () => {
      const [ask, answer] = await thread(h, [{ text: '2 best tickets for Lumen Tide on Oct 19 please' }, { text: 'most bang for the buck' }]);
      expect(ask!.text).toContain(BEST_GOAL_ASK);
      expect(answer!.brief.rankingGoal).toBe('value');
      expect(answer!.researched).toBe(true);
      expect(answer!.text).not.toContain(BEST_ASSUMED);
      expect(answer!.text).not.toContain(BEST_GOAL_ASK);
    });
    it('a goal from an earlier message is kept: "best tickets under $300?" later asks nothing', async () => {
      const [, later] = await thread(h, [{ text: '2 tickets for Lumen Tide on Oct 19, best view please' }, { text: 'best tickets under $300?' }]);
      expect(later!.brief.rankingGoal).toBe('view');
      expect(later!.state).not.toBe('needs_clarification');
      expect(later!.text).not.toContain(BEST_GOAL_ASK);
      expect(later!.text).not.toContain(BEST_ASSUMED);
    });
  });

  it('an offer price set aside as no budget takes its fee basis with it', async () => {
    const [first, offers] = await thread(h, [
      { text: '2 Harbor Hawks tickets for the Oct 8 game, $400 total' },
      { text: 'Offer A: $90 per ticket before fees. Offer B: $210 total including fees.' },
    ]);
    expect(first!.brief).toMatchObject({ budgetCents: 40000, budgetFeeBasis: null });
    expect(offers!.brief).toMatchObject({ budgetCents: 40000, budgetBasis: 'whole_party', budgetFeeBasis: null });
    expect(offers!.text).not.toContain('$400 before fees');
  });

  describe('a new request in the thread and the last one’s deadline', () => {
    const OCT17 = { text: '2 Harbor Hawks tickets for the Oct 17 game please', over: { decisionDeadline: '2026-09-24T03:59:00.000Z' } } as const;
    it('a deadline that has passed is not carried', async () => {
      const [first, bought, more] = await thread(h, [OCT17, { text: 'Thanks, we bought them!' }, { text: 'Could you find 2 more seats for my brothers?', at: new Date(FIXTURE_NOW.getTime() + 72 * HOUR) }]);
      expect(first!.deadlineAt?.toISOString()).toBe('2026-09-24T03:59:00.000Z');
      expect(bought!.state).toBe('closed');
      expect(more!.requestId).not.toBe(first!.requestId);
      expect(more!.eventId).toBe(game(17));
      expect(more!.brief.decisionDeadline).toBeNull();
      expect(more!.deadlineAt).toBeNull();
      expect(more!.text).not.toContain('there isn’t much time left');
    });
    it('control: one still ahead is', async () => {
      const [first, , more] = await thread(h, [OCT17, { text: 'Thanks, we bought them!' }, { text: 'Could you find 2 more seats for my brothers?', at: new Date(FIXTURE_NOW.getTime() + 6 * HOUR) }]);
      expect(more!.requestId).not.toBe(first!.requestId);
      expect(more!.brief.decisionDeadline).toBe('2026-09-24T03:59:00.000Z');
    });
  });

  it('"asked twice, assume two" counts the rounds that asked the count, even when a reply answered something else', async () => {
    const [ask, game14, unanswered] = await thread(h, [{ text: 'Harbor Hawks tickets in October' }, { text: 'the 14th' }, { text: 'thanks' }]);
    expect(ask!.text).toMatch(/how many tickets\?/i);
    expect(game14!.eventId).toBe(game(14));
    expect(game14!.state).toBe('needs_clarification');
    expect(game14!.text).toMatch(/How many tickets/);
    // The count has now been asked twice: two is assumed, and the request goes on.
    expect(unanswered!.brief.quantity).toBe(2);
    expect(unanswered!.researched).toBe(true);
  });

  it('a watch request becomes a search when they ask to buy now; a terse follow-up still keeps it a watch', async () => {
    const known: ExtractionInput['knownEntities'] = [{ name: 'New York Knicks', aliases: ['Knicks'], kind: 'team', category: 'nba' }];
    const extract = (text: string) => new FixtureExtractor().extract({ messageId: 'm1', text, subject: null, receivedAt: FIXTURE_NOW, venueTimeZone: 'America/New_York', knownEntities: known });
    const watch = await extract('Knicks on October 24, 2 tickets, $300 total. Let me know if it drops.');
    expect(watch.intent).toBe('watch_request');
    for (const said of ['Actually forget waiting, just find me 2 tickets now', 'I want to buy now please']) {
      expect(mergeExtraction(watch, await extract(said), said).intent).toBe('new_search');
    }
    const terse = 'Make it 3 tickets, $400 total';
    expect(mergeExtraction(watch, await extract(terse), terse).intent).toBe('watch_request');
  });
});

describe('expired drafts and research without a party size', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const reviewed = () => testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: '' });
  const drain = async (c: Concierge, now = FIXTURE_NOW) => {
    for (let i = 0; i < 10; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now });
      if (!leased.length) return;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
  };
  const approvedDraft = async (who: string) => {
    const c = makeConcierge(h, { env: reviewed() });
    const r = (await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3, $300 total. Should I buy now?', from: who, subject: 'Rangers' }))) as { requestId: string };
    await drain(c);
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    const ok = await c.approveRecommendation({ recommendationId: rec!.id, reviewerUserId: 'staff-1', expectedRevision: 1, draftHash: rec!.draftHash, note: null });
    expect(ok.ok).toBe(true);
    return { requestId: r.requestId, rec: rec!, sendIntentId: (ok as { sendIntentId: string }).sendIntentId };
  };
  const t20 = new Date(FIXTURE_NOW.getTime() + 20 * 60_000);
  const reresearched = async (requestId: string) => h.db.select().from(t.outboxEvents).where(like(t.outboxEvents.eventKey, `research:${requestId}:1:expired:%`));

  it('a request closed since the approval stays closed: the expired draft is withdrawn, nothing researched again', async () => {
    const { requestId, rec, sendIntentId } = await approvedDraft('closed-late@customer.example');
    // "We bought them" or "stop all emails" closes it without a new revision.
    await h.db.update(t.requests).set({ state: 'closed' }).where(eq(t.requests.id, requestId));
    const sent = await makeConcierge(h, { env: reviewed(), now: () => t20 }).dispatchSend(sendIntentId);
    expect(sent.outcome).toBe('blocked');
    expect((await h.db.select().from(t.recommendations).where(eq(t.recommendations.id, rec.id)))[0]!.reviewStatus).toBe('invalidated');
    expect(await reresearched(requestId)).toHaveLength(0);
    expect((await h.db.select().from(t.requests).where(eq(t.requests.id, requestId)))[0]!.state).toBe('closed');
  });

  it('a customer who opted out of everything is not researched again either', async () => {
    const who = 'optout-late@customer.example';
    const { requestId, sendIntentId } = await approvedDraft(who);
    await h.db.insert(t.suppressions).values({ emailLookup: who, scope: 'global', reason: 'stop_all' });
    const sent = await makeConcierge(h, { env: reviewed(), now: () => t20 }).dispatchSend(sendIntentId);
    expect(sent.outcome).not.toBe('sent');
    expect(await reresearched(requestId)).toHaveLength(0);
  });

  it('research for a request with no party size is skipped and recorded, never thrown', async () => {
    const c = makeConcierge(h, { env: reviewed() });
    const r = (await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3, $300 total.', from: 'nocount@customer.example', subject: 'Rangers' }))) as { requestId: string };
    await drain(c);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const [v] = await h.db.select().from(t.requestVersions).where(and(eq(t.requestVersions.requestId, r.requestId), eq(t.requestVersions.revision, req!.currentRevision)));
    // As a request parked waiting on the count would hold it.
    await h.db.update(t.requestVersions).set({ brief: { ...(v!.brief as RequestExtraction), quantity: null } }).where(eq(t.requestVersions.id, v!.id));
    await expect(c.research({ requestId: r.requestId, revision: req!.currentRevision })).resolves.toEqual({ recommendationId: null, state: req!.state });
    expect(await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'research.skipped_no_party_size'), eq(t.auditLog.entityId, r.requestId)))).toHaveLength(1);
  });
});
