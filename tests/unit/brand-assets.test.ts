import { describe, expect, it } from 'vitest';
import { categoryLabel, chooseArt, textOn, venueKeys, type BrandAsset } from '@/lib/brand/assets';
import { bestImage } from '@/lib/sources/adapters';

const asset = (a: Partial<BrandAsset> & Pick<BrandAsset, 'kind' | 'key' | 'name'>): BrandAsset => ({
  shortName: null, league: null, imageUrl: null, imageKind: null, imageWidth: null, imageHeight: null, primaryColor: null, secondaryColor: null, rights: 'unreviewed', ...a,
});
const rangers = asset({ kind: 'team', key: 'new-york-rangers', name: 'New York Rangers', shortName: 'NYR', primaryColor: '#0038A8', imageUrl: 'https://cdn.example/nyr.png', imageKind: 'logo' });
const devils = asset({ kind: 'team', key: 'new-jersey-devils', name: 'New Jersey Devils', shortName: 'NJD', primaryColor: '#CE1126', imageUrl: 'https://cdn.example/nj.png', imageKind: 'logo', rights: 'licensed' });
const game = { category: 'nhl', primary: { kind: 'team', slug: 'new-york-rangers', name: 'New York Rangers' }, opponent: { kind: 'team', slug: 'new-jersey-devils', name: 'New Jersey Devils' }, venueKeys: [] };
const opts = { mode: 'send' as const, appUrl: 'https://ticketguy.now' };

describe('the ticket brief artwork', () => {
  it('a game is its two teams in their colours, the customer’s team first', () => {
    const art = chooseArt([rangers, devils], game, opts);
    expect(art).toMatchObject({ kind: 'matchup', left: { shortName: 'NYR', color: '#0038A8', textColor: '#ffffff' }, right: { shortName: 'NJD', color: '#CE1126' } });
  });

  it('an unreviewed logo is left out of a sent email but shown in a preview; a licensed one is used', () => {
    const sent = chooseArt([rangers, devils], game, opts);
    expect(sent?.kind === 'matchup' && sent.left.logoUrl).toBeNull();
    expect(sent?.kind === 'matchup' && sent.right?.logoUrl).toBe('https://cdn.example/nj.png');
    const preview = chooseArt([rangers, devils], game, { ...opts, mode: 'preview' });
    expect(preview?.kind === 'matchup' && preview.left.logoUrl).toBe('https://cdn.example/nyr.png');
  });

  it('one known team still makes a banner; with no colours for either there is none', () => {
    expect(chooseArt([devils], game, opts)).toMatchObject({ kind: 'matchup', left: { shortName: 'NJD' }, right: null });
    expect(chooseArt([], game, opts)).toBeNull();
  });

  it('a show uses its own image, then the venue’s, then its colours, then our concert artwork', () => {
    const show = { category: 'concert', primary: { kind: 'performer', slug: 'dua-lipa', name: 'Dua Lipa' }, opponent: null, venueKeys: ['ticketmaster:KovZpZA7AAEA'] };
    const own = asset({ kind: 'performer', key: 'dua-lipa', name: 'Dua Lipa', imageUrl: 'https://img.example/dua.jpg', imageKind: 'photo', rights: 'provider_terms' });
    const msg = asset({ kind: 'venue', key: 'ticketmaster:KovZpZA7AAEA', name: 'Madison Square Garden', imageUrl: 'https://img.example/msg.jpg', imageKind: 'photo', rights: 'licensed' });
    expect(chooseArt([own, msg], show, opts)).toEqual({ kind: 'image', url: 'https://img.example/dua.jpg' });
    expect(chooseArt([msg], show, opts)).toEqual({ kind: 'image', url: 'https://img.example/msg.jpg' });
    expect(chooseArt([], show, opts)).toEqual({ kind: 'image', url: 'https://ticketguy.now/email/concert-artwork.jpg' });
    // A sent email needs an absolute https image: from a local http app there is no artwork rather than a broken one.
    expect(chooseArt([], show, { mode: 'send', appUrl: 'http://localhost:3000' })).toBeNull();
    const wicked = asset({ kind: 'production', key: 'wicked', name: 'Wicked', primaryColor: '#0B3B2E', secondaryColor: '#7BC043' });
    expect(chooseArt([wicked], { category: 'broadway', primary: { kind: 'production', slug: 'wicked', name: 'Wicked' }, opponent: null, venueKeys: [] }, opts)).toEqual({ kind: 'band', color: '#0B3B2E', accent: '#7BC043', textColor: '#ffffff', label: 'Wicked' });
  });

  it('labels, text colour and venue keys', () => {
    expect(categoryLabel('nhl')).toBe('NHL');
    expect(categoryLabel('broadway')).toBe('Broadway');
    expect(categoryLabel('las_vegas')).toBe('Event');
    expect(textOn('#6ECEB2')).toBe('#142438');
    expect(textOn('#0C2340')).toBe('#ffffff');
    expect(venueKeys({ ticketmaster: 'KovZpZA7AAEA' })).toEqual(['ticketmaster:KovZpZA7AAEA']);
  });
});

describe('the provider image kept for the brief', () => {
  it('is the widest landscape image up to 1200px that isn’t the generic stand-in', () => {
    expect(bestImage([
      { ratio: '16_9', url: 'https://s1.ticketm.net/a_TABLET_LANDSCAPE_LARGE_16_9.jpg', width: 2048, height: 1152, fallback: false },
      { ratio: '16_9', url: 'https://s1.ticketm.net/a_RETINA_LANDSCAPE_16_9.jpg', width: 1136, height: 639, fallback: false },
      { ratio: '3_2', url: 'https://s1.ticketm.net/a_ARTIST_PAGE_3_2.jpg', width: 305, height: 203, fallback: false },
      { ratio: '16_9', url: 'https://s1.ticketm.net/generic.jpg', width: 1024, height: 576, fallback: true },
    ])).toEqual({ url: 'https://s1.ticketm.net/a_RETINA_LANDSCAPE_16_9.jpg', width: 1136, height: 639 });
    expect(bestImage([{ ratio: '16_9', url: 'http://insecure.example/a.jpg', width: 1024, height: 576 }])).toBeNull();
    expect(bestImage(undefined)).toBeNull();
  });
});
