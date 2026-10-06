import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { chooseArtwork, sportFor, teamKeys, venueKeys, type BrandAsset } from '@/lib/brand/assets';
import { clash, renderBanner } from '@/lib/brand/banner';
import { TEAM_BRANDS } from '@/lib/brand/teams';
import { sportStart } from '@/lib/advice/packet';
import { bestImage } from '@/lib/sources/adapters';

const asset = (a: Partial<BrandAsset> & Pick<BrandAsset, 'kind' | 'key' | 'name'>): BrandAsset => ({
  shortName: null, league: null, sport: null, aliases: [], imageUrl: null, imageKind: null, primaryColor: null, secondaryColor: null, rights: 'unreviewed', ...a,
});
const rangers = asset({ kind: 'team', key: 'new-york-rangers', name: 'New York Rangers', primaryColor: '#0056AE', imageUrl: '/brand/logos/nhl/new-york-rangers.png', imageKind: 'logo', rights: 'approved' });
const islanders = asset({ kind: 'team', key: 'new-york-islanders', name: 'New York Islanders', primaryColor: '#00539B', imageUrl: '/brand/logos/nhl/new-york-islanders.png', imageKind: 'logo', rights: 'approved' });
const team = (slug: string) => ({ kind: 'team', slug, name: slug });

describe('the ticket brief artwork', () => {
  it('a game is its sport’s banner of both teams, the customer’s team first', () => {
    expect(chooseArtwork([rangers, islanders], { category: 'nhl', primary: team('new-york-rangers'), opponent: team('new-york-islanders'), venueKeys: [] })).toBe('/brief-art/v1/hockey/new-york-rangers/new-york-islanders.jpg');
    expect(chooseArtwork([rangers, islanders], { category: 'nhl', primary: team('new-york-islanders'), opponent: team('new-york-rangers'), venueKeys: [] })).toBe('/brief-art/v1/hockey/new-york-islanders/new-york-rangers.jpg');
  });

  it('one known team is a banner of its own; no known team is no artwork', () => {
    expect(chooseArtwork([islanders], { category: 'nhl', primary: team('some-unknown-team'), opponent: team('new-york-islanders'), venueKeys: [] })).toBe('/brief-art/v1/hockey/new-york-islanders/_.jpg');
    expect(chooseArtwork([], { category: 'nhl', primary: team('a'), opponent: team('b'), venueKeys: [] })).toBeNull();
  });

  it('a provider’s other name for a team, or a school’s sport on the end, still finds it', () => {
    const clippers = asset({ kind: 'team', key: 'la-clippers', name: 'LA Clippers', aliases: ['los-angeles-clippers'], primaryColor: '#12173F' });
    const michigan = asset({ kind: 'team', key: 'michigan-wolverines', name: 'Michigan Wolverines', primaryColor: '#00274C' });
    expect(chooseArtwork([clippers], { category: 'nba', primary: team('los-angeles-clippers'), opponent: null, venueKeys: [] })).toBe('/brief-art/v1/basketball/la-clippers/_.jpg');
    expect(chooseArtwork([michigan], { category: 'ncaa_regular', genre: 'Football', primary: team('michigan-wolverines-football'), opponent: null, venueKeys: [] })).toBe('/brief-art/v1/football/michigan-wolverines/_.jpg');
    expect(teamKeys('st-john-s-red-storm-mens-basketball')).toEqual(['st-john-s-red-storm-mens-basketball', 'st-john-s-red-storm']);
  });

  it('a show uses its own approved image, then the venue’s, then a stage in its colours, then our concert art', () => {
    const show = { category: 'concert', primary: { kind: 'performer', slug: 'dua-lipa', name: 'Dua Lipa' }, opponent: null, venueKeys: ['ticketmaster:KovZpZA7AAEA'] };
    const own = asset({ kind: 'performer', key: 'dua-lipa', name: 'Dua Lipa', imageUrl: 'https://img.example/dua.jpg', imageKind: 'photo', rights: 'provider_terms' });
    const msg = asset({ kind: 'venue', key: 'ticketmaster:KovZpZA7AAEA', name: 'Madison Square Garden', imageUrl: 'https://img.example/msg.jpg', imageKind: 'photo', rights: 'licensed' });
    expect(chooseArtwork([own, msg], show)).toBe('https://img.example/dua.jpg');
    expect(chooseArtwork([{ ...own, rights: 'unreviewed' }, msg], show)).toBe('https://img.example/msg.jpg');
    expect(chooseArtwork([], show)).toBe('/email/ticket-brief-concert.jpg');
    const wicked = asset({ kind: 'production', key: 'wicked', name: 'Wicked', primaryColor: '#0B3B2E' });
    expect(chooseArtwork([wicked], { category: 'broadway', primary: { kind: 'production', slug: 'wicked', name: 'Wicked' }, opponent: null, venueKeys: [] })).toBe('/brief-art/v1/theater/wicked/_.jpg');
    expect(chooseArtwork([], { category: 'comedy', primary: null, opponent: null, venueKeys: [] })).toBeNull();
  });

  it('the sport from the league, else from the provider’s genre; never guessed', () => {
    expect(sportFor('nfl', null)).toBe('football');
    expect(sportFor('wnba', null)).toBe('basketball');
    expect(sportFor('ncaa_regular', 'Football')).toBe('football');
    expect(sportFor('ncaa_regular', 'Soccer')).toBe('soccer');
    expect(sportFor('ncaa_regular', null)).toBeNull();
    expect(sportFor('concert', 'Rock')).toBeNull();
    expect(venueKeys({ ticketmaster: 'KovZpZA7AAEA' })).toEqual(['ticketmaster:KovZpZA7AAEA']);
  });

  it('a game’s start is said the sport’s way on the card', () => {
    expect(sportStart('Tonight at 7:30 p.m.', 'hockey')).toBe('Tonight · puck drop 7:30 p.m.');
    expect(sportStart('Saturday, November 14, at 7 p.m.', 'basketball')).toBe('Saturday, November 14 · tip-off 7 p.m.');
    expect(sportStart('Saturday, April 11, at 1:05 p.m.', 'baseball')).toBe('Saturday, April 11 · first pitch 1:05 p.m.');
    expect(sportStart('Tonight at 8 p.m.', null)).toBe('Tonight at 8 p.m.');
  });
});

describe('the team file', () => {
  it('has every major league, each team once, with colours and a hosted logo', () => {
    const count = (l: string) => TEAM_BRANDS.filter((t) => t.league === l).length;
    expect([count('NFL'), count('NBA'), count('NHL'), count('MLB'), count('MLS'), count('NWSL'), count('WNBA')]).toEqual([32, 30, 32, 30, 30, 16, 15]);
    expect(count('NCAA')).toBeGreaterThanOrEqual(75);
    const slugs = TEAM_BRANDS.flatMap((t) => [t.slug, ...t.aliases]);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const t of TEAM_BRANDS) {
      expect(t.primaryColor).toMatch(/^#[0-9A-F]{6}$/);
      expect(t.logo).toMatch(/^\/brand\/logos\/[a-z]+\/[a-z0-9-]+\.png$/);
    }
  });
});

describe('the banner', () => {
  it('is a 1200×400 image for every template, with one team or two', async () => {
    const r = { primaryColor: '#0056AE', logoPath: '/brand/logos/nhl/new-york-rangers.png' };
    const i = { primaryColor: '#00539B', logoPath: '/brand/logos/nhl/new-york-islanders.png' };
    for (const template of ['hockey', 'basketball', 'baseball', 'football', 'soccer', 'theater'] as const) {
      const meta = await sharp(await renderBanner(template, r, i)).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1200, 400]);
    }
    expect((await sharp(await renderBanner('hockey', { primaryColor: '#000000', logoPath: '/../../etc/passwd' }, null)).metadata()).width).toBe(1200);
  });
});

describe('two teams in one banner', () => {
  it('the opponent takes its second colour only when its first would read as ours', () => {
    expect(clash('#0056AE', '#00529B')).toBe(true); // Rangers, Islanders: both blue
    expect(clash('#132448', '#002D72')).toBe(true); // Yankees, Mets: both navy
    expect(clash('#003C7F', '#06424D')).toBe(false); // Giants navy, Eagles midnight green
    expect(clash('#1D428A', '#000000')).toBe(false); // Knicks, Nets
  });
});

describe('the provider image kept for the brief', () => {
  it('is the widest landscape image up to 1200px that isn’t the generic stand-in', () => {
    expect(bestImage([
      { ratio: '16_9', url: 'https://s1.ticketm.net/a_TABLET_LANDSCAPE_LARGE_16_9.jpg', width: 2048, height: 1152, fallback: false },
      { ratio: '16_9', url: 'https://s1.ticketm.net/a_RETINA_LANDSCAPE_16_9.jpg', width: 1136, height: 639, fallback: false },
      { ratio: '16_9', url: 'https://s1.ticketm.net/generic.jpg', width: 1024, height: 576, fallback: true },
    ])).toEqual({ url: 'https://s1.ticketm.net/a_RETINA_LANDSCAPE_16_9.jpg', width: 1136, height: 639 });
    expect(bestImage([{ ratio: '16_9', url: 'http://insecure.example/a.jpg', width: 1024, height: 576 }])).toBeNull();
  });
});
