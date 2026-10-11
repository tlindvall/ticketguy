import { describe, expect, it } from 'vitest';
import { briefHeadline, eventCard, firstSentence } from '@/lib/email/ticket-brief';
import { renderTemplate } from '@/lib/email/templates';

/**
 * Live, Oct 10: "I believe all the email template designs aren't showing since we changed the logic." The brief's design
 * was drawn only for named seats; the ranked games, the browse picks, a verdict on their listing and a general sale went
 * out as paragraphs. Every answer now carries the brief's headline and card; the plain text is unchanged.
 */
describe('the brief’s design on every answer', () => {
  const ctx = { appUrl: 'https://ticketguy.now', postalAddress: null };

  it('the headline is the first sentence, never cut at "vs.", "St." or an initial', () => {
    expect(firstSentence('Cheapest before Christmas: the St. Louis Blues game on Tue, Nov 3. Lowest listed prices for two:')).toEqual(['Cheapest before Christmas: the St. Louis Blues game on Tue, Nov 3.', 'Lowest listed prices for two:']);
    expect(firstSentence('Rangers vs. Blues is the one. It’s $74.')).toEqual(['Rangers vs. Blues is the one.', 'It’s $74.']);
    expect(firstSentence('J. Cole at Mt. Hood Arena, from $74.50 a ticket.')).toEqual(['J. Cole at Mt. Hood Arena, from $74.50 a ticket.', '']);
    expect(firstSentence('More hockey in New York, this week:')).toEqual(['More hockey in New York, this week:', '']);
    expect(briefHeadline('I’d buy these. They’re under your budget.')).toMatch(/<h1[^>]*>I’d buy these\.<\/h1><p[^>]*>They’re under your budget\.<\/p>/);
    expect(briefHeadline('<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('the event card shows an https banner only, never a broken or insecure image', () => {
    const base = { category: 'NHL', name: 'Rangers vs. Blues', details: 'Garden Arena · Tue, Nov 3' };
    expect(eventCard({ ...base, artworkUrl: 'https://ticketguy.now/brief-art/v1/hockey/a/b.jpg' })).toContain('<img src="https://ticketguy.now/brief-art/v1/hockey/a/b.jpg"');
    expect(eventCard({ ...base, artworkUrl: 'http://ticketguy.now/a.jpg' })).not.toContain('<img');
    expect(eventCard({ ...base, artworkUrl: '/brief-art/v1/hockey/a/b.jpg' })).not.toContain('<img');
    expect(eventCard({ ...base, artworkUrl: null })).toMatch(/NHL \/ Your ticket brief<\/div><h2[^>]*>Rangers vs\. Blues<\/h2><p[^>]*>Garden Arena · Tue, Nov 3<\/p>/);
  });

  const sale = { eventLabel: 'x', eventTitle: 'Big Thief', eventWhen: 'Sat, Oct 3 at 8pm', venueName: 'Brooklyn Steel', seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/e/1', eventUrl: 'https://www.ticketmaster.com/e/1', quantity: 2 };

  it('a general sale is the headline with the seller linked, then the event card with its page as the button', () => {
    const r = renderTemplate('official_sale', { ...sale, category: 'Concert', artworkUrl: 'https://img.example/big-thief.jpg' }, ctx);
    expect(r.html).toMatch(/<h1[^>]*>Big Thief is still on general sale on <a href="https:\/\/www\.ticketmaster\.com\/e\/1"[^>]*>Ticketmaster<\/a>\.<\/h1><p[^>]*>I can’t see whether it has seats left, but if it does, that's where I'd buy your 2 tickets\.<\/p>/);
    expect(r.html).toMatch(/Concert \/ Your ticket brief<\/div><h2[^>]*>Big Thief<\/h2><p[^>]*>Sat, Oct 3 at 8pm · Brooklyn Steel<\/p>/);
    expect(r.html).toContain('<img src="https://img.example/big-thief.jpg"');
    expect(r.html).toMatch(/<a href="https:\/\/www\.ticketmaster\.com\/e\/1"[^>]*>Event page on Ticketmaster&nbsp;↗<\/a>/);
    // The plain text says the same, in the words it always had.
    expect(r.text).toContain("Big Thief (Sat, Oct 3 at 8pm at Brooklyn Steel) is still on general sale on Ticketmaster. I can’t see whether it has seats left, but if it does, that's where I'd buy your 2 tickets.");
    expect(r.text).toContain('Event page on Ticketmaster: https://www.ticketmaster.com/e/1');
  });

  it('with seats unchecked, the headline says the sale and the checks follow the card', () => {
    const r = renderTemplate('official_sale', { ...sale, category: 'Concert', unverified: ['Seats together'] }, ctx);
    expect(r.html).toMatch(/<h1[^>]*>Big Thief is on general sale on <a[^>]*>Ticketmaster<\/a>\.<\/h1><p[^>]*>I haven’t seen its seats or prices, so I can’t tell you yet whether any fit what you need\.<\/p>/);
    expect(r.html.indexOf('Your ticket brief')).toBeLessThan(r.html.indexOf('Check these on the event page before you buy'));
    expect(r.html).not.toContain('<img');
  });

  it('a send queued before the design keeps the body it was written with', () => {
    const r = renderTemplate('official_sale', sale, ctx);
    expect(r.html).not.toMatch(/<h1|Your ticket brief/);
    expect(r.html).toContain('>Ticketmaster</a>. I can’t see whether it has seats left');
  });

  it('a long verdict steps down a size; a browse that answers a question makes the answer its headline', () => {
    const long = briefHeadline('I wouldn’t buy these: at $210 a ticket they’re $60 over the cheapest comparable seats in section 112, and two rows further back. Here’s why.');
    expect(long).toMatch(/<h1[^>]*font-size:20px[^>]*>I wouldn’t buy these:/);
    expect(briefHeadline('Cheapest: the Ottawa Senators game on Tue, Nov 3.')).toContain('font-size:25px');
    const pick = { line: 'Fri, Oct 16: New York Knicks vs. Boston Celtics at Madison Square Garden', title: 'New York Knicks vs. Boston Celtics', reason: '', eventUrl: null, links: [] };
    const r = renderTemplate('browse_options', { answer: 'Yes, the Knicks play at home on Friday.', headline: 'Basketball in New York, this week:', options: [pick.line], picks: [pick], moreCount: 0 }, ctx);
    expect(r.html).toMatch(/<h1[^>]*>Yes, the Knicks play at home on Friday\.<\/h1>/);
    expect(r.html).toContain('<p style="margin:0 0 18px;">Basketball in New York, this week:</p>');
    expect(r.html.match(/<h1/g)).toHaveLength(1);
  });

  it('a ranked list marks the cheapest only when its price is on the line; a list without prices has no badge', () => {
    const pick = (line: string, title: string) => ({ line, title, reason: '', eventUrl: null, links: [], category: 'NHL' });
    const priced = renderTemplate('games_ranked', { headline: 'Cheapest: the Ottawa Senators game on Tue, Nov 3. Lowest listed prices for two, a ticket before fees:', picks: [pick('Tue, Nov 3: Rangers vs. Ottawa Senators at Garden Arena, from $74', 'Rangers vs. Ottawa Senators'), pick('Fri, Nov 20: Rangers vs. Utah Mammoth at Garden Arena, from $81', 'Rangers vs. Utah Mammoth')], nextStep: 'Reply with the date.' }, ctx);
    expect(priced.html.match(/Lowest listed price</g)).toHaveLength(1);
    expect(priced.html).toMatch(/Lowest listed price<\/span><div[^>]*>NHL · Tue, Nov 3<\/div><h3[^>]*>Rangers vs\. Ottawa Senators<\/h3><p[^>]*>Garden Arena<\/p><div[^>]*>From \$74<\/div>/);
    const dated = renderTemplate('games_ranked', { headline: 'Two Rangers games, in date order. I can’t rank them on price for you.', picks: [pick('Tue, Nov 3: Rangers vs. Ottawa Senators at Garden Arena', 'Rangers vs. Ottawa Senators')], nextStep: 'Reply with the date.' }, ctx);
    expect(dated.html).not.toMatch(/Lowest listed price|From \$/);
    expect(dated.html).toMatch(/<h1[^>]*>Two Rangers games, in date order\.<\/h1>/);
  });
});
