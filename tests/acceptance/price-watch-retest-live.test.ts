import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';

/**
 * SeatData price watch retest on the deployed build (Oct 1 2026, a80744b): the three live conversations, with the
 * package's exact messages (scenario-plan.json and L0x-follow.json), against a local event shaped like the one
 * they used: Kacey Musgraves at Moody Center ATX on Wed Oct 7, with its Ticketmaster event page. No seller can be
 * monitored and no market data is on file, so nothing here is availability, a price or an entry policy.
 *
 * L01 (no budget): PW-EMAIL-FOCUS-01, the one next step is the budget.
 * L02 (sections 101 through 105): the watch blocker is named; the requirement keeps its own punctuation.
 * L03 (late entry, relative): PW-ENTRY-REPLY-02 opening, PW-MULTI-INTENT-01 follow-up.
 */
const F = JSON.parse(readFileSync('tests/fixtures/pw-retest-2026-10-01.json', 'utf8')) as { conversations: Record<'L01' | 'L02' | 'L03', [string, string]> };
const [L01, L02, L03] = [F.conversations.L01, F.conversations.L02, F.conversations.L03];
const NOW = new Date('2026-10-01T23:30:00Z');
const VENUE = '7e300000-0000-4000-8000-000000000001';
const ACT = '7e300000-0000-4000-8000-000000000002';
const EVENT = '7e300000-0000-4000-8000-000000000003';

describe('Price watch retest: the deployed conversations, exact inputs', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; html: string; requestId: string };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW, env: testEnv({ SERVICE_POLICY_MODE: 'enforce' }) });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    const seen = new Set<string>();
    for (const text of turns) {
      const m = inbound({ text, from: `pw-retest-${n}@customer.example`, subject: prev ? 'Re: Kacey Musgraves October 7' : 'Kacey Musgraves October 7', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, receivedAt: NOW });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let i = 0; i < 8; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: NOW });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      // The reply to this turn: the advice draft when research ran (it waits for review), else what was queued.
      const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).filter((x) => !seen.has(x.id));
      const recs = (await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).filter((x) => !seen.has(x.id));
      for (const x of [...sends, ...recs]) seen.add(x.id);
      const reply = recs[0] ?? sends.find((x) => !/Here's what I have/.test(x.bodyText)) ?? sends[0];
      expect(reply).toBeDefined();
      out.push({ text: reply!.bodyText.split('\nTicket Guy\n')[0]!, html: reply!.bodyHtml, requestId: r.requestId });
    }
    return out;
  };
  const notCreated = async (requestId: string) => (await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId, requestId), eq(t.auditLog.action, 'watch.not_created')))).map((a) => (a.diff as { reason: string }).reason);
  const watches = async (requestId: string) => h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId));

  beforeAll(async () => {
    h = await openTestDb();
    // As in production: no seller can be monitored, so a market watch is the only kind there could be.
    await h.db.update(t.adapterConfigs).set({ monitoringAllowed: false });
    await h.db.insert(t.venues).values({ id: VENUE, name: 'Moody Center ATX', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: 'America/Chicago', latitude: 30.2828, longitude: -97.7322 });
    await h.db.insert(t.entities).values({ id: ACT, kind: 'performer', name: 'Kacey Musgraves', slug: 'pw-kacey-musgraves' });
    await h.db.insert(t.events).values({ id: EVENT, name: 'Kacey Musgraves - Middle of Nowhere Tour', category: 'concert', genre: 'country / country', venueId: VENUE, primaryEntityId: ACT, localStartAt: new Date('2026-10-08T00:30:00Z'), status: 'scheduled', verifiedSourceId: 'fixture', isFixture: false, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-06-01T15:00:00Z') });
    await h.db.insert(t.eventSourceMappings).values({ eventId: EVENT, sourceId: 'ticketmaster', sourceEventId: '3A006498F97064FD', authoritativeUrl: 'https://www.ticketmaster.com/kacey-musgraves-middle-of-nowhere-tour-austin-texas-10-07-2026/event/3A006498F97064FD', role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('L03 opening (PW-ENTRY-REPLY-02): late entry is the answer, unverified, with no suggested ticket and no watch', async () => {
    const [first] = await converse([L03[0]]);
    expect(first!.text).toContain('Late entry is unverified. The 7:30pm start on the event page doesn’t tell us whether people arriving after it are let in, so I wouldn’t buy on that basis yet.');
    expect(first!.html).toContain('<strong>Late entry is unverified.</strong>');
    expect(first!.text).toContain('Before buying, confirm that this event admits people arriving after the start.');
    expect(first!.text).toContain('Nothing I have states Moody Center ATX’s last entry for that night.');
    // The link is the event page, called that, not a listing of seats.
    expect(first!.text).toContain('Here’s the event page for Kacey Musgraves - Middle of Nowhere Tour at Moody Center ATX, Wed, Oct 7 at 7:30pm:');
    expect(first!.text).toContain('I haven’t set up a price watch for this: listings don’t show whether a ticket admits people arriving after the start');
    // No shopping advice in place of the answer: no market read, no three generic questions.
    expect(first!.text).not.toMatch(/My read|When do you need|lock in seats now|Could you send a screenshot/);
    expect(await watches(first!.requestId)).toHaveLength(0);
    expect(await notCreated(first!.requestId)).toContain('unverifiable:entry_rule');
  });

  it('L03 follow-up (PW-MULTI-INTENT-01): the stop is done first, then the late-entry question is answered; nothing restarts', async () => {
    const [, second] = await converse(L03);
    expect(second!.text).toContain('There was no active price watch or alert on this request, so nothing was being monitored and there’s nothing to stop.');
    expect(second!.text).toContain('On late entry: no, I haven’t verified it. Nothing I have states Moody Center ATX’s late-entry policy for Wed, Oct 7, and I don’t have an official policy page or contact for it that I’ve checked, so I can’t point you to one. The 7:30pm start doesn’t tell us whether people arriving after it are let in, so don’t buy on that basis.');
    expect(second!.text.indexOf('nothing to stop')).toBeLessThan(second!.text.indexOf('On late entry'));
    expect(await watches(second!.requestId)).toHaveLength(0);
  });

  it('L01 (no budget): no monitoring promised, the reason is the missing budget, and the one question asks for it', async () => {
    const [first, second] = await converse(L01);
    expect(first!.text).toContain('I haven’t set up a price watch yet: I need the most you’d pay in total for both, fees included, to know what to watch for.');
    expect(first!.text).toContain('What’s the most you’d pay in total for both, fees included?');
    // One next step, not three; the event page they sent isn't a listing we failed to open.
    expect(first!.text).not.toMatch(/When do you need|lock in seats now|Could you send a screenshot|haven’t seen the one you sent/);
    expect(await notCreated(first!.requestId)).toContain('no_budget');
    // They asked to wait for a price: the open sale is a place to look, not "where I'd buy" (and no "Buy on" link).
    expect(first!.text).not.toMatch(/where I’d buy|Buy on Ticketmaster/);
    expect(first!.text).toContain('Event page on Ticketmaster:');
    expect(second!.text).toContain('There was no active price watch or alert on this request, so nothing was being monitored and there’s nothing to stop.');
    expect(second!.text).not.toContain('On late entry');
  });

  it('L02 (sections 101 through 105): the blocker named, the requirement said back cleanly, one next step', async () => {
    const [first] = await converse([L02[0]]);
    expect(first!.text).toContain('I haven’t set up a price watch for this: the resale listing data I can watch doesn’t show the sections you need, so an alert couldn’t tell you whether seats meet it. Nothing is being monitored.');
    // The model reads it as a seating preference (live: "only sections 101 through 105; other sections will not
    // work"); the rules reader here takes it from their words. Either way it's said back once, as a requirement.
    expect(first!.text).toMatch(/[Oo]nly sections 101 (?:through|to) 105/);
    expect(first!.text).not.toContain('..');
    expect(first!.text).toContain('Found seats you like? Send me the price, section and row (a screenshot works), and I’ll check them against what you need.');
    expect(first!.text).not.toMatch(/When do you need|lock in seats now|haven’t seen the one you sent/);
    expect(await notCreated(first!.requestId)).toContain('market_unverifiable:sections');
  });

  it('control: a re-entry need is not answered as a late arrival, and still stops the watch', async () => {
    const [first] = await converse([L02[0].replace('Only sections 101 through 105; other sections will not work.', 'Re-entry is required, we need to step out at the break.')]);
    expect(first!.text).not.toMatch(/Late entry is unverified|arriving after the start/);
    expect(await notCreated(first!.requestId)).toContain('market_unverifiable:entry_rule');
  });
});
