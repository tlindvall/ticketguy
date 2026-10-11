import { describe, expect, it } from 'vitest';
import { renderTemplate } from '@/lib/email/templates';

/**
 * Live Oct 5: "On buy or wait: … I searched Ticketmaster's listings and couldn't find … The closest New York Rangers
 * games I have: • Tomorrow… • Sunday…" came as one paragraph, bullets and all. Each part of the note is its own
 * paragraph, and the games are a list.
 */
describe('the clarification note', () => {
  const ctx = { appUrl: 'https://ticketguy.now', postalAddress: null };
  it('is paragraphs of its own, with the games as a list', () => {
    const r = renderTemplate('clarification', {
      acknowledgement: 'Two New York Rangers tickets for Monday, October 5. Got it.',
      eventNote: 'On buy or wait: I haven’t looked at price history yet.\n\nI searched Ticketmaster and couldn’t find a game then.\n\nThe closest New York Rangers games I have:\n• Tomorrow at 7:30 p.m.: vs. New York Islanders\n• Sunday, October 11, at 6 p.m.: vs. Vancouver Canucks',
      questions: ['Is it one of those? Tell me which and I’ll take it from there.'],
    }, ctx);
    expect(r.html).toContain('<p style="margin:0 0 8px;">The closest New York Rangers games I have:</p><ul');
    expect(r.html).toContain('<li style="margin:0 0 4px;">Tomorrow at 7:30 p.m.: vs. New York Islanders</li>');
    expect(r.html).not.toMatch(/I have: •/);
    expect(r.text).toContain('On buy or wait: I haven’t looked at price history yet.\n\nI searched Ticketmaster');
  });

  it('a long list keeps its bullets when a closing line follows it ("…and 4 more after that.")', () => {
    // Live Oct 10: eleven St. Louis Blues games ended with that line, failed "every line is a bullet", and arrived as one
    // paragraph: "Here are the St. Louis Blues games: • Tonight at 6 p.m.: … • Thursday, October 15 …".
    const games = Array.from({ length: 10 }, (_, i) => `• Thursday, October ${12 + i}, at 7 p.m.: vs. Team ${i + 1}`);
    const r = renderTemplate('clarification', {
      acknowledgement: 'Rangers tickets. Got it.',
      eventNote: `Here are the New York Rangers games:\n${games.join('\n')}\n…and 4 more after that.`,
      questions: ['Which one do you want, and how many tickets?'],
    }, ctx);
    expect(r.html).toContain('<p style="margin:0 0 8px;">Here are the New York Rangers games:</p><ul');
    expect(r.html.match(/<li /g)).toHaveLength(10);
    expect(r.html).toContain('</ul><p style="margin:0 0 18px;">…and 4 more after that.</p>');
    expect(r.html).not.toMatch(/games: •|\d p\.m\.: vs\. Team \d+ •/);
  });
});
