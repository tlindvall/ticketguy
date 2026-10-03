import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import replay from '../fixtures/qa-post54-cases.json';

/**
 * The post-#54 full QA (23 sends), replayed word for word. Harness as in audit-replay.test.ts.
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

describe('the post-#54 QA, replayed exactly', () => {
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
      const parent = k.parent ? firstMsg.get(k.parent) : undefined;
      // A11's image as production received it before the fix: listed by the provider, bytes never fetched.
      const unretrieved = k.attachment ? [{ id: 'att-a11', reason: 'no_download_url', filename: 'synthetic-offer.png', declaredMimeType: 'image/png' }] : [];
      const msg = inbound({ text: k.body, from: FROM, subject: k.subject, inReplyTo: parent ?? null, references: parent ?? null, unretrieved });
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
    for (const k of replay.cases) if (k.id !== 'R04') expect(replies.get(k.id)?.length, k.id).toBeGreaterThan(0);
  });

  it('X02 (R3-B04): B is the only suitable offer, $65 less than A and $15 under budget; A, C and D each left out for its reason', () => {
    const body = all('X02');
    expect(body).toContain('Offer B is the one that meets what you asked for: $585 for all five, fees included. That’s $65 less than Offer A. It leaves $15 of your $600 budget.');
    expect(body).toContain('- Offer A (five together, unobstructed, delivery by noon): $650 in total including fees. Over your $600 budget by $50.');
    expect(body).toContain('- Offer C (five together, obstructed view, delivery by noon): $425 in total including fees. It has an obstructed view, which you ruled out.');
    expect(body).toContain('- Offer D (six together, can’t be split, delivery by noon): $480 in total including fees for six tickets. It’s six tickets the seller won’t split, and you won’t buy an extra.');
    expect(body).toContain('Based on the details you sent; I haven’t verified availability.');
    expect(body).not.toMatch(/Both fit|\$55 less|My read|Found seats you like/);
  });

  it('X01 (R3-B05): A is 2 × $90 + $40 = $220, B is $210 all-in, so B is $10 less', () => {
    const body = all('X01');
    expect(body).toContain('Offer B wins this one: $210 for both, fees included. That’s $10 less than Offer A.');
    expect(body).toContain('- Offer A (ordinary seats, delivery by noon): $90 each before fees, plus $40 for the whole order: $220 in total for both.');
    expect(body).not.toMatch(/aren’t on the same basis|Budget: \$90|over your \$180|most you’d want to pay/);
  });

  it('R05 (R3-B01): one answer, B; A’s price and access never describe B; no single-offer verdict after it', () => {
    const body = all('R05');
    expect(body).toContain('Offer B is the one that meets what you asked for: $210 for both, fees included.');
    expect(body).not.toMatch(/I wouldn’t buy this one|You mentioned \$80|Budget: \$80|These are accessible seats|Against resale/);
  });

  it('A11 (R3-B09): an image that didn’t reach us is said plainly; nothing about the tickets is assumed', () => {
    const body = all('A11');
    expect(body).toContain('I couldn’t read the image you attached, so I haven’t used anything from it or assumed anything about the tickets.');
    expect(body).toContain('Could you type out what it shows: the event and date, how many tickets, the section and row, and the total including fees?');
    expect(body).not.toMatch(/Two tickets\. Got it|assumed two tickets|Which event/);
  });

  it('A06 (R3-B10): the date and city they gave aren’t asked for again', () => {
    const body = all('A06');
    expect(body).toContain('If you’ve seen a Dua Lipa show announced for then, send me the link and I’ll check it. Or tell me another date or city and I’ll look there.');
    expect(body).not.toMatch(/Which Dua Lipa date and venue/);
  });

  it('R3-B06: no reply calls a floor the least any seats will cost', () => {
    for (const k of replay.cases) expect(all(k.id), k.id).not.toMatch(/that or more|will cost at least|right now:/);
  });

  it('L01: the listing we can’t open is said before any market figures', () => {
    const body = all('L01');
    const at = body.indexOf('I couldn’t match the StubHub listing you picked in the listing data I can see');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(Math.max(body.lastIndexOf('How this compares'), body.lastIndexOf('My read'), at + 1));
  });

  it('prints', () => {
    if (process.env.PRINT_REPLAY) writeFileSync(process.env.PRINT_REPLAY, replay.cases.map((k) => `##### ${k.id}\n${all(k.id)}`).join('\n\n'));
    expect(byId('X02')).toBeDefined();
  });
});
