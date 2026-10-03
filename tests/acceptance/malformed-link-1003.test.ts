import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched, markFailed, isPermanentFailure, InvalidInputError } from '@/lib/intake/outbox';
import { parseTicketLink, safeDecode, ticketLinksIn } from '@/lib/domain/ticket-links';
import { FIXTURE_NOW, FX } from '@/lib/fixtures';

/**
 * LAUNCH-05 (final launch QA, Oct 2, L03): "Can you check this Rangers ticket link? It copied weirdly from my phone. Two
 * tickets for October 6 at MSG." with https://www.stubhub.com/%ZZ/event/161564036/?quantity=2. decodeURIComponent threw a
 * URIError outside the parser's guard, the interpret job retried four times over about two and a half minutes, and the
 * customer got "I couldn't finish this one automatically". A broken link is their input, not a provider's bad minute.
 */
const BROKEN = 'https://www.stubhub.com/%ZZ/event/161564036/?quantity=2';

describe('LAUNCH-05: a malformed link never fails the email', () => {
  let h: DbHandle;
  const send = async (text: string, from: string) => {
    const c = makeConcierge(h, { now: () => FIXTURE_NOW });
    const m = inbound({ text, from, subject: 'Tickets', receivedAt: FIXTURE_NOW });
    const r = (await c.ingestInbound(m)) as { requestId: string };
    const attempts: string[] = [];
    for (let j = 0; j < 8; j++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(FIXTURE_NOW.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        attempts.push(ev.eventType);
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { req: req!, attempts, text: (sends.at(-1)?.bodyText ?? '').split('\nTicket Guy\n')[0]! };
  };

  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('the parser reads what decoded, keeps the broken part as typed, and says so; it never throws', () => {
    expect(() => decodeURIComponent('/%ZZ/event/161564036/')).toThrow(URIError);
    expect(parseTicketLink(BROKEN)).toMatchObject({ marketplace: 'stubhub', eventId: '161564036', quantity: 2, malformed: true });
    expect(parseTicketLink('https://www.stubhub.com/new-york-rangers-new-york-tickets-10-6-2026/event/161564036/?quantity=2')).toMatchObject({ localDate: '2026-10-06', malformed: false });
    // Valid escapes around a broken one still decode; a lone "%" is broken too.
    expect(safeDecode('/rangers%20tickets/%ZZ/x%2Fy')).toEqual({ text: '/rangers tickets/%ZZ/x/y', malformed: true });
    expect(safeDecode('/50%/off')).toEqual({ text: '/50%/off', malformed: true });
    // One broken link never costs the others.
    const links = ticketLinksIn([BROKEN, 'https://www.stubhub.com/new-york-knicks-new-york-tickets-10-24-2026/event/159000111/?quantity=2&listingId=777']);
    expect(links.map((l) => [l.eventId, l.malformed])).toEqual([['161564036', true], ['159000111', false]]);
  });

  it('the email is answered on its first pass: the typed game and count resolve, no retry, no hand-off', async () => {
    const r = await send(`Can you check this Knicks ticket link? It copied weirdly from my phone. Two tickets for October 24 at MSG.\n${BROKEN}`, 'l03@customer.example');
    expect(r.req.state).not.toBe('manual_attention');
    expect(r.req.eventId).toBe(FX.events.knicks);
    expect(r.attempts.filter((x) => x === 'request.interpret')).toHaveLength(1);
    const dead = await h.db.select().from(t.outboxEvents).where(eq(t.outboxEvents.state, 'dead'));
    expect(dead).toHaveLength(0);
    expect(r.text).not.toMatch(/couldn’t finish this one automatically|needs a manual check/);
    // It says what happened to the link, once, and answers from what came through and what they wrote.
    expect(r.text).toContain('Part of the StubHub link you sent came through garbled, so I used the parts that came through and what you wrote.');
    expect(r.text).toContain('New York Knicks vs. Fixture Opponent');
    expect(r.text).toContain('Tickets: 2');
    expect(r.text).not.toMatch(/send (?:me )?(?:a|the) link|A link works/i);
  });

  it('input the code can never read goes to a person on the first failure, not after four retries', async () => {
    expect(isPermanentFailure(new URIError('URI malformed'))).toBe(true);
    expect(isPermanentFailure(new InvalidInputError('bad link'))).toBe(true);
    expect(isPermanentFailure(new Error('ECONNRESET'))).toBe(false);
    const [ev] = await h.db.insert(t.outboxEvents).values({ eventType: 'request.interpret', eventKey: 'l03-permanent', entityId: FX.events.knicks, payload: {}, state: 'leased', attempts: 1, leaseToken: 'tok', nextAttemptAt: FIXTURE_NOW }).returning();
    expect(await markFailed(h.db, { ...ev!, leaseToken: 'tok' } as never, 'URI malformed', FIXTURE_NOW, { permanent: true })).toBe('dead');
    const [ev2] = await h.db.insert(t.outboxEvents).values({ eventType: 'request.interpret', eventKey: 'l03-transient', entityId: FX.events.knicks, payload: {}, state: 'leased', attempts: 1, leaseToken: 'tok2', nextAttemptAt: FIXTURE_NOW }).returning();
    expect(await markFailed(h.db, { ...ev2!, leaseToken: 'tok2' } as never, 'ECONNRESET', FIXTURE_NOW)).toBe('retry');
  });
});
