import { describe, expect, it } from 'vitest';
import { asksWhichDate, daysNamed, kindCorrection, weekdaysNamed, whichDateLine } from '@/lib/intake/answer-first';

/** #177 helpers, on invented wording. */
describe('what a follow-up says that the reply must answer first', () => {
  it.each([
    ["it's not a game, it's a concert", { is: 'concert', not: 'game' }],
    ['Its a show not a game!', { is: 'show', not: 'game' }],
    ['this is a play, not a concert', { is: 'play', not: 'concert' }],
  ] as const)('"%s" is a correction', (text, want) => expect(kindCorrection(text)).toEqual(want));
  it.each(["it's a concert", 'not a game person myself', "it's a game, a big game"])('"%s" is not', (text) => expect(kindCorrection(text)).toBeNull());

  const at = new Date('2026-10-01T15:00:00Z');
  it('reads the dates and weekdays a message names', () => {
    expect(daysNamed('Thursday Nov 19 or Saturday Nov 21?', at)).toEqual(['2026-11-19', '2026-11-21']);
    expect(daysNamed('the jan 9th one', at)).toEqual(['2027-01-09']);
    expect(weekdaysNamed('thursday or sat?')).toEqual(['thursday', 'saturday']);
    expect(asksWhichDate('which one, Thursday Nov 19 or Saturday Nov 21?', at)).toBe(true);
    expect(asksWhichDate('2 tickets for Nov 19 please', at)).toBe(false);
  });

  const held = [{ localDate: '2026-11-19', weekday: 'thursday', label: 'Thursday, November 19' }, { localDate: '2026-11-21', weekday: 'saturday', label: 'Saturday, November 21' }];
  it('answers with what is held, and which one the email is about', () => {
    expect(whichDateLine({ asked: [], askedWeekdays: ['thursday', 'saturday'], held, current: held[0]!, noun: 'show', venue: 'Harborview Arena' })).toBe('Both: there’s a show at Harborview Arena on Thursday, November 19 and on Saturday, November 21. This email is about Thursday, November 19; reply with “Saturday” and I’ll look at that one instead.');
    expect(whichDateLine({ asked: ['2026-11-19', '2026-11-22'], askedWeekdays: [], held: [held[0]!], current: held[0]!, noun: 'show', venue: 'Harborview Arena' })).toMatch(/^The one I have on file is Thursday, November 19 at Harborview Arena\. I don’t have a show there on Sunday, November 22/);
  });
});
