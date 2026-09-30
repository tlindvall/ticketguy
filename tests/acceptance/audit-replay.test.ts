import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import replay from '../fixtures/audit-0929-cases.json';

/**
 * The TGQA-0929 audit, replayed word for word (tests/fixtures/audit-0929-cases.json: the 11 first emails and 5
 * follow-ups in send order, addresses and ids removed). The clock is the audit's, the events are the ones it
 * asked about, and the extractor is the deterministic one, so this checks what the pipeline does with each
 * request, not what a model reads into it. Each case asserts the audit's invariant for it, not exact copy.
 */
const CLOCK = new Date(replay.clock);
const FROM = 'qa-replay@customer.example';
const RODGERS = '10000000-0000-4000-8000-0000000000a1';
const LIGHTNING = '20000000-0000-4000-8000-0000000000a1';
const HAMILTON = '20000000-0000-4000-8000-0000000000a2';
const RANGERS_TB = '30000000-0000-4000-8000-0000000000a1';
const HAMILTON_OCT3 = '30000000-0000-4000-8000-0000000000a2';

type Case = (typeof replay.cases)[number];
const byId = (id: string) => replay.cases.find((c) => c.id === id)!;

describe('the TGQA-0929 audit, replayed exactly', () => {
  let h: DbHandle;
  const replies = new Map<string, string[]>();
  const requestOf = new Map<string, string>();

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: RODGERS, name: 'Richard Rodgers Theatre', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7593, longitude: -73.9866 });
    await h.db.insert(t.entities).values([
      { id: LIGHTNING, kind: 'team', name: 'Tampa Bay Lightning', slug: 'tampa-bay-lightning', aliases: ['Lightning', 'Tampa Bay'], league: 'NHL' },
      { id: HAMILTON, kind: 'artist', name: 'Hamilton', slug: 'hamilton', aliases: ['Hamilton on Broadway'] },
    ]);
    await h.db.insert(t.events).values([
      { id: RANGERS_TB, name: 'New York Rangers vs. Tampa Bay Lightning', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, opponentEntityId: LIGHTNING, isHome: true, localStartAt: new Date('2026-10-01T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' },
      { id: HAMILTON_OCT3, name: 'Hamilton', category: 'theatre', venueId: RODGERS, primaryEntityId: HAMILTON, localStartAt: new Date('2026-10-03T18:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-01-01T15:00:00Z'), publicSaleEndAt: new Date('2026-10-03T17:00:00Z') },
    ]);
    await h.db.insert(t.eventSourceMappings).values({ eventId: HAMILTON_OCT3, sourceId: 'ticketmaster', sourceEventId: 'Z1r9uZrrZbpZ1AvjMjk', authoritativeUrl: 'https://www.ticketmaster.com/hamilton-ny-new-york-new-york-10-03-2026/event/Z1r9uZrrZbpZ1AvjMjk', role: 'discovery', confidence: 'provider_id' });

    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: FROM }), now: () => CLOCK });
    const firstMsg = new Map<string, string>();
    const drain = async () => {
      for (let i = 0; i < 10; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: CLOCK });
        if (!leased.length) return;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, CLOCK);
        }
      }
    };
    // In send order, each follow-up in its case's thread, one at a time, as the audit sent them.
    for (const k of replay.cases as Case[]) {
      if (k.attachment) continue; // A11's image needs the model reader; its extraction is tested in listing-evidence
      const parent = k.parent ? firstMsg.get(k.parent) : undefined;
      const msg = inbound({ text: k.body, from: FROM, subject: k.subject, inReplyTo: parent ?? null, references: parent ?? null });
      if (!k.parent) firstMsg.set(k.id, msg.rfcMessageId!);
      const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
      const r = (await c.ingestInbound(msg)) as { requestId?: string };
      if (r.requestId) requestOf.set(k.id, r.requestId);
      await drain();
      const after = await h.db.select().from(t.sendIntents);
      replies.set(k.id, after.filter((s) => !before.has(s.id)).map((s) => s.bodyText));
    }
  });
  afterAll(async () => {
    await h.close();
  });

  const all = (id: string) => (replies.get(id) ?? []).join('\n\n=====\n\n');

  it('every replayed email got an answer', () => {
    for (const k of replay.cases) if (!k.attachment) expect(replies.get(k.id)?.length, k.id).toBeGreaterThan(0);
  });

  it('no reply anywhere calls a price fair, a bargain, or in line with the market', () => {
    for (const k of replay.cases) expect(all(k.id), k.id).not.toMatch(/fair price|is a fair|good deal|bargain|in line with the market|better section, not a better deal/i);
  });

  it('A05/R01 Hamilton: no purchase endorsement; three together, $450 all-in and step-free access are each still to check', () => {
    for (const id of ['A05', 'R01']) {
      const body = all(id);
      expect(body, id).not.toMatch(/where I'd buy|where I’d buy/);
      expect(body, id).toContain('- 3 seats together');
      expect(body, id).toContain('- $450 in total for all 3, once fees are added');
      expect(body, id).toContain('- Step-free access');
      expect(body, id).toMatch(/set the number of tickets to 3/);
      // The "compare" invitation says what a comparison can't do (retest R2-B03).
      expect(body, id).toContain('That shows price levels only: I can\'t check particular seats, their access or whether they sit together for you.');
    }
  });

  it('A05-R1/R01-F1: asked again, each requirement is said as not yet checked, and nothing is endorsed', () => {
    for (const id of ['A05-R1', 'R01-F1']) {
      const body = all(id);
      expect(body, id).toContain('I haven’t been able to check these against any seats yet: 3 seats together; $450 in total for all 3, once fees are added; and step-free access.');
      expect(body, id).not.toMatch(/where I'd buy|where I’d buy/);
    }
  });

  it('A09 London: US-only said plainly, no search and no New York substitution', () => {
    const body = all('A09');
    expect(body).toContain('We only cover events in the US for now, so I can’t help with Hamilton in London, UK.');
    expect(body).not.toMatch(/couldn't find|couldn’t find|Richard Rodgers|Broadway|general sale/);
  });

  it('A07: a watch request gets its real status; A07-R1/R04: the cancellation says truthfully it never ran, for this thread only', () => {
    expect(all('A07')).toContain('I can’t watch prices for you yet, so nothing is being monitored for this request and no alert will come.');
    for (const id of ['A07-R1', 'R04']) {
      const body = all(id);
      expect(body, id).toContain('There was no active price watch or alert on this request, so nothing was being monitored and there’s nothing to stop.');
      expect(body, id).toContain('your other requests and your email preferences are as they were');
      expect(body, id).not.toMatch(/I’ve stopped|Resale listings|My read/);
    }
  });

  it('A01-R1/R02-F1: six tickets and $720 replace five and $600, shown in the reply; the game stays settled', async () => {
    for (const id of ['A01-R1', 'R02-F1']) {
      const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestOf.get(id)!));
      const latest = versions.sort((a, b) => b.revision - a.revision)[0]!;
      expect(latest.brief, id).toMatchObject({ quantity: 6, budgetCents: 72000, budgetBasis: 'whole_party' });
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestOf.get(id)!));
      expect(req!.eventId, id).toBe(RANGERS_TB);
      const body = all(id);
      expect(body, id).toContain('· 6 tickets · up to $720 in total');
      expect(body, id).not.toMatch(/Which New York Rangers (date|game)|per ticket or for everyone/);
    }
  });

  it('A08/A08-R1/R03: the delivery question is answered first, in the acknowledgment too; no refund or entry promise; no deadline question', () => {
    for (const id of ['A08', 'A08-R1', 'R03']) {
      const body = all(id);
      expect(body, id).toContain('On delivery:');
      expect(body, id).toContain('a refund guarantee, if the seller offers one, gives the money back; it doesn’t get you into the game');
      expect(body, id).not.toMatch(/guaranteed|will arrive|will be delivered|you’ll get in|When do you need to have tickets sorted by/i);
    }
    // Two tickets are read from "two Rangers vs Tampa Bay tickets", so nothing is assumed and the answer comes once,
    // delivery first, without an "I'll look" acknowledgment ahead of it (TGQA-R6 1008, post-#55 writing review).
    for (const id of ['A08', 'R03']) expect(all(id), id).toMatch(/· 2 tickets · up to \$220 in total\n\nOn delivery:/);
  });

  it('A03/R05: the two offers are compared as asked; the wheelchair spaces nobody needs are not the one to buy', () => {
    for (const id of ['A03', 'R05']) {
      const body = all(id);
      expect(body, id).toContain('Offer B is the one that meets what you asked for: $210 for both, fees included.');
      expect(body, id).toContain('- Offer A (wheelchair-accessible spaces): $80 each including fees, $160 for both. These are wheelchair or companion spaces, which no one in your group needs');
      expect(body, id).toContain('- Offer B (ordinary seats, together, section 211, row 12): $105 each including fees, $210 for both.');
      // One offer's fields never describe the other, and no single-listing verdict follows the comparison (R3-B01).
      expect(body, id).not.toMatch(/I wouldn’t buy this one|You mentioned \$80|That’s 2 tickets, in section 211/);
      // Answered once: no "I'll look at how the tickets are trading" before an answer that needs no search.
      expect(body, id).not.toContain('look at how the tickets are trading');
      expect(body, id).not.toMatch(/Offer B: 211|suits your needs|I haven’t been able to check/);
    }
  });

  it('A10: "how many have sold" is answered: asking prices, not sales', () => {
    expect(all('A10')).toContain('On sales: I can’t tell you how many tickets have sold. What I can see are asking prices on StubHub and Vivid Seats listings, not completed sales');
  });

  it('prints each reply for review', () => {
    // PRINT_REPLAY=<file> writes every reply out, for reading the replay whole.
    if (process.env.PRINT_REPLAY) writeFileSync(process.env.PRINT_REPLAY, replay.cases.map((k) => `##### ${k.id}\n${all(k.id)}`).join('\n\n'));
    expect(byId('A01')).toBeDefined();
  });
});
