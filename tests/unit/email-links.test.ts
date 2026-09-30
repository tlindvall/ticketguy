import { describe, expect, it } from 'vitest';
import { AFFILIATE_DISCLOSURE, exploreLink, sellerLink } from '@/lib/email/links';
import { attractionLinks } from '@/lib/sources/adapters';
import { choosePicks, genreFitScore, pickReason } from '@/lib/domain/browse';
import { renderTemplate } from '@/lib/email/templates';
import { shortWhen } from '@/lib/intake/pipeline';

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

  it('says why it fits in a few words the date line does not already say', () => {
    expect(pickReason({ name: 'Big Thief', category: 'concert', genre: 'rock / indie rock', isHome: null })).toBe('Indie rock.');
    expect(pickReason({ name: 'New York Knicks vs. Boston Celtics', category: 'nba', genre: 'basketball / nba', isHome: true })).toBe('Home game against the Boston Celtics.');
    expect(pickReason({ name: 'Somebody', category: 'concert', genre: null, isHome: null })).toBeNull();
  });
});

describe('the emails', () => {
  const ctx = { appUrl: 'https://ticketguy.now', postalAddress: null };
  const pick = { line: 'Sat, Oct 3: Big Thief at Brooklyn Steel', title: 'Big Thief', reason: 'Indie rock.', eventUrl: 'https://www.ticketmaster.com/e/1', links: [{ label: 'Listen', url: 'https://open.spotify.com/a' }, { label: 'Tickets', url: 'https://www.ticketmaster.com/e/1' }] };

  it('a discovery email is picks with why and two links, and the disclosure only when a link pays us', () => {
    const plain = renderTemplate('browse_options', { headline: 'Rock and indie in Brooklyn, Oct 1 to 7. Here are my two picks:', options: [pick.line], picks: [pick], moreCount: 0 }, ctx);
    expect(plain.text).toContain('• Sat, Oct 3: Big Thief at Brooklyn Steel. Indie rock.\n  Listen: https://open.spotify.com/a\n  Tickets: https://www.ticketmaster.com/e/1');
    // Inline links in an ordinary list: the title links to its page, then "Listen · Tickets". No cards or buttons.
    expect(plain.html).toContain('<li style="margin:0 0 10px;"><strong>Sat, Oct 3</strong>: <a href="https://www.ticketmaster.com/e/1"');
    expect(plain.html).toContain('>Big Thief</a> at Brooklyn Steel. Indie rock. <a href="https://open.spotify.com/a"');
    expect(plain.html).toContain('>Listen</a> · <a href="https://www.ticketmaster.com/e/1"');
    expect(plain.html).not.toMatch(/border-radius|display:inline-block|<div style="margin:0 0 14px;padding/);
    expect(plain.text).not.toContain(AFFILIATE_DISCLOSURE);
    const paid = renderTemplate('browse_options', { headline: 'x', options: [pick.line], picks: [pick], affiliate: true, moreCount: 0 }, ctx);
    expect(paid.text).toContain(AFFILIATE_DISCLOSURE);
  });

  it('a buying email is one recommendation and a direct link to buy, written as a sentence', () => {
    const r = renderTemplate('official_sale', { eventLabel: 'x', eventTitle: 'Big Thief', eventWhen: 'Sat, Oct 3 at 8pm', venueName: 'Brooklyn Steel', seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/e/1', eventUrl: 'https://www.ticketmaster.com/e/1', quantity: 2 }, ctx);
    expect(r.text).toContain("Big Thief (Sat, Oct 3 at 8pm at Brooklyn Steel) is still on general sale on Ticketmaster, and that's where I'd buy your 2 tickets.");
    expect(r.text).toContain('Buy tickets on Ticketmaster: https://www.ticketmaster.com/e/1');
    expect(r.html).toContain('>Ticketmaster</a>, and that');
    expect(r.html).not.toMatch(/border-radius|display:inline-block/);
    const body = r.text.split('\n\nTicket Guy')[0]!; // before the sign-off
    expect(body).not.toContain('ticketguy.now');
  });
});

describe('dates the way a person writes them', () => {
  it('says "Sun, Oct 11 at 1pm", or just the day when the time is not set', () => {
    expect(shortWhen(new Date('2026-10-11T17:00:00Z'), 'America/New_York', false)).toBe('Sun, Oct 11 at 1pm');
    expect(shortWhen(new Date('2026-10-11T23:30:00Z'), 'America/New_York', false)).toBe('Sun, Oct 11 at 7:30pm');
    expect(shortWhen(new Date('2026-10-11T16:00:00Z'), 'America/New_York', true)).toBe('Sun, Oct 11');
  });
});
