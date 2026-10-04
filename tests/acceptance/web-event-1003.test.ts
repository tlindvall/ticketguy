import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { groundedEvents, lastJsonObject, type WebEventFinder, type WebEventQuery } from '@/lib/ai/web-events';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Live, Oct 3 2026, 4:32 p.m. in New York: "is there a soho house festival in new york today?" got "Which event
 * (performer or team, city, and date) are you looking at?". A web search shows the first Soho House Festival New York
 * that afternoon, 2 to 10 p.m. at The Rooftop at Pier 17, sold by Soho House: on no catalog or resale feed we read.
 * The catalog miss now goes to the open web once, and what a found page says is the answer, with its link.
 */
const NOW = new Date('2026-10-03T20:32:00Z');
const SOHO = 'https://www.sohohouse.com/en-us/events/soho-house-festival-new-york';
const IG = 'https://www.instagram.com/p/sohohousefestivalny';

/** The rules reader, with what the production model reads for these messages put over it. */
class LiveFields implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  constructor(private readonly over: Partial<RequestExtraction>) {}
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    return { ...(await this.rules.extract(input)), ...this.over } as RequestExtraction;
  }
}

class FakeWeb implements WebEventFinder {
  readonly name = 'fake_web';
  lastUsage = { inputTokens: 12_000, outputTokens: 600 };
  asked: WebEventQuery[] = [];
  constructor(private readonly answer: unknown, private readonly urls: string[]) {}
  async find(q: WebEventQuery) {
    this.asked.push(q);
    return { events: groundedEvents(this.answer, new Set(this.urls)), searches: 2, resultUrls: this.urls.length };
  }
}

const FESTIVAL = { events: [{ name: 'Soho House Festival New York', venue: 'The Rooftop at Pier 17', city: 'New York', date: '2026-10-03', startTime: '14:00', endTime: '22:00', ticketUrl: SOHO, sourceUrl: SOHO, seller: 'Soho House' }] };

describe('an event that is only on the open web', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  let seq = 0;
  const ask = async (text: string, web: WebEventFinder | undefined, over: Partial<RequestExtraction>, env = testEnv()) => {
    seq += 1;
    const c = new Concierge({ db: h.db, env, extractor: new LiveFields(over), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null, webEventFinder: web });
    const r = (await c.ingestInbound(inbound({ text, from: `web${seq}@customer.example`, subject: '', receivedAt: NOW }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { req: req!, body: sends.map((s) => s.bodyText).join('\n----\n'), html: sends.map((s) => s.bodyHtml ?? '').join('\n') };
  };
  const soho: Partial<RequestExtraction> = { intent: 'new_search', performerOrTeam: null, eventName: 'Soho House Festival', city: 'New York', state: 'NY', resolvedLocalDate: '2026-10-03', dateExpression: 'today', quantity: null };

  it('the live question: the festival, today, its hours and place, who sells it, and the link; never "Which event?"', async () => {
    const web = new FakeWeb(FESTIVAL, [SOHO, IG]);
    const r = await ask('is there a soho house festival in new york today?', web, soho);
    expect(web.asked[0]).toMatchObject({ name: 'Soho House Festival', city: 'New York', date: '2026-10-03', today: '2026-10-03' });
    expect(r.body).toContain('Hey,\n\nSoho House Festival New York is today, Saturday, October 3, from 2 to 10 p.m., at The Rooftop at Pier 17 in New York.\n\nTickets are sold by Soho House, not on the resale sites I check, so I can’t see prices or what’s left.');
    expect(r.body).toContain(`Tickets from Soho House: ${SOHO}`);
    expect(r.body).not.toMatch(/Which event|performer or team|Thanks for getting in touch/);
    expect(r.html).toContain('<strong>Soho House Festival New York is today, Saturday, October 3, from 2 to 10 p.m., at The Rooftop at Pier 17 in New York.</strong>');
    expect(r.req.state).toBe('referred');
    const [log] = await h.db.select().from(t.auditLog).where(eq(t.auditLog.entityId, r.req.id));
    expect(log).toBeDefined();
  });

  it('a page the search never returned is never the answer, and a link it didn’t return is never sent', async () => {
    // The model "found" it on a page that wasn't among the results: dropped, so the usual question stands.
    const r = await ask('is there a soho house festival in new york today?', new FakeWeb(FESTIVAL, [IG]), soho);
    expect(r.body).not.toContain('Soho House Festival New York is today');
    expect(r.req.state).not.toBe('referred');
    // Found on a real result page, but its ticket link was made up: the event stands, the link is the page itself.
    const kept = groundedEvents({ events: [{ ...FESTIVAL.events[0], ticketUrl: 'https://tickets.example/soho', sourceUrl: IG }] }, new Set([IG]));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.ticketUrl).toBeNull();
    expect(groundedEvents({ events: [{ ...FESTIVAL.events[0], sourceUrl: 'http://www.sohohouse.com/x' }] }, new Set(['http://www.sohohouse.com/x']))).toHaveLength(0);
    expect(groundedEvents('not json', new Set([SOHO]))).toEqual([]);
    expect(lastJsonObject('Here is what I found.\n```json\n{"events":[]}\n```')).toEqual({ events: [] });
  });

  it('switched off, or over the day’s limit, it doesn’t search', async () => {
    const off = new FakeWeb(FESTIVAL, [SOHO]);
    await ask('is there a soho house festival in new york today?', off, soho, testEnv({ WEB_EVENT_SEARCH: 'off' }));
    expect(off.asked).toHaveLength(0);
    const capped = new FakeWeb(FESTIVAL, [SOHO]);
    const r = await ask('is there a soho house festival in new york today?', capped, soho, testEnv({ WEB_EVENT_SEARCH_DAILY_LIMIT: '0' }));
    expect(capped.asked).toHaveLength(0);
    const [skip] = await h.db.select().from(t.auditLog).where(eq(t.auditLog.entityId, r.req.id));
    expect(skip!.action).toBe('web.event_search_skipped');
  });

  // "It's repeating itself" (live Oct 3, Metallica): a follow-up about an event found on the web gets a short answer from
  // what was found, with no second search and not the whole first email again. Another act is a new search.
  it('a reply in the same thread is answered from what was found: one search, a short line, the link', async () => {
    const web = new FakeWeb(FESTIVAL, [SOHO, IG]);
    const env = testEnv();
    const run = async (c: Concierge, text: string, first?: ReturnType<typeof inbound>) => {
      const m = inbound({ text, from: 'thread@customer.example', subject: first ? 'Re: Soho' : 'Soho', receivedAt: NOW, ...(first ? { inReplyTo: first.rfcMessageId, references: first.rfcMessageId } : {}) });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) })).filter((e) => e.eventType === 'request.interpret')) {
        const p = ev.payload as Record<string, string>;
        await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
      return { m, requestId: r.requestId };
    };
    const c1 = new Concierge({ db: h.db, env, extractor: new LiveFields(soho), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null, webEventFinder: web });
    const a = await run(c1, 'is there a soho house festival in new york today?');
    const c2 = new Concierge({ db: h.db, env, extractor: new LiveFields({ ...soho, quantity: 2 }), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null, webEventFinder: web });
    const b = await run(c2, '2 tickets please', a.m);
    expect(b.requestId).toBe(a.requestId);
    expect(web.asked).toHaveLength(1);
    const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, a.requestId))).map((x) => x.bodyText);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain('Hey,\n\nSoho House Festival New York is sold by Soho House, not on the resale sites I check, so I still can’t see prices or seats for it. You can buy there:\n\n' + `Tickets from Soho House: ${SOHO}`);
    expect(sends[1]).not.toContain('is today, Saturday, October 3');
    // Another act in the same thread is searched for.
    const c3 = new Concierge({ db: h.db, env, extractor: new LiveFields({ ...soho, eventName: null, performerOrTeam: 'Alanis Morissette' }), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null, webEventFinder: web });
    await run(c3, 'Allan morisett is playing on pier 17', a.m);
    expect(web.asked).toHaveLength(2);
    expect(web.asked[1]!.name).toBe('Alanis Morissette');
  });
});
