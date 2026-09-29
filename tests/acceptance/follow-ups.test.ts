import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX, FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { openTestDb, makeConcierge, inbound } from '../harness';

async function interpretAll(h: DbHandle, c: ReturnType<typeof makeConcierge>) {
  for (let i = 0; i < 5; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
    const work = leased.filter((ev) => ev.eventType === 'request.interpret');
    if (!work.length) return;
    for (const ev of work) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
}

/**
 * Two live threads went wrong the same way. After "Two Rangers tickets" had settled the game, a reply of
 * "lets do 6 tickets" and a reply of only a StubHub link each came back "Which game: Thu, Oct 1 or Tue, Oct 13?":
 * every reply re-identified the event from scratch, and our own quoted email ("When: Thu, Oct 1, 7:00 PM EDT")
 * was read as the customer's date. A settled game now stays settled unless the customer moves it, the quoted
 * thread is not read, and a pasted ticket link is read for its date and quantity.
 */
describe('follow-ups keep what was settled', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  const thread = async (from: string, first: string, ...replies: string[]) => threadWith(makeConcierge(h), from, first, ...replies);
  const threadWith = async (c: ReturnType<typeof makeConcierge>, from: string, first: string, ...replies: string[]) => {
    const msg = inbound({ text: first, from, subject: 'Rangers' });
    const r = (await c.ingestInbound(msg)) as { requestId: string };
    await interpretAll(h, c);
    for (const text of replies) {
      await c.ingestInbound(inbound({ text, from, subject: 'Re: Rangers', inReplyTo: msg.rfcMessageId, references: msg.rfcMessageId }));
      await interpretAll(h, c);
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const [version] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId)).orderBy(desc(t.requestVersions.revision)).limit(1);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { req: req!, brief: version!.brief as { quantity: number | null }, sends };
  };

  it('"lets do 6 tickets" changes the party size, not the game', async () => {
    const { req, brief, sends } = await thread('six@customer.example', 'Two Rangers tickets Oct 3 please.', 'lets do 6 tickets.');
    expect(req.eventId).toBe(FX.events.rangersPreseason);
    expect(brief.quantity).toBe(6);
    expect(req.state).not.toBe('needs_clarification');
    expect(sends.some((s) => s.messageClass === 'clarification')).toBe(false);
  });

  it('our own quoted email under the reply is not read as the customer asking again', async () => {
    const reply = [
      'lets do 6 tickets.',
      '',
      'On Tue, Sep 22, 2026 at 3:53 PM Ticket Guy <',
      'hello@ticketguy.now> wrote:',
      'Hey,',
      'When: Thu, Oct 15, 7:00 PM EDT',
      'Which game: Sat, Oct 3 or Thu, Oct 15?',
    ].join('\n');
    const { req, brief, sends } = await thread('quoted@customer.example', 'Two Rangers tickets Oct 3 please.', reply);
    expect(req.eventId).toBe(FX.events.rangersPreseason);
    expect(brief.quantity).toBe(6);
    expect(sends.some((s) => s.messageClass === 'clarification')).toBe(false);
  });

  it('a reply of only a StubHub link is read for its game and quantity', async () => {
    const link = 'https://www.stubhub.com/new-york-rangers-new-york-tickets-10-3-2026/event/161415566/?backUrl=%2Fnew-york-rangers-tickets%2Fperformer%2F2764&quantity=5&listingId=13718391146';
    const { req, brief, sends } = await thread('link@customer.example', 'Two Rangers tickets Oct 3 please.', link);
    expect(req.eventId).toBe(FX.events.rangersPreseason);
    expect(brief.quantity).toBe(5);
    expect(sends.some((s) => s.messageClass === 'clarification')).toBe(false);
  });

  it('a link alone as the first message names the team, the date and the party size', async () => {
    const { req, brief, sends } = await thread('onlylink@customer.example', 'https://www.stubhub.com/new-york-rangers-new-york-tickets-10-15-2026/event/161415999/?quantity=4');
    expect(req.eventId).toBe(FX.events.rangersRegular);
    expect(brief.quantity).toBe(4);
    expect(sends.some((s) => s.messageClass === 'clarification')).toBe(false);
  });

  it('a reply that names another date still moves the game', async () => {
    const { req } = await thread('move@customer.example', 'Two Rangers tickets Oct 3 please.', 'Actually make it Oct 15.');
    expect(req.eventId).toBe(FX.events.rangersRegular);
  });

  // The live model read our quoted email and came back with a loose date for "lets do 6 tickets"; that window
  // holds both games, and the reply asked "which game?" about a game already settled.
  it('a loose date read from the reply does not reopen a settled game it still fits', async () => {
    const rules = new FixtureExtractor();
    const noisy: Extractor = {
      name: 'fixture',
      extract: async (input) => {
        const x = await rules.extract(input);
        return /lets do 6/.test(input.text) ? { ...x, performerOrTeam: 'New York Rangers', dateExpression: 'in October', resolvedLocalDate: null } : x;
      },
    };
    const { req, brief, sends } = await threadWith(makeConcierge(h, { extractor: noisy }), 'noisy@customer.example', 'Two Rangers tickets Oct 3 please.', 'lets do 6 tickets.');
    expect(req.eventId).toBe(FX.events.rangersPreseason);
    expect(brief.quantity).toBe(6);
    expect(sends.some((s) => s.messageClass === 'clarification')).toBe(false);
  });
});
