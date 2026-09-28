import { describe, expect, it } from 'vitest';
import { AFFILIATE_DISCLOSURE, exploreLink, sellerLink } from '@/lib/email/links';
import { attractionLinks } from '@/lib/sources/adapters';
import { choosePicks, genreFitScore, pickReason } from '@/lib/domain/browse';
import { renderTemplate } from '@/lib/email/templates';

describe('links go where the customer wants to go', () => {
  it('takes only the https links the provider lists, one per kind', () => {
    const links = attractionLinks({ externalLinks: { spotify: [{ url: 'https://open.spotify.com/artist/abc' }], youtube: [{ url: 'http://youtube.com/insecure' }, { url: 'https://www.youtube.com/@band' }], homepage: [{ url: 'https://band.example' }], twitter: [{ url: 'https://x.com/band' }] } });
    expect(links).toEqual({ listen: 'https://open.spotify.com/artist/abc', watch: 'https://www.youtube.com/@band', official: 'https://band.example' });
    expect(attractionLinks({})).toEqual({});
  });

  it('offers something to listen to for an act, the team page for a team, and nothing it does not have', () => {
    expect(exploreLink({ listen: 'https://open.spotify.com/a', official: 'https://band.example' }, 'performer')).toEqual({ label: 'Listen', url: 'https://open.spotify.com/a' });
    expect(exploreLink({ watch: 'https://www.youtube.com/@b' }, 'performer')).toEqual({ label: 'Watch', url: 'https://www.youtube.com/@b' });
    expect(exploreLink({ official: 'https://www.nba.com/knicks', listen: 'https://open.spotify.com/x' }, 'team')).toEqual({ label: 'Team page', url: 'https://www.nba.com/knicks' });
    expect(exploreLink({}, 'performer')).toBeNull();
  });

  it('wraps the seller link only when that seller has an affiliate format', () => {
    const tpl = { Ticketmaster: 'https://aff.example/c/1?u={url}' };
    expect(sellerLink('https://www.ticketmaster.com/e/1', 'Ticketmaster', tpl)).toEqual({ url: 'https://aff.example/c/1?u=https%3A%2F%2Fwww.ticketmaster.com%2Fe%2F1', affiliate: true });
    expect(sellerLink('https://www.ticketweb.com/e/1', 'TicketWeb', tpl)).toEqual({ url: 'https://www.ticketweb.com/e/1', affiliate: false });
  });
});

describe('picks', () => {
  it('prefers the best fit, spreads across days, and lists them in date order', () => {
    const items = [
      { id: 'a', day: '2026-10-01', score: 0 },
      { id: 'b', day: '2026-10-01', score: 1 },
      { id: 'c', day: '2026-10-01', score: 0 },
      { id: 'd', day: '2026-10-02', score: 0 },
      { id: 'e', day: '2026-10-03', score: 1 },
    ];
    expect(choosePicks(items, 3, (x) => x).map((x) => x.id)).toEqual(['b', 'd', 'e']);
  });

  it('scores a sub-genre that names what was asked for', () => {
    expect(genreFitScore('rock / indie rock', 'I like indie rock and roll')).toBe(1);
    expect(genreFitScore('rock / hard rock', 'indie')).toBe(0);
    expect(genreFitScore(null, 'indie')).toBe(0);
  });

  it('says why it fits from facts on file only', () => {
    const v = { name: 'Brooklyn Steel', timezone: 'America/New_York' };
    expect(pickReason({ name: 'Big Thief', category: 'concert', genre: 'rock / indie rock', isHome: null, localStartAt: new Date('2026-10-04T00:30:00Z'), subtype: null }, v)).toBe('Indie rock on a Saturday night at Brooklyn Steel.');
    expect(pickReason({ name: 'New York Knicks vs. Boston Celtics', category: 'nba', genre: 'basketball / nba', isHome: true, localStartAt: new Date('2026-10-24T23:30:00Z'), subtype: null }, { name: 'MSG', timezone: 'America/New_York' })).toBe('A home game against the Boston Celtics on a Saturday night.');
  });
});

describe('the emails', () => {
  const ctx = { appUrl: 'https://ticketguy.now', postalAddress: null };
  const pick = { line: 'Sat, Oct 3 — Big Thief at Brooklyn Steel', title: 'Big Thief', reason: 'Indie rock on a Saturday night at Brooklyn Steel.', eventUrl: 'https://www.ticketmaster.com/e/1', links: [{ label: 'Listen', url: 'https://open.spotify.com/a' }, { label: 'Event & tickets', url: 'https://www.ticketmaster.com/e/1' }] };

  it('a discovery email is picks with why and two links, and the disclosure only when a link pays us', () => {
    const plain = renderTemplate('browse_options', { headline: 'Rock and indie in Brooklyn, Oct 1–7 — here are my two picks:', options: [pick.line], picks: [pick], moreCount: 0 }, ctx);
    expect(plain.text).toContain('• Sat, Oct 3 — Big Thief at Brooklyn Steel\n  Indie rock on a Saturday night at Brooklyn Steel.\n  Listen: https://open.spotify.com/a\n  Event & tickets: https://www.ticketmaster.com/e/1');
    expect(plain.html).toContain('href="https://www.ticketmaster.com/e/1"');
    expect(plain.text).not.toContain(AFFILIATE_DISCLOSURE);
    const paid = renderTemplate('browse_options', { headline: 'x', options: [pick.line], picks: [pick], affiliate: true, moreCount: 0 }, ctx);
    expect(paid.text).toContain(AFFILIATE_DISCLOSURE);
  });

  it('a buying email is one recommendation and a direct link to buy, never a link to our own site for it', () => {
    const r = renderTemplate('official_sale', { eventLabel: 'Big Thief — Brooklyn Steel — Sat, Oct 3', eventTitle: 'Big Thief', seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/e/1', eventUrl: 'https://www.ticketmaster.com/e/1', quantity: 2, explore: { label: 'Listen', url: 'https://open.spotify.com/a' } }, ctx);
    expect(r.text).toContain("that's where I'd buy your 2 tickets.");
    expect(r.text).toContain('Buy tickets on Ticketmaster: https://www.ticketmaster.com/e/1');
    expect(r.text).toContain('Listen: https://open.spotify.com/a');
    expect(r.html).toContain('>Buy tickets on Ticketmaster</a>');
    const body = r.text.split('\n\n—')[0]!; // before the sign-off
    expect(body).not.toContain('ticketguy.now');
  });
});
