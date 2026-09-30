import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db';
import { openTestDb } from '../harness';
import replay from '../fixtures/qa-r8-sports-cases.json';
import variants from '../fixtures/qa-r8-variants.json';
import { replayR8, seedR8, body, type Case, type Mode, type Reply } from './qa-r8-harness';

/**
 * TGQA-R8 sports QA (deploy 2a0b5d1), every scenario replayed twice: with the rules reader, and with the fields the
 * production model read on the day put back over it (see qa-r8-harness.ts). Each assertion is an exact sentence
 * from the reply, and each hard constraint is checked on the opening turn, not only after a correction.
 */
for (const mode of ['rules', 'live'] as Mode[]) {
  describe(`TGQA-R8 sports QA, replayed (${mode === 'live' ? 'recorded model fields' : 'rules reader'})`, () => {
    let h: DbHandle;
    let replies: Map<string, Reply[][]>;
    beforeAll(async () => {
      h = await openTestDb();
      await seedR8(h);
      ({ replies } = await replayR8(h, { mode }));
    }, 300_000);
    afterAll(async () => {
      await h.close();
    });
    const turn = (id: string, n: number) => (replies.get(id)?.[n - 1] ?? []).map(body).join('\n\n=====\n\n');
    const all = (id: string) => (replies.get(id) ?? []).flat().map(body).join('\n\n');
    const count = (id: string, n: number) => replies.get(id)?.[n - 1]?.length ?? 0;

    // S01: the family comparison keeps the $500 cap and the adult-child pairs on every turn.
    it('S01 (15): B at $480 on the opening; still B when restated; A at $400 once singles are allowed', () => {
      for (const n of [1, 2]) {
        expect(turn('15', n)).toContain('Offer B is the one that meets what you asked for: $480 for all four, fees included. It leaves $20 of your $500 budget.');
        expect(turn('15', n)).toContain('They’re separate seats, so each child can’t sit beside an adult.');
        expect(turn('15', n)).toContain('- Offer C (four together, unobstructed, immediate transfer): $520 in total including fees. Over your $500 budget by $20.');
      }
      expect(turn('15', 3)).toContain('Offer A wins this one: $400 for all four, fees included. That’s $80 less than Offer B.');
      expect(all('15')).not.toMatch(/Offer C is the one|Which date|Which city/);
    });

    // S02: the customer's own deadline, in their zone, against each offer's promised transfer.
    it('S02 (17): B meets the 1pm New York deadline; A at 2pm New York fails; a 3pm deadline makes A the cheaper fit', () => {
      for (const n of [1, 2]) {
        expect(turn('17', n)).toContain('Offer B is the one that meets what you asked for: $220 for both, fees included.');
        expect(turn('17', n)).toMatch(/is 2pm New York time, an hour after your 1pm New York deadline|misses your 1pm New York deadline by an hour/);
        expect(turn('17', n)).toContain('a promised transfer time isn’t a completed transfer');
        expect(turn('17', n)).not.toContain('Offer A wins');
      }
      expect(turn('17', 3)).toContain('Offer A wins this one: $190 for both, fees included. That’s $30 less than Offer B.');
      expect(turn('17', 3)).toContain('(ordinary seats, delivery by 11am Los Angeles time (2pm New York time))');
      expect(turn('17', 3)).not.toContain('check its delivery time');
    });

    // S03: home-at-MSG is a hard rule on every path; a date that conflicts with it is said and asked, not swapped.
    it('S03 (01, 09, 10, 20): the next home game at MSG is Oct 8 whatever else the email says', () => {
      for (const id of ['01', '09', '10', '20']) {
        expect(turn(id, 1), id).toContain('Preseason: New York Knicks v Washington Wizards');
        expect(all(id), id).not.toMatch(/Xfinity|Philadelphia, Mon, Oct 5/);
      }
    });

    it('S03 (07): Oct 5 "at MSG" is said to be in Philadelphia and a choice is asked; no silent Oct 20', () => {
      expect(turn('07', 2)).toContain('Preseason: New York Knicks v Philadelphia 76ers at Xfinity Mobile Arena, Philadelphia, Mon, Oct 5, 7:00 PM EDT doesn\'t fit: it\'s in Philadelphia, not at Madison Square Garden.');
      expect(turn('07', 2)).toContain('Which would you like?');
      expect(turn('07', 2)).not.toMatch(/· 2 tickets · up to \$300/);
      expect(turn('07', 3)).toContain('Preseason: New York Knicks v Washington Wizards at Madison Square Garden, New York, Thu, Oct 8, 7:30 PM EDT · 2 tickets · up to $300 in total');
    });

    // S04: exclusions stay exclusions; a fallback that drops a rule says so.
    it('S04 (16): UBS and Prudential stay excluded; start times shown; "do those still match" answered', () => {
      for (const n of [1, 2]) {
        expect(turn('16', n)).toContain('• Sat, Nov 21, 7:30pm: New York Knicks vs. Portland Trail Blazers at Madison Square Garden.');
        expect(turn('16', n)).toContain('• Sun, Nov 22, 8pm: New York Knicks vs. Indiana Pacers at Madison Square Garden.');
        expect(turn('16', n)).not.toMatch(/UBS|Ubs|Prudential|Islanders|Devils|Rangers vs\. Boston/);
      }
      expect(turn('16', 3)).toMatch(/Both still fit your schedule|New York Knicks vs\. Portland Trail Blazers at Madison Square Garden, New York, Sat, Nov 21, 7:30 PM EST/);
    });

    it('S04 (04): next weekend has no game; the Sunday home game is offered as another date, never a Friday', () => {
      expect(turn('04', 1)).toContain('None of the two New York Knicks dates I found then fits: Mon, Oct 5, it\'s on a Monday; Thu, Oct 8, it\'s on a Thursday.');
      expect(turn('04', 1)).toContain('On another date, the next one that fits everything else you said is New York Knicks vs. Orlando Magic at Madison Square Garden, New York, Sun, Oct 25, 7:00 PM EDT. Want that one instead?');
      expect(all('04')).not.toMatch(/Boston|Fri, Oct 23|fits everything you said is/);
      expect(turn('04', 2)).toContain('New York Knicks vs. Orlando Magic at Madison Square Garden, New York, Sun, Oct 25, 7:00 PM EDT · 2 tickets · up to $300 in total');
    });

    // S05: the same offers under any labels, and follow-ups that change only a requirement.
    it('S05 (18): Gold/Green is compared at once, and gives the same totals as A/B', () => {
      for (const n of [1, 2]) {
        expect(turn('18', n)).toContain('Offer Green wins this one: $168.50 for both, fees included. That’s $0.25 less than Offer Gold.');
        expect(turn('18', n)).toContain('$72.50 each before fees, plus $23.75 for the whole order: $168.75 in total for both.');
        expect(turn('18', n)).not.toMatch(/Which game|Which city/);
      }
      expect(turn('18', 3)).toContain('Offer B wins this one: $168.50 for both, fees included. That’s $0.25 less than Offer A.');
    });

    it('S05 (14): B, then neither at $380, then B again at $390, with A late each time', () => {
      expect(turn('14', 1)).toContain('Offer B is the one that meets what you asked for: $390 for both, fees included.');
      expect(turn('14', 2)).toContain('None of the two meets all your requirements. The smallest change: if you can stretch to $390 in total, Offer B meets everything else.');
      expect(turn('14', 3)).toContain('Offer B is the one that meets what you asked for: $390 for both, fees included. It’s exactly your $390 budget.');
      for (const n of [1, 2, 3]) expect(turn('14', n)).toContain('Delivery by 5pm misses your 8am deadline.');
      expect(all('14')).not.toMatch(/You mentioned \$180|Looking at Offer B on its own/);
    });

    it('S05 (11): the three sellers keep their own fees across turns', () => {
      expect(turn('11', 2)).toContain('TickPick wins this one: $210 for both, fees included. That’s $5 less than Vivid Seats and $10 less than StubHub.');
    });

    // S06: the trend question first, even when the game is on general sale.
    it('S06 (13): every turn says there is no comparable history; no alert is set', () => {
      expect(turn('13', 1)).toContain('On buy or wait: I don’t have usable price history for two seats together at New York Knicks games');
      for (const n of [2, 3]) {
        expect(turn('13', n)).toContain('I don’t have a supported price trend for two seats together at this game');
        expect(turn('13', n)).toContain('I haven’t set an alert.');
      }
      expect(turn('13', 2)).not.toMatch(/reply "compare"/);
    });

    // S07: questions that aren't a ticket search don't start one.
    it('S07 (25, 26): capability-only and dinner-only follow-ups are answered and stop', () => {
      for (const n of [1, 2]) {
        expect(turn('25', n)).toContain('No. Automatic on-sale alerts are switched off for now, so I won’t email you when tickets go on sale, and nothing is watching this for you.');
        expect(turn('25', n)).not.toMatch(/Which date|Which game|tickets do you need/);
        expect(turn('26', n)).toContain('Restaurant and bar suggestions are outside what I do');
        expect(turn('26', n)).not.toMatch(/Which event|tickets do you need|Here are my/);
      }
      expect(turn('25', 1)).not.toContain('Knicks’s');
    });

    it('S07 (12): already paid gets transfer help, no shopping', () => {
      for (const n of [1, 2]) expect(turn('12', n)).toContain('Ask the seller for an official mobile transfer');
      expect(all('12')).not.toMatch(/\/go\/|Buy on|Which game/);
    });

    // S08: one missing-information ask, and the day they named read as that day.
    it('S08 (05, 13): "fri" and "this coming Friday" are Fri, Oct 2; each missing thing asked once', () => {
      for (const n of [1, 2, 3]) {
        expect(turn('05', n)).toMatch(/We don't have a scheduled New York Knicks event (?:in New York )?on Fri, Oct 2 on file/);
        expect(turn('05', n)).not.toMatch(/Which date are you looking at|Which city or venue/);
      }
      expect((turn('13', 1).match(/\?/g) ?? []).length).toBeLessThanOrEqual(2);
      expect(turn('13', 1)).not.toContain('We weren\'t sure which date');
    });

    // S09: the opt-out confirmation reads the stored scopes.
    it('S09 (22): both replies confirm the same full scope', () => {
      expect(turn('22', 1)).toContain('Done: this address now gets no ticket suggestions, no price-watch or event alerts, no follow-ups and no marketing from Ticket Guy.');
      expect(turn('22', 2)).toContain('Yes, that’s recorded (since Sep 30): this address gets no ticket suggestions, no price-watch or event alerts, no follow-ups and no marketing from Ticket Guy.');
    });

    // S10: delivery risk said as the real margin, and the market limitation said once.
    it('S10 (27): 4pm transfer is 3.5 hours before the 7:30pm start; one limitation; four people rejects the three-ticket offer', () => {
      for (const n of [1, 2]) {
        expect(turn('27', n)).toContain('The latest promised transfer is 4pm on Oct 8, 3.5 hours before the 7:30pm start.');
        expect(turn('27', n)).not.toMatch(/no time to fix|live resale listings for this show|charging for this show/);
        expect((turn('27', n).match(/can’t compare|can’t see/g) ?? []).length).toBeLessThanOrEqual(1);
      }
      expect(turn('27', 2)).toContain('I wouldn’t buy this one as it stands: it’s for 3 tickets, and you need 4.');
      expect(turn('27', 2)).toContain('$180 for three');
    });

    // Writing review 10: no "I'll look and come back" a second before an unreviewed answer.
    it('writing: an answer that goes out unreviewed comes alone', () => {
      for (const id of ['01', '20', '24']) expect(count(id, 1), id).toBe(1);
    });

    it('controls that passed live still pass (03, 06, 08, 19, 21, 23, 24)', () => {
      expect(turn('03', 1)).toContain('How many tickets do you need');
      expect(turn('06', 2)).toContain('None of these meets all your requirements. The smallest change: if you can stretch to $620 in total, Offer A meets everything else.');
      expect(turn('08', 2)).toContain('· 3 tickets · up to $200 in total');
      expect(turn('19', 1)).toContain('We only cover events in the US for now');
      expect(turn('21', 1)).toContain('Glad you got them. Enjoy it.');
      expect(turn('23', 2)).toContain('your request to delete your Ticket Guy data and preferences is verified');
      expect(turn('24', 2)).toContain('Barclays Center, Brooklyn, Thu, Oct 8, 7:30 PM EDT · 3 tickets · up to $240 in total');
    });

    it('prints', () => {
      const out = process.env[`PRINT_R8_${mode.toUpperCase()}`];
      if (out) writeFileSync(out, replay.cases.map((k) => k.turns.map((tt, i) => `##### ${k.id} turn ${i + 1} [${(replies.get(k.id)?.[i] ?? []).map((r) => `${r.template}/${r.state}`).join(', ')}]\n> ${tt.text}\n\n${turn(k.id, i + 1) || '(no reply)'}`).join('\n\n')).join('\n\n'));
      expect(replies.size).toBe(27);
    });
  });
}

describe('TGQA-R8 semantic variants: other labels, order, wording and one rule relaxed or tightened', () => {
  let h: DbHandle;
  let replies: Map<string, Reply[][]>;
  beforeAll(async () => {
    h = await openTestDb();
    await seedR8(h);
    ({ replies } = await replayR8(h, { mode: 'rules', cases: variants.cases as Case[] }));
  }, 300_000);
  afterAll(async () => {
    await h.close();
  });
  const turn = (id: string, n: number) => (replies.get(id)?.[n - 1] ?? []).map(body).join('\n\n=====\n\n');

  it('family pairs under other labels, cap stated last: South (the pairs) at $480', () => {
    expect(turn('v15-relabel', 1)).toContain('South is the one that meets what you asked for: $480 for all four, fees included.');
    expect(turn('v15-relabel', 1)).toContain('- East (four together, unobstructed, immediate transfer): $520 in total including fees. Over your $500 budget by $20.');
  });

  it('a higher cap alone does not make scattered singles fit while each child needs an adult', () => {
    expect(turn('v15-tighten', 1)).toContain('Offer B wins this one: $480 for all four, fees included. That’s $40 less than Offer C.');
    expect(turn('v15-tighten', 1)).toContain('They’re separate seats, so each child can’t sit beside an adult.');
  });

  it('"I need them by 12pm Pacific" against New York times: 2pm and 3pm New York both make noon Los Angeles', () => {
    expect(turn('v17-need-by', 1)).toContain('Offer A wins this one: $190 for both, fees included.');
    expect(turn('v17-need-by', 1)).toContain('delivery by noon Los Angeles time (3pm New York time)');
  });

  it('seller names in reversed order give the same totals and winner', () => {
    expect(turn('v18-sellers', 1)).toContain('Seller Blue wins this one: $168.50 for both, fees included. That’s $0.25 less than Seller Red.');
  });

  it('"home game at the Garden" is MSG', () => {
    expect(turn('v09-garden', 1)).toContain('Preseason: New York Knicks v Washington Wizards at Madison Square Garden');
    expect(turn('v09-garden', 1)).not.toContain('Philadelphia');
  });

  it('"Excluding UBS Arena and Prudential Center" excludes them', () => {
    expect(turn('v16-exclude', 1)).not.toMatch(/UBS|Prudential|Islanders|Devils/);
    expect(turn('v16-exclude', 1)).toContain('Sat, Nov 21 at 7:30pm');
  });

  it('capability and dinner paraphrases stop without intake', () => {
    expect(turn('v25-para', 1)).toContain('No. Automatic on-sale alerts are switched off for now');
    for (const n of [1, 2]) expect(turn('v26-para', n)).toContain('Restaurant and bar suggestions are outside what I do');
  });
});
