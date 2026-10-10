import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';

/**
 * Oct 10 audit replay: a Guide-depth event (ncaa_regular) on general sale, enforce mode, the resale key set, and no
 * count in the message ("Red Storm tickets Nov 12 please"). The Guide route skipped the count question, the resale key
 * skipped the official-sale reply, and research ran with no party size: the brief read "· null tickets" and "the most
 * you'd pay in total for all null". Guide depth has no resale research, so its open sale is the answer whatever the key
 * says, and research never starts without a count.
 */
describe('a Guide event never reaches research without a party size', () => {
  let h: DbHandle;
  const ARENA = '10000000-0000-4000-8000-0000000000f1';
  const TEAM = '20000000-0000-4000-8000-0000000000f1';
  const GAME = '30000000-0000-4000-8000-0000000000f1';
  const URL = 'https://www.ticketmaster.com/red-storm-vs-drexel-new-york-ny-11-12-2026/event/CCC123';

  const runAll = async (c: ReturnType<typeof makeConcierge>, errors: string[]) => {
    for (let i = 0; i < 6; i++) {
      const work = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
      if (!work.length) return;
      for (const ev of work) {
        const p = ev.payload as Record<string, string>;
        try {
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        } catch (e) {
          errors.push(`${ev.eventType}: ${e instanceof Error ? e.message : String(e)}`);
        }
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
  };
  const sendsFor = (requestId: string) => h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
  const researchFor = (requestId: string) => h.db.select().from(t.outboxEvents).where(and(eq(t.outboxEvents.eventType, 'research.requested'), eq(t.outboxEvents.entityId, requestId)));
  const latestBrief = async (requestId: string) => (await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId))).sort((a, b) => a.revision - b.revision).at(-1)!.brief as { quantity: number | null };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Carnesecca Arena', city: 'Queens', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: "St. John's Red Storm", slug: 'st-johns-red-storm', aliases: ['Red Storm', "St. John's"], league: 'NCAA', homeVenueId: ARENA });
    await h.db.insert(t.events).values({ id: GAME, name: "St. John's Red Storm vs. Drexel", category: 'ncaa_regular', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-11-13T00:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), publicSaleEndAt: null });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME, sourceId: 'ticketmaster', sourceEventId: 'CCC123', authoritativeUrl: URL, role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => { await h.close(); });

  for (const key of ['', 'sd-test-key']) {
    it(`no count, resale key ${key ? 'set' : 'unset'}: the official-sale answer, no research, never "null"`, async () => {
      const env = testEnv({ SERVICE_POLICY_MODE: 'enforce', ...(key ? { SEATDATA_API_KEY: key } : {}) });
      const c = makeConcierge(h, { env });
      const errors: string[] = [];
      const r = (await c.ingestInbound(inbound({ text: 'Red Storm tickets Nov 12 please', from: `guide-${key ? 'key' : 'nokey'}@customer.example`, subject: 'Red Storm' }))) as { requestId: string };
      await runAll(c, errors);
      expect(errors).toEqual([]);
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
      expect(req!.eventId).toBe(GAME);
      expect(req!.state).toBe('referred');
      expect(await researchFor(r.requestId)).toHaveLength(0);
      const sends = await sendsFor(r.requestId);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.subject).toBe('Re: Red Storm');
      expect(sends[0]!.bodyText).toContain('is still on general sale on Ticketmaster');
      expect(sends[0]!.bodyText).toContain(URL);
      expect(sends.map((s) => s.bodyText).join('\n')).not.toMatch(/\bnull\b|\bundefined\b/);
    });
  }

  it('their own offers for a Guide event with no count: research goes ahead on two, said once, and no "null" anywhere', async () => {
    const env = testEnv({ SERVICE_POLICY_MODE: 'enforce', SEATDATA_API_KEY: 'sd-test-key' });
    const c = makeConcierge(h, { env });
    const errors: string[] = [];
    const r = (await c.ingestInbound(inbound({ text: 'Red Storm vs Drexel on Nov 12. Offer A is section 101 at $45 each, Offer B is section 104 at $52 each. Which is the better buy?', from: 'guide-offers@customer.example', subject: 'Red Storm' }))) as { requestId: string };
    await runAll(c, errors);
    expect(errors).toEqual([]);
    expect(await researchFor(r.requestId)).toHaveLength(1);
    expect((await latestBrief(r.requestId)).quantity).toBe(2);
    const text = (await sendsFor(r.requestId)).map((s) => s.bodyText).join('\n');
    expect(text).toContain("I've assumed two tickets. Just tell me if you need a different number.");
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/);
    const assumed = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'request.quantity_assumed'), eq(t.auditLog.entityId, r.requestId)));
    expect(assumed).toHaveLength(1);
  });

  it('research handed a brief with no count leaves it alone rather than writing "null tickets"', async () => {
    const env = testEnv({ SERVICE_POLICY_MODE: 'enforce', SEATDATA_API_KEY: 'sd-test-key' });
    const c = makeConcierge(h, { env });
    const r = (await c.ingestInbound(inbound({ text: 'Red Storm vs Drexel Nov 12, is resale cheaper? 2 tickets', from: 'guide-guard@customer.example', subject: 'Red Storm' }))) as { requestId: string };
    for (const ev of await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW })) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret' && p.requestId === r.requestId) await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    // A route that let the count through: the stored brief has none.
    const version = (await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId))).find((v) => v.revision === req!.currentRevision)!;
    await h.db.update(t.requestVersions).set({ brief: { ...(version.brief as Record<string, unknown>), quantity: null } }).where(eq(t.requestVersions.id, version.id));
    // Skipped and recorded, not thrown: a throw retried until the job went dead and came back to staff with no draft.
    await expect(c.research({ requestId: r.requestId, revision: req!.currentRevision })).resolves.toEqual({ recommendationId: null, state: req!.state });
    expect(await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'research.skipped_no_party_size'), eq(t.auditLog.entityId, r.requestId)))).toHaveLength(1);
    const text = (await sendsFor(r.requestId)).map((s) => s.bodyText).join('\n');
    expect(text).not.toMatch(/\bnull\b/);
    expect(await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).toHaveLength(0);
  });
});
