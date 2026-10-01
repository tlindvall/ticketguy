import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { offersInText, partyTerms } from '@/lib/advice/text-offers';
import { suppliedOffersAnswer } from '@/lib/advice/packet';

/**
 * Research 1 QA (Sep 30 2026): goal changes and follow-up memory. R1-M01: an upgrade that excludes admission was
 * recommended as concert tickets. R1-M02: a ticket already held and a fixed bundle's size were lost, so two
 * admissions were said to cover four people.
 *
 * The texts are rebuilt from the report (scenario-plan.json and raw/ weren't available here). They are the
 * customer's hypothetical quotes: nothing here is checked stock, entitlement or a real event.
 */
const NOW = FIXTURE_NOW;

const M01 = 'I need two actual concert admissions for a New York pop concert, reserved seats together, under $200 total. I don’t own any tickets yet. Offer A: two adjacent upper-tier concert seats, $190 all-in. Offer B: two adjacent lower-tier concert seats, $240 all-in. Offer C: two VIP lounge upgrades, $100 total, concert admission is explicitly NOT included and separate concert tickets are required. Which should I buy?';
const M01_CAP = 'Update: our budget is now $250 total, and lower-tier seats matter most to us.';
const M02 = 'Three of us are going to a Denver country concert. I already have my own ticket, so two friends need new tickets. Our budget is $250 total for the new tickets. Offer A: a fixed bundle of two adjacent concert admissions for $180 all-in, exactly two available, no partial purchase. Offer B: a fixed bundle of three adjacent concert admissions for $240 all-in, exactly three available, no partial purchase. My friends need to sit together; they don’t need to sit with me. Which should we buy?';
const M02_MORE = 'Update: another friend is joining, so four of us are going. I still have my own ticket, so three friends now need new tickets. Same offers, same $250 budget for the new tickets.';

/** The comparison alone, for the isolating controls: the offers and party exactly as the pipeline reads them. */
const compare = (messages: string[], opts: { budget: number; tz?: string }) => {
  const offers = messages.flatMap((m) => offersInText(m, opts.tz));
  const terms = partyTerms(messages);
  const r = suppliedOffersAnswer({ offers, quantity: terms.toBuy ?? terms.attendees ?? 2, budgetTotalCents: opts.budget, needs: { noObstructed: false, togetherRequired: false, baseline: null, terms }, accessibilityRequired: false, timeZone: opts.tz ?? 'America/New_York', observedAt: NOW });
  return { offers, terms, lead: r.lead, text: [r.lead, ...r.items].join('\n') };
};

describe('Research 1 QA: goal changes and follow-up memory', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; requestId: string };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const text of turns) {
      const m = inbound({ text, from: `r1m-${n}@customer.example`, subject: prev ? 'Re: Tickets' : 'Tickets', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let i = 0; i < 8; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: NOW });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
      expect(sends).toHaveLength(out.length + 1);
      out.push({ text: sends.at(-1)!.bodyText.split('\nTicket Guy\n')[0]!, requestId: r.requestId });
    }
    return out;
  };

  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  describe('R1-M01: an upgrade without admission is never a concert ticket', () => {
    it('replay: A at $190 with $10 left; C skipped as an upgrade that gets no one in; then the $250 cap and lower tier pick B', async () => {
      const [first, second] = await converse([M01, M01_CAP]);
      expect(first!.text).toContain('Offer A is the one that meets what you asked for: $190 for both, fees included.');
      expect(first!.text).toContain('Skip C: it’s an upgrade with no concert admission, so its $100 doesn’t get either of you into the show.');
      expect(first!.text).toContain('It leaves $10 of your $200 budget.');
      expect(first!.text).toContain('Over your $200 budget by $40.');
      expect(first!.text).not.toMatch(/Offer C (?:wins|is the one)|C \(two, concert admission\)/);
      // The follow-up, stopped in the live run: B for the lower tier, $50 over A, $10 left; C still out.
      expect(second!.text).toContain('I’d take B for you: $240 for both, fees included. It costs $50 more than Offer A, and since the lower tier is what matters most to you, that’s the difference worth paying. It leaves $10 of your $250 budget.');
      expect(second!.text).toMatch(/Offer C \(two, upgrade\): \$100 in total including fees\. It includes no concert admission/);
    });

    it.each([
      ['NOT included', 'admission NOT included'],
      ['explicitly NOT included', 'concert admission is explicitly NOT included'],
      ['does not include admission', 'does not include admission'],
      ['admission sold separately', 'admission sold separately'],
      ['separate tickets are required', 'separate concert tickets are required'],
    ])('negation control (%s): excluded, not typed as admission, and never the pick', (_label, words) => {
      const r = compare([`Two of us, $200 total. Offer A: two adjacent upper-tier concert seats, $190 all-in. Offer C: two VIP passes, $100 total, ${words}. Which is better?`], { budget: 20000 });
      const c = r.offers.find((o) => o.label === 'C')!;
      expect(c).toMatchObject({ admission: 'excluded' });
      expect(c.productKind).not.toBe('admission');
      expect(r.lead).toMatch(/^Offer A is the one/);
      expect(r.text).not.toMatch(/Offer C \([^)]*(?:concert admission|admission unverified)/);
    });

    it('a ticket bought earlier is not taken as one already held unless they say so', () => {
      expect(partyTerms(['I bought a ticket for the wrong date. Three of us need tickets for Saturday.'])).toMatchObject({ owned: null, toBuy: null, attendees: 3 });
      expect(partyTerms(['I already bought my ticket. Three of us are going.'])).toMatchObject({ owned: 1, toBuy: 2 });
    });

    it('positive control: a VIP package that includes two concert admissions stays eligible, and can win', () => {
      const r = compare(['Two of us, $200 total. Offer A: two adjacent upper-tier concert seats, $190 all-in. Offer B: a VIP package including two concert admissions together, $180 total all-in. Which is better?'], { budget: 20000 });
      expect(r.offers.find((o) => o.label === 'B')).toMatchObject({ admission: 'included', productKind: 'package' });
      expect(r.lead).toMatch(/^Offer B wins this one: \$180/);
    });

    it('unknown admission stays unknown, and unknown adjacency is not called together', () => {
      const r = compare(['Two of us need reserved seats together, $200 total. Offer A: two adjacent upper-tier concert seats, $190 all-in. Offer C: two VIP lounge upgrades, $100 total. Which is better?'], { budget: 20000 });
      const c = r.offers.find((o) => o.label === 'C')!;
      expect(c).toMatchObject({ admission: 'unknown', together: null });
      expect(r.lead).toMatch(/^Offer A is the one/);
      expect(r.text).toMatch(/Offer C \(two, upgrade\)[^\n]*Admission entitlement is unknown; confirm/);
      expect(r.text).not.toContain('Skip C');
      expect(r.text).not.toMatch(/Offer C \([^)]*together/);
    });
  });

  describe('R1-M02: what they already hold, and what each bundle admits', () => {
    it('replay: two new tickets → A at $180, $70 left; three new tickets → B at $240, $10 left, A one admission short', async () => {
      const [first, second] = await converse([M02, M02_MORE]);
      expect(first!.text).toContain('Offer A is the one that meets what you asked for: $180 for the two new tickets, fees included. Your own ticket is already covered.');
      expect(first!.text).toContain('It leaves $70 of your $250 budget.');
      expect(first!.text).not.toMatch(/all three|all four/);
      expect(second!.text).toContain('Offer B is the one that meets what you asked for: $240 for the three new tickets, fees included. Your own ticket is already covered.');
      expect(second!.text).toContain('Skip A: it has only two admissions, and you need three new ones, so it would leave one person out.');
      expect(second!.text).toContain('It leaves $10 of your $250 budget.');
      expect(second!.text).not.toMatch(/all four|Offer A (?:wins|is the one)|\$360|\$540|\$720/);
      // The brief records the purchase (2 → 3), not the party (3 → 4).
      const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, second!.requestId));
      expect(versions.map((v) => (v.brief as { quantity: number }).quantity)).toEqual([2, 3]);
      const [v2] = await h.db.select().from(t.requestVersions).where(and(eq(t.requestVersions.requestId, second!.requestId), eq(t.requestVersions.revision, 2)));
      expect(v2).toBeTruthy();
    });

    it('capacity isolation: the same bundles, three new tickets and nothing already held → A fails, B fits', () => {
      const r = compare(['Three of us need tickets for a Denver country concert, $250 total. Offer A: a fixed bundle of two adjacent concert admissions for $180 all-in, exactly two available, no partial purchase. Offer B: a fixed bundle of three adjacent concert admissions for $240 all-in, exactly three available, no partial purchase. Which should we buy?'], { budget: 25000, tz: 'America/Denver' });
      expect(r.terms).toMatchObject({ attendees: 3, owned: null, toBuy: null });
      expect(r.offers.map((o) => [o.label, o.unitsAvailable, o.admissionsPerUnit, o.quantity, o.mustBuyAll])).toEqual([['A', 1, 2, 2, true], ['B', 1, 3, 3, true]]);
      expect(r.lead).toMatch(/^Offer B is the one that meets what you asked for: \$240 for all three/);
      expect(r.text).toContain('Skip A: it has only two admissions, and you need three, so it would leave one person out.');
    });

    it('owned-count isolation: ordinary two- and three-ticket quotes, one ticket already held → two to buy', () => {
      const r = compare(['Three of us are going and I already have my own ticket. Offer A: two adjacent seats for $180 total all-in. Offer B: three adjacent seats for $240 total all-in. Budget $250 total.'], { budget: 25000 });
      expect(r.terms).toMatchObject({ attendees: 3, owned: 1, toBuy: 2 });
      expect(r.lead).toMatch(/^Offer A wins this one: \$180 for the two new tickets/);
    });

    it('four new tickets with only two- and three-admission bundles: a useful no, with no invented stock', () => {
      const r = compare(['Five of us are going; I already have my own ticket, so four friends need new tickets. Budget $500 total. Offer A: a fixed bundle of two adjacent concert admissions for $180 all-in, exactly two available, no partial purchase. Offer B: a fixed bundle of three adjacent concert admissions for $240 all-in, exactly three available, no partial purchase.'], { budget: 50000, tz: 'America/Denver' });
      expect(r.terms).toMatchObject({ owned: 1, toBuy: 4 });
      expect(r.lead).toMatch(/^None of the two meets all your requirements\./);
      expect(r.text).toContain('It has only two admissions, and you need four new ones, so it would leave two people out.');
      expect(r.text).toContain('It has only three admissions, and you need four new ones, so it would leave one person out.');
      expect(r.text).not.toMatch(/stretch to|\$360|\$420|\$480|two bundles/);
    });

    it('unknown capacity: a bundle that doesn’t say how many it admits covers nobody and is never multiplied', () => {
      const r = compare(['Three of us need tickets, $250 total. Offer A: a bundle of concert admissions for $180 all-in. Offer B: a fixed bundle of three adjacent concert admissions for $240 all-in, no partial purchase. Which should we buy?'], { budget: 25000 });
      expect(r.lead).toMatch(/^Offer B is the one/);
      expect(r.text).toContain('Offer A (package): $180 for the bundle including fees; how many it admits isn’t stated. It doesn’t say how many admissions the bundle includes, so I can’t count it as covering three.');
      expect(r.text).not.toMatch(/\$540|\$180 each/);
    });
  });
});
