import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { seedDiscovery } from './r1-discovery.harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { RequestExtraction } from '@/lib/domain/types';
import { eventConstraints } from '@/lib/domain/event-constraints';
import { ageRuledOut, citiesRuledOut, listedMinAge, partyAgeLimits, readableTitle } from '@/lib/intake/pipeline';

/**
 * Research 2 discovery and link retest on the deployed a80744b (Oct 1 2026): the three deployed two-turn
 * conversations, verbatim (cases/*.json), and the package's broader local cases (local/discovery-independent.test.ts),
 * against the R1 discovery catalog plus its Nashville and Franklin rows. Rules-path replays with the fixture
 * extractor: nothing here is availability, seating, an age policy, an entry policy or a price.
 *
 * On a80744b: R2-CONCERT-AGE-01 (a known 21+ night offered to a group with a 20-year-old), NW-02-SKIP ("skip
 * Constellation Room" became the venue), R2-CONCERT-BUDGET-01 (a $300 total lost), R2-CONCERT-PREFERENCE-01
 * ("prefer Elsewhere, another Brooklyn venue is fine" searched only Elsewhere), R2-CONCERT-GEO-01 (Franklin offered
 * after "not Franklin"), R2-EMAIL-HIERARCHY-01 (three options for "one or two", then "tell me which one").
 */
const F = JSON.parse(readFileSync('tests/fixtures/r2-discovery-retest-2026-10-01.json', 'utf8')) as { conversations: Record<'C01' | 'C02' | 'C03', [string, string]> };
const NOW = new Date('2026-10-01T23:30:00Z');

describe('R2 discovery retest: hard constraints, preferences and a finished answer', () => {
  let h: DbHandle;
  type Turn = { text: string; html: string; brief: RequestExtraction; requestId: string };
  let n = 0;
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < turns.length; i++) {
      const m = inbound({ text: turns[i]!, from: `r2dr-${n}@qa.example`, subject: prev ? 'Re: Concert help' : 'Concert help', receivedAt: new Date(NOW.getTime() + i * 1000), inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      prev = m;
      const r = (await c.ingestInbound(m)) as { requestId: string };
      for (let j = 0; j < 8; j++) {
        const due = await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) });
        if (!due.length) break;
        for (const q of due) {
          const p = q.payload as Record<string, string>;
          if (q.eventType === 'request.interpret') await c.interpret({ requestId: p.requestId!, messageId: p.messageId! });
          else if (q.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(q.payload.revision) });
          await markDispatched(h.db, q.id, q.leaseToken, NOW);
        }
      }
      const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).filter((x) => !seen.has(x.id));
      const recs = (await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).filter((x) => !seen.has(x.id));
      for (const x of [...sends, ...recs]) seen.add(x.id);
      const reply = recs[0] ?? sends.find((x) => !/Here's what I have/.test(x.bodyText)) ?? sends[0];
      expect(reply, `turn ${i + 1} has a reply`).toBeDefined();
      const versions = (await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId))).sort((a, b) => a.revision - b.revision);
      out.push({ text: reply!.bodyText.split('\nTicket Guy\n')[0]!, html: reply!.bodyHtml, brief: versions.at(-1)!.brief as RequestExtraction, requestId: r.requestId });
    }
    return out;
  };

  beforeAll(async () => {
    h = await openTestDb();
    await seedDiscovery(h);
    // The package's Nashville rows: two Nashville country nights, one in Franklin, one after the window.
    const [nash] = await h.db.insert(t.venues).values({ name: 'QA Nashville Room', city: 'Nashville', state: 'TN', country: 'US', timezone: 'America/Chicago', latitude: 36.1627, longitude: -86.7816 }).returning();
    const [franklin] = await h.db.insert(t.venues).values({ name: 'QA Franklin Room', city: 'Franklin', state: 'TN', country: 'US', timezone: 'America/Chicago', latitude: 35.9251, longitude: -86.8689 }).returning();
    const [mohawk] = await h.db.select().from(t.venues).where(eq(t.venues.name, 'Mohawk Austin'));
    const rows: Array<[string, string, string, string]> = [
      ['QA Nashville Country', 'country / country', nash!.id, '2026-10-03T01:00:00Z'],
      ['QA Nashville Americana', 'country / americana', nash!.id, '2026-10-04T01:00:00Z'],
      ['QA Franklin Country', 'country / country', franklin!.id, '2026-10-04T01:00:00Z'],
      ['QA Nashville Later', 'country / country', nash!.id, '2026-10-05T01:00:00Z'],
      ['QA Austin Americana', 'country / americana', mohawk!.id, '2026-10-04T01:00:00Z'],
      ['QA Austin Country', 'country / country', mohawk!.id, '2026-10-03T01:00:00Z'],
      ['QA Country Tribute Night', 'country / country', mohawk!.id, '2026-10-04T02:00:00Z'],
    ];
    for (let i = 0; i < rows.length; i++) {
      const [name, genre, venueId, start] = rows[i]!;
      const [e] = await h.db.insert(t.events).values({ name, genre, venueId, category: 'concert', localStartAt: new Date(start), status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster' }).returning();
      await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: `R2SYN${i}`, authoritativeUrl: `https://www.ticketmaster.com/event/R2SYN${i}`, role: 'discovery', confidence: 'provider_id' });
    }
  });
  afterAll(async () => {
    await h.close();
  });

  describe('the deployed conversations, exact messages', () => {
    it('C01 LA: $300 total kept on both turns; "skip Constellation Room" excludes it; one or two options and a choice', async () => {
      const [first, second] = await converse(F.conversations.C01);
      for (const r of [first!, second!]) expect(r.brief).toMatchObject({ quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party' });
      expect(first!.text).not.toMatch(/three I can check|Reply "more"|Constellation Room|Lilyisthatyou/);
      expect(second!.text).not.toMatch(/at Constellation Room|Lilyisthatyou|Fri, Oct 9/);
      expect(second!.text).toContain('Rachel Bochner');
      expect(second!.text).toMatch(/\$300/);
      expect(second!.text).not.toMatch(/Want me to look at different dates/);
    });
    it('C02 Brooklyn: Dusky (21+) is out for a group with a 20-year-old, said first; another Brooklyn venue is searched', async () => {
      const [first, second] = await converse(F.conversations.C02);
      expect(first!.text).not.toMatch(/Here’s the (?:listing|event page) for Dusky/);
      expect(first!.text).toMatch(/Dusky[^.]*is out: it’s listed as 21\+, and your friend is 20/);
      expect(second!.text).not.toMatch(/at Elsewhere\./);
      expect(second!.text).toContain('Night Shift: Deep House');
      expect(second!.text).not.toMatch(/Want me to look at different dates/);
    });
    it('C03 Nashville: six and $600 kept; Franklin stays out; one or two options and a choice', async () => {
      const [first, second] = await converse(F.conversations.C03);
      for (const r of [first!, second!]) expect(r.brief).toMatchObject({ quantity: 6, budgetCents: 60000, budgetBasis: 'whole_party' });
      for (const r of [first!, second!]) expect(r.text).not.toMatch(/QA Franklin Country|three I can check|Reply "more"/);
      expect(second!.text).toContain('QA Nashville Americana');
      expect(second!.text).not.toMatch(/Fri, Oct 2|QA Nashville Later/);
    });
  });

  describe('the package’s broader local cases (discovery-independent.test.ts)', () => {
    const cases: Array<{ id: string; turns: string[]; forbid?: RegExp; need?: RegExp }> = [
      { id: 'LA-hard-saturday-exclusion', turns: ['Two adults want a mainstream pop concert in Los Angeles on Saturday October 10, 2026 only. Not Anaheim or Santa Ana. Two seats together, $300 TOTAL including fees. Give one or two official event links and choose for us.', 'Skip Constellation Room and Orange County entirely. Keep Saturday October 10. Are reserved seats, adjacency and the all-in total verified?'], forbid: /Lilyisthatyou|Fri, Oct 9|at Constellation Room/, need: /Rachel Bochner/ },
      { id: 'LA-exclusion-rephrased', turns: ['Pop music in Los Angeles on October 9 or 10, 2026 for two. Under $300 total including fees. One or two choices please.', 'Constellation Room is out. Los Angeles only, not Santa Ana. Saturday only.'], forbid: /Lilyisthatyou|at Constellation Room|Fri, Oct 9/ },
      { id: 'LA-allowed-SantaAna-control', turns: ['Pop show at Constellation Room in Santa Ana on Friday October 9, 2026. Santa Ana is fine. Two tickets.'], need: /Lilyisthatyou/ },
      { id: 'Austin-Americana-specific', turns: ['Two adults want Americana in Austin, Texas on Saturday October 3, 2026 only, $150 TOTAL including fees. Not a country-themed bar or tribute band. Give one or two and choose for us.', 'Keep Americana and Saturday October 3, not rock or a tribute act. What is verified about the total for two?'], forbid: /Kacey Musgraves|Cameron Whitcomb|THE CHICKS|QA Country Tribute Night|Late Static/, need: /QA Austin Americana/ },
      { id: 'Nashville-country-group', turns: ['Six adults want country or Americana in Nashville on Friday October 2 or Saturday October 3, 2026. Nashville only, not Franklin. Six seats together, $600 TOTAL including fees. One or two original artists and tell me which you would choose.', 'Saturday October 3 only. Keep Nashville, six together and $600 all-in. No Franklin. What is verified and what is still unknown?'], forbid: /QA Franklin Country|QA Nashville Later|Fri, Oct 2/, need: /QA Nashville Americana/ },
      { id: 'Austin-hard-no-match', turns: ['Country concert in Austin on Monday October 5, 2026 only. Two adults, $150 TOTAL including fees. No later dates.', 'Monday October 5 only please. Do not send the next dates.'], forbid: /Kacey Musgraves|Cameron Whitcomb|THE CHICKS|QA Austin Americana|QA Austin Country|next ones after/ },
      { id: 'Austin-later-opt-in-control', turns: ['Country concert in Austin on Monday October 5, 2026. Two adults, $150 total. Later dates are fine too.'], need: /Kacey Musgraves/ },
      { id: 'Brooklyn-under21-midnight', turns: ['House or minimal techno in Brooklyn on Friday October 2 or Saturday October 3, 2026. Prefer Elsewhere or Nowadays. I am 24 and my friend is 20, so no 21+ nights. We arrive at midnight. Two tickets, $120 TOTAL. Give one or two usable options and choose for us.', 'We cannot go to a 21+ event. Saturday October 3 only. Is late entry and the age policy actually verified?'], forbid: /Here’s the (?:listing|event page) for Dusky|• .*Dusky/ },
      { id: 'Brooklyn-house-other-night', turns: ['Two adults age 24 want house or minimal techno in Brooklyn on Friday October 2 or Saturday October 3, 2026. We arrive at midnight. Under $120 TOTAL including fees. Give one or two official listings and which you would choose.', 'Saturday October 3 only, no Manhattan or pop alternatives. Which house or minimal techno event could work, and is midnight entry verified?'], forbid: /• .*Dusky|Here’s the (?:listing|event page) for Dusky/, need: /Night Shift/ },
    ];
    for (const k of cases) {
      it(k.id, async () => {
        const turns = await converse(k.turns);
        const last = turns.at(-1)!;
        if (k.forbid) expect(last.text).not.toMatch(k.forbid);
        if (k.need) expect(last.text).toMatch(k.need);
        if (k.id === 'Brooklyn-under21-midnight') for (const r of turns) expect(r.text).not.toMatch(/Here’s the (?:listing|event page) for Dusky - 21\+/);
        if (k.id === 'LA-hard-saturday-exclusion') expect(last.brief.budgetCents).toBe(30000);
      });
    }
  });

  describe('controls (BUGS.json acceptance)', () => {
    it('age: an all-24 group keeps the 21+ night; an unstated minimum age stays unknown, never guessed from the venue', async () => {
      const [all24] = await converse(['Two adults, both 24, want house or minimal techno in Brooklyn on Friday October 2, 2026. Two tickets, $120 TOTAL including fees.']);
      expect(all24!.text).not.toMatch(/is out: it’s listed as 21\+/);
      const [, follow] = await converse(F.conversations.C02);
      expect(follow!.text).toContain('Minimum age: unknown. The event page doesn’t list one, and nothing I have states Brooklyn Basement’s age policy for that night');
      expect(follow!.text).toContain('The total for two isn’t checked yet; your limit is $120 including fees.');
    });
    it('exclusions: skip, leave out, don’t include, avoid and no each keep Constellation Room out; "is fine" lets it back', () => {
      const venues = [{ name: 'Constellation Room', aliases: [] }, { name: 'Elsewhere', aliases: [] }, { name: 'Nowadays', aliases: [] }];
      const ctx = { receivedAt: NOW, timeZone: 'America/Los_Angeles', venues };
      for (const said of ['Skip Constellation Room.', 'Leave out Constellation Room please.', "Don't include Constellation Room.", 'Avoid Constellation Room.', 'No Constellation Room.']) {
        const r = eventConstraints([said], ctx);
        expect(r.excludedVenues, said).toEqual(['constellation room']);
        expect(r.venueTerms, said).toBeNull();
      }
      expect(eventConstraints(['Only at Constellation Room please.'], ctx).venueTerms).toEqual(['constellation room']);
      // A preference is a place to start; "only" is a fence.
      expect(eventConstraints([F.conversations.C02[0]], ctx).venueTerms).toBeNull();
      expect(eventConstraints(['House in Brooklyn on Saturday, Elsewhere only.'], ctx).venueTerms).toEqual(['elsewhere']);
    });
    it('budget: an under-budget cap is kept; a seller’s quoted price is not their cap', async () => {
      const [under] = await converse(['Pop concert in Los Angeles on Saturday October 10, 2026, two tickets, under $250 total including fees.']);
      expect(under!.brief).toMatchObject({ budgetCents: 25000, budgetBasis: 'whole_party' });
      const [quote] = await converse(['I found two tickets for Rachel Bochner at The Moroccan Lounge on October 10, 2026 listed on StubHub at $300 total. Is that a good price?']);
      expect(quote!.brief.budgetCents).toBeNull();
    });
    it('venue: "Elsewhere only" stays a hard filter', async () => {
      const [only] = await converse(['House in Brooklyn on Saturday October 3, 2026 at Elsewhere only. Two adults, both 24. Two tickets, $120 total including fees.']);
      expect(only!.text).not.toContain('Night Shift');
    });
    it('geo: Franklin allowed outright is offered; ruled out, it never is (the rule is generic, not Franklin’s)', async () => {
      const [ok] = await converse(['Six adults want country or Americana in Nashville, Tennessee, on Saturday October 3, 2026. Franklin is fine too. Six seats together, $600 TOTAL including fees. Give one or two options.']);
      expect(ok!.text).toContain('QA Franklin Country');
      expect([...citiesRuledOut(['Nashville only, not Franklin.'], ['Nashville', 'Franklin'], ['Nashville'])]).toEqual(['franklin']);
      expect([...citiesRuledOut(['No Franklin.', 'Franklin is fine after all.'], ['Franklin'], ['Nashville'])]).toEqual([]);
      expect([...citiesRuledOut(['Los Angeles only, not Anaheim or Santa Ana.'], ['Los Angeles', 'Anaheim', 'Santa Ana'], ['Los Angeles'])].sort()).toEqual(['anaheim', 'santa ana']);
      // The city they're searching is never ruled out by a passing "not in".
      expect([...citiesRuledOut(['I’m not in Nashville until Friday.'], ['Nashville'], ['Nashville'])]).toEqual([]);
    });
    it('the helpers: a listed age rule, the group’s ages, readable titles', () => {
      expect(listedMinAge('Dusky - 21+')).toBe(21);
      expect(listedMinAge("Fox N' Vead (18 and Over)")).toBe(18);
      expect(listedMinAge('Night Shift: Deep House')).toBeNull();
      expect(partyAgeLimits(['I am 24 and my friend is 20, so no 21+ nights.'])).toEqual({ youngest: 20, who: 'your friend', refused: 21 });
      expect(ageRuledOut('Dusky - 21+', partyAgeLimits(['I am 24 and my friend is 20.']))).toBe('it’s listed as 21+, and your friend is 20');
      expect(ageRuledOut('Dusky - 21+', partyAgeLimits(['We are both 24.']))).toBeNull();
      expect(ageRuledOut("Fox N' Vead (18 and Over)", partyAgeLimits(['I am 24 and my friend is 20.']))).toBeNull();
      expect(readableTitle('BACKSTAGE NASHVILLE! DAYTIME HIT SONGWRITERS SHOW featuring Marv Green , Clint Daniels , Steven Dale Jones')).toBe('Backstage Nashville! Daytime Hit Songwriters Show');
      expect(readableTitle('Rachel Bochner: The "Sorry If It\'s Selfish" Tour')).toBe('Rachel Bochner: The "Sorry If It\'s Selfish" Tour');
    });
  });
});
