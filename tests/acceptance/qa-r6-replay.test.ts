import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db';
import { openTestDb } from '../harness';
import replay from '../fixtures/qa-r6-cases.json';
import { replayR6, seedR6, body, type Reply } from './qa-r6-harness';
import { asc, desc, eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { qaTrace } from '@/lib/admin/test-inbox';

describe('TGQA-R6 API QA (30 Sep 2026), replayed through test mode', () => {
  let h: DbHandle;
  let replies: Map<string, Reply[][]>;
  beforeAll(async () => {
    h = await openTestDb();
    await seedR6(h);
    ({ replies } = await replayR6(h));
  }, 240_000);
  afterAll(async () => {
    await h.close();
  });
  /** Every reply to turn `n` (1-based) of case `id`, joined. */
  const turn = (id: string, n: number) => (replies.get(id)?.[n - 1] ?? []).map(body).join('\n\n=====\n\n');

  const all = (id: string) => (replies.get(id) ?? []).flat().map(body).join('\n\n');
  const states = (id: string, n: number) => (replies.get(id)?.[n - 1] ?? []).map((r) => r.state);

  // P1: unsafe recommendations blocked (TGQA-R6 1001-1005).
  it('08: explains the Philadelphia mismatch, never recommends it, keeps the access needs', () => {
    expect(turn('08', 2)).toContain("Preseason: New York Knicks v Philadelphia 76ers at Xfinity Mobile Arena, Philadelphia, Mon, Oct 5, 7:00 PM EDT doesn't fit: it's in Philadelphia, not at Madison Square Garden.");
    expect(turn('08', 2)).toContain('The next one that fits everything you said is Preseason: New York Knicks v Washington Wizards at Madison Square Garden, New York, Thu, Oct 8, 7:30 PM EDT. Shall I go with that one?');
    expect(turn('08', 3)).toMatch(/^Hey Jordan,\n\nPreseason: New York Knicks v Washington Wizards at Madison Square Garden, New York, Thu, Oct 8/);
    for (const n of [1, 2, 3]) expect(turn('08', n)).toContain(n === 2 ? 'Two New York Knicks tickets' : 'a wheelchair space with a companion seat beside it and a step-free route');
    expect(all('08')).not.toMatch(/Buy on|Event page on/);
    expect(turn('08', 3)).not.toContain('Philadelphia');
  });

  it('09: evening show only; A misses the 8am deadline, B fits; $360 and $390 stay order totals', () => {
    for (const n of [2, 3]) {
      expect(turn('09', n)).toContain('Hamilton (NY) at Richard Rodgers Theatre, New York, Sat, Oct 3, 8:00 PM EDT');
      expect(turn('09', n)).toContain('Seller B is the one that meets what you asked for: $390 for both, fees included.');
      expect(turn('09', n)).toContain('- Seller A (ordinary seats, delivery by 5pm): $360 in total including fees. Delivery by 5pm misses your 8am deadline.');
      expect(turn('09', n)).toContain('Based on the details you sent; I haven’t verified availability.');
    }
    expect(all('09')).not.toMatch(/1:00 PM|at 1pm|\$720|\$780/);
  });

  it('15: keeps 7pm, $180 and the $24 order fee; the $200 budget stays separate; three seats do not cover four', () => {
    expect(turn('15', 1)).toContain('Kanan Gill: Not This Again at Town Hall, New York, Sat, Oct 3, 7:00 PM EDT · 3 tickets · up to $200 in total');
    for (const n of [1, 2, 3]) expect(turn('15', n)).toContain('The screenshot you sent shows $52 a ticket before fees, plus $24 in fees for the order: $180 for three, which is $60 each including fees.');
    for (const n of [2, 3]) {
      expect(turn('15', n)).toContain('· 4 tickets · up to $200 in total');
      expect(turn('15', n)).toContain('I wouldn’t buy this one as it stands: it’s for 3 tickets, and you need 4.');
      expect(turn('15', n)).not.toContain('Buy on Ticketmaster');
    }
    expect(all('15')).not.toMatch(/4:00 PM|Updated from your email|up to \$180/);
  });

  it('17: keeps the exact 7pm performance from the link, never the 4pm one', () => {
    expect(turn('17', 1)).toContain('That’s Kanan Gill: Not This Again at Town Hall, New York, Sat, Oct 3, 7:00 PM EDT.');
    for (const n of [2, 3]) expect(turn('17', n)).toContain('Kanan Gill: Not This Again at Town Hall, New York, Sat, Oct 3, 7:00 PM EDT · 3 tickets · up to $200 in total · from the Ticketmaster link you sent');
    expect(all('17')).not.toContain('4:00 PM');
  });

  it('18: B at $480 is eligible; A (scattered singles) and C ($520, over $500) are not', () => {
    expect(turn('18', 2)).toContain('- Two adjacent pairs, with each adult beside a child');
    expect(turn('18', 3)).toContain('Offer B is the one that meets what you asked for: $480 for all four, fees included. It leaves $20 of your $500 budget.');
    expect(turn('18', 3)).toContain('- Offer A (ordinary seats, not together, immediate transfer): $400 in total including fees. They’re separate seats, so each adult can’t sit with a child.');
    expect(turn('18', 3)).toContain('- Offer C (four together, immediate transfer): $520 in total including fees. Over your $500 budget by $20.');
  });

  it('04: next weekend has only Monday and Thursday games; says so and offers the next weekend game', () => {
    expect(turn('04', 1)).toContain("None of the two New York Knicks dates I found then fits: Mon, Oct 5, it's on a Monday; Thu, Oct 8, it's on a Thursday.");
    expect(turn('04', 2)).toContain('New York Knicks vs. Fixture Opponent at Madison Square Garden, New York, Sat, Oct 24, 7:30 PM EDT · 2 tickets · up to $300 in total');
  });

  it('06: a Friday without a game is said plainly; the day is never changed', () => {
    for (const n of [1, 2, 3]) {
      expect(turn('06', n)).toMatch(/We don't have a scheduled New York Knicks event (?:in New York )?on Fri, Oct 2 on file/);
      expect(turn('06', n)).not.toMatch(/Oct 5|Oct 8|Which New York Knicks date and venue/);
    }
  });

  it('10: November weekends, starting after 7pm (not at 7)', () => {
    for (const n of [1, 2]) {
      expect(turn('10', n)).toContain('Wicked (Sat, Nov 14 at 8pm at Gershwin Theatre)');
      expect(turn('10', n)).not.toMatch(/Nov 11|Nov 7\b|Sep 30|7pm at Gershwin/);
    }
  });

  it('19: MSG or Barclays in November only; no other venue offered', () => {
    for (const n of [1, 2, 3]) {
      expect(turn('19', n)).toContain("I don't have any rock and indie in New York on file for Nov 1 to 30 at Madison Square Garden or Barclays Center.");
      expect(turn('19', n)).not.toMatch(/Bowery|Irving|Brooklyn Steel|September|Sep \d/);
    }
  });

  it('20: comedy on Sat Oct 3 strictly after 7pm: says there is none rather than offering 4pm or 7pm', () => {
    for (const n of [2, 3]) {
      expect(turn('20', n)).toContain("I don't have any comedy in New York on file for Sat, Oct 3 starting after 7pm.");
      expect(turn('20', n)).not.toMatch(/Kanan Gill|Restaurant and bar/);
    }
  });

  // P2: supplied comparisons answered from the details given (1006-1009).
  it('07: none fit: A is $20 over, B needs an extra ticket, C is obstructed; no date intake', () => {
    for (const n of [2, 3]) {
      expect(turn('07', n)).toContain('None of these meets all your requirements. The smallest change: if you can stretch to $620 in total, Offer A meets everything else.');
      expect(turn('07', n)).toContain('Over your $600 budget by $20.');
      expect(turn('07', n)).toContain('It’s six tickets the seller won’t split, and you won’t buy an extra.');
      expect(turn('07', n)).toContain('It has an obstructed view, which you ruled out.');
      expect(turn('07', n)).not.toMatch(/Which (?:game|date)/);
    }
  });

  it('14: totals $220 / $210 / $215; TickPick saves $10 and $5', () => {
    for (const n of [2, 3]) {
      expect(turn('14', n)).toContain('TickPick wins this one: $210 for both, fees included. That’s $5 less than Vivid Seats and $10 less than StubHub.');
      expect(turn('14', n)).toContain('$220 in total for both');
      expect(turn('14', n)).toContain('$215 in total for both');
    }
  });

  it('13: offer B saves $162 and the listing price never becomes their budget', () => {
    expect(turn('13', 3)).toContain('Offer B wins this one: $250 for both, fees included. That’s $162 less than Offer A.');
    expect(all('13')).not.toMatch(/up to \$412|\$412 budget/);
  });

  it('01 / 02 / 03 / 05 / 11 / 30: next home games resolved; no repeated home/away or date question', () => {
    for (const [id, n, label] of [
      ['01', 2, 'Preseason: New York Knicks v Washington Wizards at Madison Square Garden, New York, Thu, Oct 8, 7:30 PM EDT · 2 tickets · up to $300 in total'],
      ['02', 2, 'New York Knicks vs. Fixture Opponent at Madison Square Garden, New York, Sat, Oct 24, 7:30 PM EDT · 2 tickets · up to $300 in total'],
      ['03', 2, 'New York Rangers vs. Tampa Bay Lightning at Madison Square Garden, New York, Thu, Oct 1, 7:00 PM EDT · 3 tickets · up to $240 in total'],
      ['05', 2, 'New York Rangers vs. Tampa Bay Lightning at Madison Square Garden, New York, Thu, Oct 1, 7:00 PM EDT · 2 tickets · up to $200 in total'],
      ['11', 2, 'Brooklyn Nets vs. Toronto Raptors at Barclays Center, New York, Sat, Oct 10, 7:30 PM EDT · 3 tickets · up to $200 in total'],
      ['30', 2, 'Brooklyn Nets vs. Toronto Raptors at Barclays Center, New York, Sat, Oct 10, 7:30 PM EDT · 3 tickets · up to $240 in total'],
    ] as const) expect(turn(id, n)).toContain(label);
    for (const id of ['01', '03', '11', '30']) expect(all(id)).not.toMatch(/home or away|Which game|What date/i);
    expect(turn('03', 1)).toContain('That’s New York Rangers vs. Tampa Bay Lightning at Madison Square Garden, New York, Thu, Oct 1, 7:00 PM EDT.');
  });

  it('16 / 26: entry help for bought tickets; no buy link and no ticket values repeated', () => {
    for (const id of ['16', '26']) {
      for (const n of [1, 2, 3]) {
        expect(turn(id, n)).toContain('Ask the seller for an official mobile transfer; don’t count on the PDF or screenshot of the barcode to get you in.');
        expect(turn(id, n)).not.toMatch(/Buy on|Event page on|\/go\//);
        expect(states(id, n)).toContain('closed');
      }
    }
    expect(turn('16', 1)).toContain('The image you sent looked like it showed a barcode, so I deleted it without reading it.');
  });

  it('21 / 22: London is out of scope; a New York request with London as background is served, evening only', () => {
    expect(turn('21', 1)).toContain('We only cover events in the US for now, so I can’t help with Hamilton in London, UK.');
    for (const n of [1, 2]) {
      expect(turn('22', n)).toContain('Hamilton (NY) (Sat, Oct 3 at 8pm at Richard Rodgers Theatre)');
      expect(turn('22', n)).not.toMatch(/1pm|London/);
    }
  });

  it('23: dinner is out of scope and says so', () => {
    expect(turn('23', 1)).toContain('Restaurant and bar suggestions are outside what I do: I only help with tickets, so I don’t have anything reliable on places to eat near Madison Square Garden.');
  });

  // Routing and preference flows (1010-1014).
  it('24: a direct trend abstention; no alert set', () => {
    expect(turn('24', 2)).toContain('On buy or wait: I don’t have usable price history for two seats together at New York Knicks games, so I can’t tell you whether prices are rising or falling, and waiting would be a guess. I haven’t set an alert.');
    expect(turn('24', 3)).toContain('I don’t have a supported price trend for two seats together at this game, so I can’t tell you whether prices are rising or falling, and waiting would be a guess.');
    expect(turn('24', 3)).toContain('I haven’t set an alert.');
    expect(all('24')).not.toMatch(/I’ll (?:watch|keep an eye)|I'll (?:watch|keep an eye)|price watch is on/i);
  });

  it('25: says plainly there is no automatic on-sale email', () => {
    for (const n of [1, 2]) {
      expect(turn('25', n)).toContain('I can’t email you when tickets go on sale: automatic on-sale alerts are switched off for now, so nothing is watching this for you.');
      expect(turn('25', n)).not.toMatch(/Which (?:Dua Lipa )?date/);
    }
  });

  it('27: closure does not imply a watch', () => {
    expect(turn('27', 1)).toContain('Glad you got them. Enjoy it.');
    expect(turn('27', 1)).not.toMatch(/watch/i);
  });

  it('28: opt-out is acknowledged and then confirmed from the stored preference', () => {
    expect(turn('28', 1)).toContain('Done: this address now gets no ticket suggestions, no price-watch or event alerts, no follow-ups and no marketing from Ticket Guy.');
    expect(turn('28', 2)).toContain('Yes, that’s recorded (since Sep 30): this address gets no ticket suggestions, no price-watch or event alerts, no follow-ups and no marketing from Ticket Guy.');
  });

  it('29: CONFIRM verifies the deletion and never restarts intake', () => {
    expect(turn('29', 1)).toContain('reply to this email with the word CONFIRM');
    expect(turn('29', 2)).toContain('Thanks, that’s confirmed: your request to delete your Ticket Guy data and preferences is verified.');
    expect(turn('29', 3)).toContain('Your deletion request is verified and waiting for a person on the team to complete it; it isn’t done yet.');
    for (const n of [2, 3]) expect(turn('29', n)).not.toMatch(/Knicks|tickets do you need|CONFIRM/);
  });

  // Voice (1015, 1016, writing review).
  it('never closes with the canned "Just reply and I’ll narrow it down"', () => {
    for (const id of replies.keys()) expect(all(id)).not.toContain('Just reply and I’ll narrow it down');
  });

  // The QA API's evidence (/api/test/requests/{id}): state trace, stops, deletion, kept offers, generated HTML.
  const traceOf = async (id: string) => {
    const k = replay.cases.find((c) => c.id === id)!;
    const from = k.from ?? replay.cases.find((c) => c.id === k.thread)!.from!;
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.emailLookup, from.toLowerCase()));
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.contactId, contact!.id)).orderBy(desc(t.requests.createdAt));
    const messages = await h.db.select().from(t.messages).where(eq(t.messages.conversationId, req!.conversationId)).orderBy(asc(t.messages.receivedAt));
    const intents = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.conversationId, req!.conversationId)).orderBy(asc(t.sendIntents.createdAt));
    return qaTrace(h.db, req!, messages, intents);
  };

  it('QA trace: deletion status, stored stops, kept offers with provenance, and email HTML', async () => {
    const del = await traceOf('29');
    expect(del.deletion?.status).toBe('verified_awaiting_staff');
    expect(del.suppression.stopped.map((x) => x.scope).sort()).toEqual(['marketing', 'watch']);
    const opt = await traceOf('28');
    expect(opt.suppression.stopped.length).toBeGreaterThan(0);
    expect(opt.trace.transitions.at(-1)?.to).toBe('closed');
    const hamilton = await traceOf('09');
    expect(hamilton.offers.fromLatestMessage?.provenance).toBe('customer_text');
    expect(hamilton.offers.fromLatestMessage?.offers.map((o) => [o.label, o.totalCents])).toEqual([['A', 36000], ['B', 39000]]);
    expect(hamilton.emails.every((e) => e.html.length > 0 && e.text.length > 0)).toBe(true);
    const shot = await traceOf('15');
    expect(shot.offers.listings.find((l) => !l.sensitive)?.fields).toMatchObject({ wholePartyCents: 18000, eventTime: '19:00' });
    const entry = await traceOf('16');
    expect(entry.offers.listings.filter((l) => l.sensitive).every((l) => l.fields === null)).toBe(true);
    expect(JSON.stringify(entry)).not.toMatch(/https?:\/\/[^"]*(?:signature|token|X-Amz)/i);
  });

  it('prints', () => {
    if (process.env.PRINT_REPLAY) writeFileSync(process.env.PRINT_REPLAY, replay.cases.map((k) => k.turns.map((tt, i) => `##### ${k.id} turn ${i + 1} [${(replies.get(k.id)?.[i] ?? []).map((r) => `${r.template}/${r.state}`).join(', ')}]\n> ${tt.text}\n\n${turn(k.id, i + 1) || '(no reply)'}`).join('\n\n')).join('\n\n'));
    expect(replies.size).toBe(30);
  });
});
