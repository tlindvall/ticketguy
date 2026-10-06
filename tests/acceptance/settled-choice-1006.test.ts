import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { RequestExtraction } from '@/lib/domain/types';

const NOW = new Date('2026-10-06T14:00:00Z');
const NOV19 = '30000000-0000-4000-8000-0000000009a1';
class Script implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  over: Partial<RequestExtraction> = {};
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    return { ...(await this.rules.extract(input)), ...this.over } as RequestExtraction;
  }
}
/**
 * Live, Oct 6 2026: right after the Nov 19 Metallica seats were sent ("Section 111 · Row F: $2,132.98 for two"), the
 * next email asked "Which show: Thu, Nov 19 at Mohegan Sun Arena or Sat, Nov 21 at Mohegan Sun Arena?". A choice the
 * customer made is never asked again, however the choice got reopened: a fresh email, or a revision that lost it.
 */
describe('a show they already chose is never asked about again', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: '10000000-0000-4000-8000-0000000009a1', name: 'Mohegan Sun Arena', city: 'Uncasville', state: 'CT', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: '20000000-0000-4000-8000-0000000009a1', kind: 'artist', name: 'Metallica', slug: 'm-9', aliases: [] });
    const show = (at: string) => ({ name: 'Metallica', category: 'concert', venueId: '10000000-0000-4000-8000-0000000009a1', primaryEntityId: '20000000-0000-4000-8000-0000000009a1', localStartAt: new Date(at), status: 'scheduled' as const, verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' as const });
    await h.db.insert(t.events).values([{ ...show('2026-11-20T01:00:00Z'), id: NOV19 }, show('2026-11-22T01:00:00Z')]);
  });
  afterAll(async () => {
    await h.close();
  });
  const base: Partial<RequestExtraction> = { intent: 'new_search', performerOrTeam: 'Metallica', eventName: null, city: null, state: 'CT', dateExpression: null, resolvedLocalDate: null, quantity: null, categoryHint: 'concert' };
  let n = 0;
  const run = async (turns: Array<{ text: string; over: Partial<RequestExtraction>; fresh?: boolean; before?: (rid: string) => Promise<void> }>) => {
    const x = new Script();
    const c = new Concierge({ db: h.db, env: testEnv(), extractor: x, drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null });
    const from = `settled-${++n}@customer.example`;
    let first: ReturnType<typeof inbound> | null = null;
    let rid = '';
    const out: Array<{ eventId: string | null; text: string }> = [];
    for (const tu of turns) {
      if (tu.before) await tu.before(rid);
      const seen = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((x) => x.id));
      x.over = tu.over;
      if (tu.fresh) first = null;
      const m = inbound({ text: tu.text, from, subject: first ? 'Re: Metallica' : 'Metallica', receivedAt: NOW, ...(first ? { inReplyTo: first.rfcMessageId, references: first.rfcMessageId } : {}) });
      first ??= m;
      rid = ((await c.ingestInbound(m)) as { requestId: string }).requestId;
      for (const ev of await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) })) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, rid));
      const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, rid))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      out.push({ eventId: req!.eventId, text: sends.filter((x) => !seen.has(x.id)).map((x) => x.bodyText).join('\n----\n') });
    }
    return out;
  };
  it('a fresh email about the same act: the night they chose, said in a line they can correct', async () => {
    const r = await run([
      { text: 'how are metallica tickets trending in CT', over: base },
      { text: 'the 19th', over: { ...base, dateExpression: 'the 19th' } },
      { text: 'metallica in CT, 2 tickets', over: { ...base, quantity: 2 }, fresh: true },
    ]);
    expect(r[1]!.eventId).toBe(NOV19);
    expect(r[2]!.eventId).toBe(NOV19);
    expect(r[2]!.text).not.toMatch(/Which show/);
    expect(r[2]!.text).toContain('the show we already looked at. Tell me if you meant a different one, like Sat, Nov 21.');
  });
  it('a reply after the request lost its event: still that night', async () => {
    const r = await run([
      { text: 'how are metallica tickets trending in CT', over: base },
      { text: 'the 19th', over: { ...base, dateExpression: 'the 19th' } },
      { text: 'It’s not a game, it’s a concert. you should know what Metallica is.', over: { ...base, quantity: 2 }, before: async (rid) => { await h.db.update(t.requests).set({ eventId: null }).where(eq(t.requests.id, rid)); } },
    ]);
    expect(r[2]!.eventId).toBe(NOV19);
    expect(r[2]!.text).not.toMatch(/Which show|\bgames?\b/);
  });
});
