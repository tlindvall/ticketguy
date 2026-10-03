import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { qaTrace } from '@/lib/admin/test-inbox';
import { resolveLinks } from '@/lib/domain/link-resolution';
import { suppliedOfficialReference } from '@/lib/domain/ticket-links';

/**
 * LAUNCH-10 (final launch spec, Workstream G): a QA trace answers what was read, which event it belonged to, what was
 * asked, which source was checked or skipped and why, what each link came to, which model answered each turn, and the
 * trend read with its clocks, without a production shell. Never a query string, token or message body beyond the
 * customer's own words the trace already shows.
 */
describe('LAUNCH-10: the QA trace says what was read and why the answer followed', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('per-link outcomes: malformed, checkout without an event, unsupported host; host and path only', async () => {
    const c = makeConcierge(h, { now: () => FIXTURE_NOW });
    const text = 'Can you check these for the Knicks on October 24 at MSG? Two tickets.\nhttps://www.stubhub.com/%ZZ/event/161564036/?quantity=2\nhttps://checkout.stubhub.com/secure/buy/checkout?ID=0213e7be-859d-4bd5-b95f-1a6ae41980d0%7c14301890103%7c2%7c0\nhttps://broadwaydirect.com/show/hamilton/';
    const r = (await c.ingestInbound(inbound({ text, from: 'diag@customer.example', subject: 'Tickets', receivedAt: FIXTURE_NOW }))) as { requestId: string };
    for (let j = 0; j < 6; j++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(FIXTURE_NOW.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const messages = await h.db.select().from(t.messages).where(eq(t.messages.conversationId, req!.conversationId)).orderBy(asc(t.messages.receivedAt));
    const intents = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, req!.id));
    const trace = await qaTrace(h.db, req!, messages, intents);
    const d = trace.diagnostics;
    expect(d.links).toHaveLength(3);
    expect(d.links[0]).toMatchObject({ host: 'www.stubhub.com', url: 'www.stubhub.com/%ZZ/event/161564036/', parse: 'malformed', link: { marketplace: 'stubhub', eventId: '161564036', quantity: 2 }, event: { status: 'resolved' } });
    expect(d.links[1]).toMatchObject({ host: 'checkout.stubhub.com', url: 'checkout.stubhub.com/secure/buy/checkout', parse: 'ok', link: { listingId: '14301890103', quantity: 2, eventId: null } });
    expect(d.links[2]).toMatchObject({ host: 'broadwaydirect.com', parse: 'unsupported_host', link: null });
    // A Broadway Direct page for another show is no reference for a Knicks game.
    expect(intents.map((i) => i.bodyText).join('\n')).not.toContain('Broadway Direct');
    // Never the cart id in the query string.
    expect(JSON.stringify(d)).not.toContain('0213e7be');
    expect(d.questionsDetected).toBeTruthy();
    expect(Array.isArray(d.modelCalls)).toBe(true);
    expect(Array.isArray(d.sourceReads)).toBe(true);
  });

  it('the selected listing lookup reads as matched, unmatched, skipped or unavailable, with the provider clock', () => {
    const url = 'https://www.stubhub.com/new-york-rangers-new-york-tickets-10-6-2026/event/161564036/?quantity=2&listingId=14251313815';
    const one = (action: string, diff: Record<string, unknown>) => resolveLinks([url], { eventId: 'e1', audits: [{ action, diff }] })[0]!.listing;
    expect(one('listing.link_matched', { marketplace: 'stubhub', read: true, providerAsOf: '2026-10-02T21:00:00.000Z', retrievedAt: '2026-10-02T22:10:00.000Z' })).toEqual({ status: 'matched', reason: null, providerAsOf: '2026-10-02T21:00:00.000Z', retrievedAt: '2026-10-02T22:10:00.000Z' });
    expect(one('listing.link_unmatched', { marketplace: 'stubhub', read: true, providerAsOf: null, retrievedAt: '2026-10-02T22:10:00.000Z' })).toMatchObject({ status: 'unmatched', reason: 'listing_not_in_feed', providerAsOf: null });
    expect(one('listing.link_unmatched', { marketplace: 'stubhub', read: false })).toMatchObject({ status: 'unavailable' });
    expect(one('listing.link_skipped', { marketplace: 'stubhub', gates: ['licence_quarantined', 'licence_no_display'] })).toMatchObject({ status: 'skipped', reason: 'licence_quarantined,licence_no_display' });
    expect(resolveLinks([url], { eventId: null, audits: [] })[0]).toMatchObject({ event: { status: 'not_found' }, listing: { status: 'not_requested' } });
    expect(resolveLinks(['not a url'], { eventId: null, audits: [] })[0]).toMatchObject({ parse: 'not_a_url', link: null });
  });

  it('LAUNCH-07: only the show’s own Broadway Direct page counts as a reference, never a lottery, terms or another show', () => {
    expect(suppliedOfficialReference(['https://broadwaydirect.com/show/hamilton/'], 'Hamilton (NY) Hamilton (NY)')).toEqual({ seller: 'Broadway Direct', url: 'https://broadwaydirect.com/show/hamilton/' });
    expect(suppliedOfficialReference(['https://www.broadwaydirect.com/show/hamilton/?utm=x'], 'Hamilton (NY)')).toEqual({ seller: 'Broadway Direct', url: 'https://www.broadwaydirect.com/show/hamilton/' });
    expect(suppliedOfficialReference(['https://lottery.broadwaydirect.com/terms/'], 'Hamilton (NY)')).toBeNull();
    expect(suppliedOfficialReference(['https://broadwaydirect.com/show/wicked/'], 'Hamilton (NY)')).toBeNull();
    expect(suppliedOfficialReference(['https://broadwaydirect.com/show/hamilton/'], 'New York Knicks vs. Fixture Opponent')).toBeNull();
    expect(suppliedOfficialReference(['http://broadwaydirect.com/show/hamilton/'], 'Hamilton (NY)')).toBeNull();
  });
});
