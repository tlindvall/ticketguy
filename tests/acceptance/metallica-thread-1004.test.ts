import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge, PRICE_ASKED } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Live, Oct 4 2026: after the Mohegan Sun nights were offered, "nov 19th sounds good. what are tickets like?" got
 * "Metallica isn't playing in New York then, so I've gone with Mohegan Sun Arena…" twice in one email and "How many
 * tickets?"; "I know they don't. why I said the 19th at the Mohegan Sun Arena" then went to staff ("I couldn't finish
 * this one automatically"). A pick from our own list is their choice, a price question goes ahead on two, and a venue
 * they name wins over the city they started with.
 */
const NOW = new Date('2026-10-04T17:25:00Z');
const MOHEGAN = '10000000-0000-4000-8000-0000000004a1';
const BAND = '20000000-0000-4000-8000-0000000004a1';
const NOV19 = '30000000-0000-4000-8000-0000000004a1';

class Script implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  over: Partial<RequestExtraction> = {};
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    return { ...(await this.rules.extract(input)), ...this.over } as RequestExtraction;
  }
}

describe('a show picked from the list we sent', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: MOHEGAN, name: 'Mohegan Sun Arena', city: 'Uncasville', state: 'CT', country: 'US', timezone: 'America/New_York', latitude: 41.4906, longitude: -72.0884 });
    await h.db.insert(t.entities).values({ id: BAND, kind: 'artist', name: 'Metallica', slug: 'metallica-1004', aliases: [] });
    const show = (at: string) => ({ name: 'Metallica', category: 'concert', venueId: MOHEGAN, primaryEntityId: BAND, localStartAt: new Date(at), status: 'scheduled' as const, verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' as const });
    await h.db.insert(t.events).values([{ ...show('2026-11-20T01:00:00Z'), id: NOV19 }, show('2026-11-22T01:00:00Z')]);
  });
  afterAll(async () => {
    await h.close();
  });

  const thread = async (turns: Array<{ text: string; over: Partial<RequestExtraction> }>, from: string) => {
    const x = new Script();
    const c = new Concierge({ db: h.db, env: testEnv(), extractor: x, drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null });
    let first: ReturnType<typeof inbound> | null = null;
    let requestId = '';
    for (const turn of turns) {
      x.over = turn.over;
      const m = inbound({ text: turn.text, from, subject: first ? 'Re: Metallica' : 'Metallica', receivedAt: NOW, ...(first ? { inReplyTo: first.rfcMessageId, references: first.rfcMessageId } : {}) });
      first ??= m;
      requestId = ((await c.ingestInbound(m)) as { requestId: string }).requestId;
      for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) })).filter((e) => e.eventType === 'request.interpret')) {
        const p = ev.payload as Record<string, string>;
        await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).sort((a, b) => (a.requestRevision ?? 0) - (b.requestRevision ?? 0) || a.createdAt.getTime() - b.createdAt.getTime());
    return { req: req!, last: sends.at(-1)!.bodyText, all: sends.map((s) => s.bodyText) };
  };
  const base: Partial<RequestExtraction> = { intent: 'new_search', performerOrTeam: 'Metallica', eventName: null, city: 'New York', state: 'NY', dateExpression: 'soon', resolvedLocalDate: null, quantity: null, categoryHint: 'concert' };

  it('"nov 19th sounds good. what are tickets like?": that night, on two tickets, with no "isn’t playing in New York" again', async () => {
    const r = await thread([
      { text: 'metallica tickets in new york soon', over: base },
      { text: 'nov 19th sounds good. what are tickets like?', over: { ...base, resolvedLocalDate: '2026-11-19', dateExpression: 'nov 19th' } },
    ], 'm1@customer.example');
    expect(r.all[0]).toContain('Metallica isn’t playing in New York');
    expect(r.req.eventId).toBe(NOV19);
    expect(r.req.state).not.toBe('needs_clarification');
    expect(r.req.state).not.toBe('manual_attention');
    expect(r.all.slice(1).join('\n')).not.toContain('isn’t playing in New York');
    expect(r.all.slice(1).join('\n')).not.toMatch(/How many tickets/);
  });

  it('"I know they don\'t. why I said the 19th at the Mohegan Sun Arena": the venue they named, never a hand-off', async () => {
    const r = await thread([
      { text: 'metallica tickets in new york soon', over: base },
      { text: 'nov 19th sounds good', over: { ...base, resolvedLocalDate: '2026-11-19', dateExpression: 'nov 19th' } },
      { text: 'I know they don\'t. why I said the 19th at the Mohegan Sun Arena', over: { ...base, resolvedLocalDate: '2026-11-19', dateExpression: 'the 19th' } },
    ], 'm2@customer.example');
    expect(r.req.eventId).toBe(NOV19);
    expect(r.req.state).not.toBe('manual_attention');
    expect(r.all.join('\n')).not.toMatch(/couldn’t finish this one|not at Mohegan Sun Arena/);
    // One mention at most of the place they started with, in the first reply.
    expect(r.all.slice(1).join('\n')).not.toContain('isn’t playing in New York');
  });

  it('reads price questions', () => {
    for (const q of ['what are tickets like?', 'How much are they?', "what's the price", 'how expensive is it', 'what do tickets go for']) expect(PRICE_ASKED.test(q)).toBe(true);
    expect(PRICE_ASKED.test('two tickets please')).toBe(false);
  });
});
