import { describe, expect, it } from 'vitest';
import { noDashes } from '@/lib/email/punctuation';
import { renderTemplate } from '@/lib/email/templates';

describe('noDashes', () => {
  it('reads ranges as "to", joins words with a hyphen, drops a sign-off dash, and turns a clause dash into a comma', () => {
    expect(noDashes('$80–$120 a ticket')).toBe('$80 to $120 a ticket');
    expect(noDashes('Oct 1–7 and 9am – 9pm')).toBe('Oct 1 to 7 and 9am to 9pm');
    expect(noDashes('Wilkes–Barre')).toBe('Wilkes-Barre');
    expect(noDashes('Thanks\n— Tobias')).toBe('Thanks\nTobias');
    expect(noDashes('<p>— Ticket Guy</p>')).toBe('<p>Ticket Guy</p>');
    expect(noDashes('Taylor Swift — The Eras Tour')).toBe('Taylor Swift, The Eras Tour');
    expect(noDashes('up to $200 total—got it.')).toBe('up to $200 total, got it.');
    expect(noDashes('the end —.')).toBe('the end.');
    expect(noDashes('a &mdash; b &ndash; c')).toBe('a, b, c');
  });

  it('keeps ordinary hyphens and leaves text without dashes alone', () => {
    const s = 'A two-ticket, first-come request: 4 seats, $150 each.';
    expect(noDashes(s)).toBe(s);
  });

  it('no customer email carries an em or en dash, even from a staff signature or an event name', () => {
    const ctx = { appUrl: 'https://ticketguy.now', postalAddress: null };
    for (const [name, vars] of [
      ['acknowledgment', { eventLabel: 'Kings – Warriors at Crypto.com Arena, Los Angeles, Thu, Oct 1, 7:00 PM PDT', knownFacts: ['5 tickets'] }],
      ['holding', {}],
      ['event_alert', { kind: 'on_sale', what: 'Hamilton — Touring', seller: 'Ticketmaster', events: [{ title: 'Hamilton — Touring', when: 'Oct 3', venue: 'Pantages', url: null }] }],
      ['raw', { text: 'Buy now — prices $80–$120.\n\n— Ticket Guy', html: '<p>Buy now — prices $80–$120.</p><p>— Ticket Guy</p>' }],
    ] as const) {
      const r = renderTemplate(name, vars as Record<string, unknown>, { ...ctx, signature: 'full' });
      expect(r.text, name).not.toMatch(/[—–]/);
      expect(r.html, name).not.toMatch(/[—–]|&[mn]dash;/);
    }
  });
});
