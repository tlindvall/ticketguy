import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';

/**
 * Live thread, Oct 15 (Rangers): "2 tickets. Max $150" got a $246 pair over budget and "Would you go up to about $246?";
 * "yes what other games can I see for that price? total yes." got the same email back. The question after "yes" is
 * the request: the team's games with a pair inside the budget, all-in, cheapest first, home first, away said as away.
 */
const NOW = '2026-10-15T18:06:00Z';
const run = (steps: string[]) => runThread({ id: 'rangers-oct15', capability: 'x', now: NOW, steps: steps.map((text) => ({ text })) } as unknown as Scenario, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() }) as Promise<TurnOut[]>;
const head = ['what rangers games are coming up?', 'Nov 16 vs Montreal'];

describe('which other games fit the budget (live Oct 15, Rangers)', () => {
  it('lists the games with a pair at $150 or less all-in: home first, cheapest first, the away game said as away', async () => {
    const turns = await run([...head, '2 tickets. Max $150', 'yes what other games can I see for that price? total yes.']);
    const [three, four] = [turns[2]!, turns[3]!];
    expect(four.reply).not.toBe(three.reply);
    // Four with #190's Nov 25 Kings game in the eval world ($140 for two).
    expect(four.reply).toContain('Four Rangers games have a pair at $150 or less, all-in, home games first:');
    const flyers = four.reply.indexOf('Philadelphia Flyers at Madison Square Garden, $138 for both, all-in');
    const kings = four.reply.indexOf('Los Angeles Kings at Madison Square Garden, $140 for both, all-in');
    const sabres = four.reply.indexOf('Buffalo Sabres at Madison Square Garden, $149 for both, all-in');
    const away = four.reply.indexOf('New York Islanders vs. New York Rangers at UBS Arena (away), $120 for both, all-in');
    expect(flyers).toBeGreaterThan(-1);
    expect(kings).toBeGreaterThan(flyers);
    expect(sabres).toBeGreaterThan(kings);
    expect(away).toBeGreaterThan(sabres);
    // Over budget, or only cheaper because it's obstructed: not offered.
    expect(four.reply).not.toMatch(/Montreal Canadiens|Boston Bruins|\$110|go up to about/);
    // Never a yes to our question; one next step, no question back.
    expect(four.brief?.budgetCents).toBe(15000);
    expect(four.reply).toContain('Reply with the date and I’ll send the seats.');
    expect((four.reply.match(/\?/g) ?? []).length).toBe(0);
  }, 60_000);

  it('nothing inside the budget: the cheapest game and its price', async () => {
    const turns = await run([...head, '2 tickets. Max $100', 'what other games can I see for that price?']);
    expect(turns[3]!.reply).toMatch(/None of the next \w+ Rangers games has a pair at \$100 or less, all-in\. The cheapest is New York Islanders vs\. New York Rangers on Sat, Nov 14, at UBS Arena \(away\): \$120 for both\./);
  }, 60_000);

  it('a per-ticket budget is checked as the total for the party', async () => {
    const turns = await run([...head, '2 tickets, $75 each max', 'any other games for that price?']);
    expect(turns[3]!.reply).toContain('a pair at $75 a ticket ($150 for both) or less, all-in');
  }, 60_000);

  it('the next reply picks from that list', async () => {
    const turns = await run([...head, '2 tickets. Max $150', 'yes what other games can I see for that price? total yes.', 'Nov 10']);
    expect(turns[4]!.eventId).toBe('7e7e0000-0000-4000-8000-000000000240');
  }, 60_000);
});

describe('never the same reply twice in a thread', () => {
  it('off with the rules drafter unless asked (it cannot reword a restated answer)', async () => {
    const h2 = await openTestDb();
    const c = makeConcierge(h2);
    const r = (await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3, $300 total', from: 'off@customer.example' }))) as { requestId: string; conversationId: string; contactId: string };
    const send = (key: string) => c.queueSend({ messageClass: 'no_result', contactId: r.contactId, conversationId: r.conversationId, requestId: r.requestId, revision: 1, recipient: 'off@customer.example', subject: 'Re', template: 'raw_auto', vars: { text: 'Hey,\n\nThe closest pair is $246 for both.', html: '<p>x</p>' }, inReplyTo: null, approvalId: null, approvedHash: null, dedupeKey: key });
    expect((await send('off:1')).created).toBe(true);
    expect((await send('off:2')).created).toBe(true);
    await h2.close();
  });

  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('the same question answered the same way is not held back (a clarification can repeat: TGQA-R6 25)', async () => {
    const c = makeConcierge(h, { repeatGuard: true });
    const r = (await c.ingestInbound(inbound({ text: 'Two Knicks tickets Oct 24, $300 total', from: 'clar@customer.example' }))) as { requestId: string; conversationId: string; contactId: string };
    const send = (key: string) => c.queueSend({ messageClass: 'clarification', contactId: r.contactId, conversationId: r.conversationId, requestId: r.requestId, revision: 1, recipient: 'clar@customer.example', subject: 'Re: Knicks', template: 'raw_auto', vars: { text: 'Hey,\n\nI can’t email you when tickets go on sale: automatic on-sale alerts are switched off for now.', html: '<p>No alerts.</p>' }, inReplyTo: null, approvalId: null, approvedHash: null, dedupeKey: key });
    expect((await send('clar:1')).created).toBe(true);
    expect((await send('clar:2')).created).toBe(true);
  });

  it('a drafted answer that repeats the last one is not sent; a person answers instead (model drafter)', async () => {
    const c = makeConcierge(h, { repeatGuard: true });
    const r = (await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3, $300 total', from: 'repeat@customer.example' }))) as { requestId: string; conversationId: string; contactId: string };
    for (let i = 0; i < 5; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
    const send = (key: string) => c.queueSend({ messageClass: 'no_result', contactId: r.contactId, conversationId: r.conversationId, requestId: r.requestId, revision: 1, recipient: 'repeat@customer.example', subject: 'Re: Rangers', template: 'raw_auto', vars: { text: 'Hey,\n\nThe closest pair is $246 for both, $96 over your $150. Would you go up to about $246, or should I look at other games?', html: '<p>The closest pair is $246.</p>' }, inReplyTo: null, approvalId: null, approvedHash: null, dedupeKey: key });
    const first = await send('test:first');
    expect(first.created).toBe(true);
    const again = await send('test:again');
    expect(again).toMatchObject({ created: false, repeatBlocked: true });
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('manual_attention');
    const intents = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.conversationId, r.conversationId));
    expect(intents.filter((x) => x.dedupeKey === 'test:again')).toHaveLength(0);
    expect(intents.some((x) => x.dedupeKey === `holding:${r.requestId}`)).toBe(true);
    const [log] = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId, r.requestId), eq(t.auditLog.action, 'send.repeat_blocked')));
    expect(log).toBeDefined();
  });
});
