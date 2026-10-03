import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW, FIXTURE_OFFERS } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { DISCOVERY_SOURCE_ID } from '@/lib/catalog/sync';
import { evaluateGate } from '@/lib/email/send-gate';

/**
 * "Email me when it goes on sale / when they announce a date" (DECISION_LOG #43). No prices, so no resale
 * source is needed: Ticketmaster Discovery is checked on a schedule and the alert fires once.
 */
const HOUR = 3_600_000;

function show(over: { id: string; status: string; saleStart: string | null; localDate?: string; dateTime?: string; city?: string; state?: string; venue?: string }) {
  const venue = { id: `v-${over.venue ?? 'msg'}`, name: over.venue ?? 'Madison Square Garden', city: { name: over.city ?? 'New York' }, state: { stateCode: over.state ?? 'NY' }, country: { countryCode: 'US' }, timezone: 'America/New_York' };
  return {
    id: over.id,
    name: 'Nova Vale',
    type: 'event',
    url: `https://www.ticketmaster.com/nova-vale-new-york/event/${over.id}`,
    dates: { start: { localDate: over.localDate ?? '2026-11-20', localTime: '20:00:00', dateTime: over.dateTime ?? '2026-11-21T01:00:00Z', timeTBA: false, noSpecificTime: false }, timezone: 'America/New_York', status: { code: over.status } },
    sales: { public: { startDateTime: over.saleStart, endDateTime: null } },
    classifications: [{ primary: true, segment: { name: 'Music' }, genre: { name: 'Pop' }, subGenre: { name: 'Pop' } }],
    _embedded: { venues: [venue], attractions: [{ id: 'K8nova', name: 'Nova Vale', url: 'https://www.ticketmaster.com/nova-vale-tickets/artist/K8nova', classifications: [{ segment: { name: 'Music' }, genre: { name: 'Pop' } }] }] },
  };
}

describe('event alerts', () => {
  let h: DbHandle;
  let now = FIXTURE_NOW;
  let listed: unknown[] = [];
  const fetchImpl = (async () => new Response(JSON.stringify({ _embedded: { events: listed } }), { status: 200 })) as typeof fetch;
  const concierge = (over: Record<string, string> = {}) =>
    new Concierge({ db: h.db, env: testEnv({ TICKETMASTER_DISCOVERY_ENABLED: 'true', TICKETMASTER_DISCOVERY_API_KEY: 'tm-test-key', EVENT_ALERTS_ENABLED: 'true', ...over }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, fixtureOffers: FIXTURE_OFFERS, discoveryFetch: fetchImpl });

  const interpretAll = async (c: Concierge) => {
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, now);
    }
  };
  const ask = async (c: Concierge, text: string, from: string, thread?: { rfcMessageId: string | null }) => {
    const msg = inbound({ text, from, subject: thread ? 'Re: Nova Vale' : 'Nova Vale', ...(thread?.rfcMessageId ? { inReplyTo: thread.rfcMessageId, references: thread.rfcMessageId } : {}) });
    const r = (await c.ingestInbound(msg)) as { requestId: string };
    await interpretAll(c);
    return { requestId: r.requestId, rfcMessageId: msg.rfcMessageId };
  };
  const sends = (requestId: string) => h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId)).orderBy(desc(t.sendIntents.createdAt));
  const alertsFor = (requestId: string) => h.db.select().from(t.eventAlerts).where(eq(t.eventAlerts.requestId, requestId));
  const stateOf = async (requestId: string) => (await h.db.select().from(t.requests).where(eq(t.requests.id, requestId)))[0]!.state;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.adapterConfigs).values({ sourceId: DISCOVERY_SOURCE_ID, implementation: 'ticketmaster_discovery', enabled: true, capabilities: ['discovery', 'event_lookup'], accessApprovalEvidence: 'test: developer terms accepted', monitoringAllowed: false, reviewedBy: 'test' }).onConflictDoUpdate({ target: t.adapterConfigs.sourceId, set: { enabled: true, implementation: 'ticketmaster_discovery' } });
    await h.db.insert(t.entities).values({ kind: 'artist', name: 'Nova Vale', slug: 'nova-vale', aliases: [] });
  });
  afterAll(async () => {
    await h.close();
  });

  it('nothing announced yet: sets a new-date alert, says so, and emails once when a date appears', async () => {
    const c = concierge();
    listed = [];
    const { requestId } = await ask(c, 'Let me know when Nova Vale announces New York dates', 'newdate@customer.example');
    const [alert] = await alertsFor(requestId);
    expect(alert).toMatchObject({ kind: 'new_date', state: 'active', keyword: 'Nova Vale', marketId: 'new-york' });
    expect(await stateOf(requestId)).toBe('monitoring');
    const [reply] = await sends(requestId);
    expect(reply!.messageClass).toBe('acknowledgment');
    expect(reply!.bodyText).toContain("Nothing's scheduled for Nova Vale in New York yet. I'll email you as soon as a date is announced.");

    // Not due yet: nothing is checked.
    expect((await c.evaluateEventAlerts()).checked).toBe(0);

    // A day later the show is listed.
    now = new Date(FIXTURE_NOW.getTime() + 25 * HOUR);
    listed = [show({ id: 'nv1', status: 'offsale', saleStart: '2026-10-01T14:00:00Z' })];
    const pass = await c.evaluateEventAlerts();
    expect(pass).toMatchObject({ checked: 1, sent: 1 });
    const [fired] = await alertsFor(requestId);
    expect(fired!.state).toBe('sent');
    const [alertMail] = await sends(requestId);
    expect(alertMail!.messageClass).toBe('event_alert');
    expect(alertMail!.approvalId).toBeNull();
    expect(alertMail!.bodyText).toContain('Nova Vale just announced a date in New York:');
    expect(alertMail!.bodyText).toContain('https://www.ticketmaster.com/nova-vale-new-york/event/nv1');
    expect(await stateOf(requestId)).toBe('referred');

    // It fires once.
    now = new Date(now.getTime() + 25 * HOUR);
    expect((await c.evaluateEventAlerts()).sent).toBe(0);
  });

  it('not on sale yet: sets an on-sale alert with the published date, and emails when the sale opens', async () => {
    const c = concierge();
    listed = [show({ id: 'nv1', status: 'offsale', saleStart: '2026-10-01T14:00:00Z' })];
    const { requestId } = await ask(c, 'Let me know when Nova Vale tickets go on sale for Nov 20 in New York', 'onsale@customer.example');
    const [alert] = await alertsFor(requestId);
    expect(alert).toMatchObject({ kind: 'on_sale', state: 'active' });
    expect(alert!.nextCheckAt.getTime()).toBeLessThanOrEqual(now.getTime() + 24 * HOUR);
    const [reply] = await sends(requestId);
    expect(reply!.bodyText).toContain("isn't on general sale yet. Ticketmaster lists the general sale opening Thu, Oct 1 at 10:00 AM EDT. I'll email you the moment it opens, with the link.");

    // The day before, still closed: checked, not sent, next check no later than just after the sale time.
    now = new Date('2026-09-30T15:00:00Z');
    await h.db.update(t.eventAlerts).set({ nextCheckAt: now }).where(eq(t.eventAlerts.id, alert!.id));
    expect(await c.evaluateEventAlerts()).toMatchObject({ checked: 1, sent: 0 });
    const [waiting] = await alertsFor(requestId);
    expect(waiting!.nextCheckAt.toISOString()).toBe('2026-10-01T14:02:00.000Z');

    // Just after the sale opens, the provider says on sale.
    now = new Date('2026-10-01T14:05:00Z');
    listed = [show({ id: 'nv1', status: 'onsale', saleStart: '2026-10-01T14:00:00Z' })];
    expect(await c.evaluateEventAlerts()).toMatchObject({ checked: 1, sent: 1 });
    const [mail] = await sends(requestId);
    expect(mail!.messageClass).toBe('event_alert');
    expect(mail!.bodyText).toContain('Good news: Nova Vale');
    expect(mail!.bodyText).toContain('is on general sale now on Ticketmaster.');
    expect(mail!.bodyText).toContain('https://www.ticketmaster.com/nova-vale-new-york/event/nv1');
  });

  it('offers the alert when nothing is scheduled, and "let me know" takes it up', async () => {
    const c = concierge();
    listed = [];
    now = new Date('2026-10-02T12:00:00Z');
    const first = await ask(c, '2 tickets to Nova Vale in Chicago', 'offer@customer.example');
    const [q] = await sends(first.requestId);
    expect(q!.messageClass).toBe('clarification');
    // The show on file elsewhere (New York) is offered, and so is waiting for a Chicago date.
    expect(q!.bodyText).toContain('Nova Vale isn’t playing in Chicago');
    expect(q!.bodyText).toContain('Rather wait for a Chicago date? Reply "let me know" and I’ll email you when one is announced.');
    const reply = await ask(c, 'yes please, let me know', 'offer@customer.example', first);
    expect(reply.requestId).toBe(first.requestId);
    const [alert] = await alertsFor(first.requestId);
    expect(alert).toMatchObject({ kind: 'new_date', marketId: 'chicago' });
  });

  it('does nothing while switched off', async () => {
    const c = concierge({ EVENT_ALERTS_ENABLED: 'false' });
    listed = [];
    const { requestId } = await ask(c, 'Let me know when Nova Vale announces Boston dates', 'off@customer.example');
    expect(await alertsFor(requestId)).toHaveLength(0);
    const [q] = await sends(requestId);
    expect(q!.bodyText).not.toContain('reply "let me know"');
    expect(await c.evaluateEventAlerts()).toMatchObject({ skipped: 'event_alerts_disabled' });
  });

  it('the send gate lets an event alert out without approval, but not when switched off or stopped', () => {
    const base = { messageClass: 'event_alert' as const, recipientLookup: 'x@customer.example', containsFixtureData: false, approved: false, approvalHashMatches: false, revisionCurrent: true, evidenceFresh: true, marketingPermission: false };
    const env = (on: boolean) => testEnv({ EVENT_ALERTS_ENABLED: on ? 'true' : 'false', HUMAN_REVIEW_REQUIRED: 'true' });
    // Fixture mode and a disabled mailer always block; nothing else does, approval included.
    const fixtureOnly = ['app_mode_fixture', 'email_send_disabled'];
    expect(evaluateGate(env(true), {}, new Set(), base)).toEqual({ allowed: false, reasons: fixtureOnly });
    expect(evaluateGate(env(false), {}, new Set(), base)).toEqual({ allowed: false, reasons: [...fixtureOnly, 'event_alerts_disabled'] });
    expect(evaluateGate(env(true), { watches: false }, new Set(), base)).toEqual({ allowed: false, reasons: [...fixtureOnly, 'kill_switch_watches'] });
    expect(evaluateGate(env(true), {}, new Set(['watch']), base)).toEqual({ allowed: false, reasons: [...fixtureOnly, 'suppressed_watch'] });
  });

  it('"stop the alerts" cancels them', async () => {
    const c = concierge();
    const [one] = await h.db.select().from(t.eventAlerts).where(and(eq(t.eventAlerts.kind, 'new_date'), eq(t.eventAlerts.marketId, 'chicago')));
    const req = (await h.db.select().from(t.requests).where(eq(t.requests.id, one!.requestId)))[0]!;
    const [m] = await h.db.select().from(t.messages).where(eq(t.messages.conversationId, req.conversationId)).orderBy(desc(t.messages.receivedAt)).limit(1);
    await ask(c, 'please stop the alerts', 'offer@customer.example', { rfcMessageId: m!.rfcMessageId! });
    const [after] = await h.db.select().from(t.eventAlerts).where(eq(t.eventAlerts.id, one!.id));
    expect(after!.state).toBe('cancelled');
  });
});
