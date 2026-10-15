import { describe, expect, it } from 'vitest';
import { answerBody, sameReply } from '@/lib/intake/repeat';
import { asksOtherGamesForBudget } from '@/lib/intake/pipeline';

/** Live Oct 15 (Rangers): the same email went out twice. A repeat is the same pick in the same words. */
describe('the same reply twice', () => {
  const rec = (price: string, link = 'https://example.invalid/fixture/rc-2-upper-214', extra = '') => `Hey,

New York Rangers vs. Montreal Canadiens
Madison Square Garden, New York · Monday, November 16, at 7 p.m. · 2 tickets · up to $150 in total

The closest lead is 2 seats together in section 214, row F: ${price} total, $96 over. ${extra}

Would you go up to about ${price} for these, or should I look at other seats or another date?

Link: ${link}

Ticket Guy`;

  it('the identical email is a repeat, whatever the greeting or signature', () => {
    expect(sameReply(rec('$246'), rec('$246'))).toBe(true);
    expect(sameReply(rec('$246'), rec('$246').replace('Hey,', 'Hi Sam,').replace('Ticket Guy', '— Ticket Guy'))).toBe(true);
  });
  it('a moved price or another listing is an update, not a repeat', () => {
    expect(sameReply(rec('$246'), rec('$230'))).toBe(false);
    expect(sameReply(rec('$246'), rec('$246', 'https://example.invalid/fixture/rc-2-lower-108'))).toBe(false);
  });
  it('a different answer is not a repeat', () => {
    expect(sameReply(rec('$246'), 'Hey,\n\nThree Rangers games have a pair at $150 or less, all-in:\n\nTue, Nov 10: Flyers, $138 for both.\n\nTicket Guy')).toBe(false);
  });
  it('the answer is the email without its greeting and signature', () => {
    expect(answerBody('Hey,\n\nThe answer.\n\nTicket Guy\nYour second opinion before you buy.')).toBe('The answer.');
  });
});

describe('"what other games for that price?" is a request, not a yes', () => {
  it.each([
    'yes what other games can I see for that price? total yes.',
    'what other games can i see for that price',
    'any games under $150?',
    'which other dates fit my budget?',
    'Are there any other games in my budget?',
    'what other nights are there for about $150',
  ])('asks: %s', (t) => expect(asksOtherGamesForBudget(t)).toBe(true));
  it.each([
    'yes',
    'yes, $246 is fine',
    'what other games are there?',
    'is that the best price?',
    'what time is the game?',
  ])('does not ask: %s', (t) => expect(asksOtherGamesForBudget(t)).toBe(false));
});
