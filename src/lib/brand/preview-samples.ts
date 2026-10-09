import { briefCard, briefDollars, briefEvidence, briefTop, type BriefTrend, type TicketBrief } from '@/lib/email/ticket-brief';
import { sportStart } from '@/lib/advice/packet';
import { categoryLabel } from '@/lib/domain/event-noun';
import { loadBriefArtwork, sportFor, type ArtSubject } from '@/lib/brand/assets';
import type { DbOrTx } from '@/lib/db';

/**
 * Made-up price leads for the ticket brief preview (/preview/ticket-brief): the live card (email/ticket-brief.ts) and
 * the real artwork lookup, one per banner template. Nothing here is a listing or a price anyone saw; it is never sent.
 */
type Sample = { id: string; title: string; subject: ArtSubject; name: string; where: string; when: string; seat: string; total: string; party: string; basis: string };

/** One made-up rising series, on the first sample, so the price-movement module can be seen. */
const SAMPLE_TREND: BriefTrend = {
  direction: 'up',
  rows: [
    { label: '3 days ago', cents: 14200 },
    { label: 'Yesterday', cents: 15840 },
    { label: 'Now', cents: 16938 },
  ],
  basis: 'The cheapest listed pair, before fees, from StubHub and Vivid Seats.',
};

const team = (slug: string, name: string) => ({ kind: 'team', slug, name });
const SAMPLES: Sample[] = [
  { id: 'hockey', title: 'Hockey', subject: { category: 'nhl', primary: team('new-york-rangers', 'New York Rangers'), opponent: team('new-york-islanders', 'New York Islanders'), venueKeys: [] }, name: 'New York Rangers vs. New York Islanders', where: 'Madison Square Garden, New York', when: 'Tonight at 7:30 p.m.', seat: 'Section 415 · Row 4', total: 'About $220', party: 'for two', basis: '$169.38 before fees ($84.69 each). Includes a 30% fee allowance.' },
  { id: 'basketball', title: 'Basketball', subject: { category: 'nba', primary: team('new-york-knicks', 'New York Knicks'), opponent: team('boston-celtics', 'Boston Celtics'), venueKeys: [] }, name: 'New York Knicks vs. Boston Celtics', where: 'Madison Square Garden, New York', when: 'Friday, October 23, at 7:30 p.m.', seat: 'Section 204 · Row 12', total: 'About $1,180', party: 'for all four', basis: '$908 before fees ($227 each). Includes a 30% fee allowance.' },
  { id: 'baseball', title: 'Baseball', subject: { category: 'mlb', primary: team('new-york-yankees', 'New York Yankees'), opponent: team('boston-red-sox', 'Boston Red Sox'), venueKeys: [] }, name: 'New York Yankees vs. Boston Red Sox', where: 'Yankee Stadium, Bronx', when: 'Saturday, April 11, at 1:05 p.m.', seat: 'Section 214B · Row 9', total: 'About $186', party: 'for two', basis: '$143 before fees ($71.50 each). Includes a 30% fee allowance.' },
  { id: 'football', title: 'Football', subject: { category: 'nfl', primary: team('new-york-giants', 'New York Giants'), opponent: team('philadelphia-eagles', 'Philadelphia Eagles'), venueKeys: [] }, name: 'New York Giants vs. Philadelphia Eagles', where: 'MetLife Stadium, East Rutherford', when: 'Sunday, November 22, at 1 p.m.', seat: 'Section 312 · Row 18', total: 'About $412', party: 'for two', basis: '$317 before fees ($158.50 each). Includes a 30% fee allowance.' },
  { id: 'soccer', title: 'Soccer', subject: { category: 'soccer', primary: team('new-york-city-fc', 'New York City FC'), opponent: team('new-york-red-bulls', 'New York Red Bulls'), venueKeys: [] }, name: 'New York City FC vs. New York Red Bulls', where: 'Yankee Stadium, Bronx', when: 'Saturday, October 17, at 7:30 p.m.', seat: 'Section 133 · Row 20', total: 'About $96', party: 'for two', basis: '$74 before fees ($37 each). Includes a 30% fee allowance.' },
  { id: 'college', title: 'College football (a provider name with "Football" on the end)', subject: { category: 'ncaa_regular', genre: 'Football', primary: team('michigan-wolverines-football', 'Michigan Wolverines Football'), opponent: team('ohio-state-buckeyes-football', 'Ohio State Buckeyes Football'), venueKeys: [] }, name: 'Michigan Wolverines vs. Ohio State Buckeyes', where: 'Michigan Stadium, Ann Arbor', when: 'Saturday, November 28, at noon', seat: 'Section 24 · Row 61', total: 'About $640', party: 'for two', basis: '$492 before fees ($246 each). Includes a 30% fee allowance.' },
  { id: 'wnba', title: 'WNBA', subject: { category: 'wnba', primary: team('new-york-liberty', 'New York Liberty'), opponent: team('las-vegas-aces', 'Las Vegas Aces'), venueKeys: [] }, name: 'New York Liberty vs. Las Vegas Aces', where: 'Barclays Center, Brooklyn', when: 'Thursday, June 11, at 7:30 p.m.', seat: 'Section 22 · Row 7', total: 'About $158', party: 'for two', basis: '$122 before fees ($61 each). Includes a 30% fee allowance.' },
  { id: 'concert', title: 'Concert (our artwork until a performer image is approved)', subject: { category: 'concert', primary: { kind: 'performer', slug: 'dua-lipa', name: 'Dua Lipa' }, opponent: null, venueKeys: [] }, name: 'Dua Lipa', where: 'Barclays Center, Brooklyn', when: 'Thursday, November 19, at 8 p.m.', seat: 'Section 106 · Row 9', total: 'About $386', party: 'for two', basis: '$297 before fees ($148.50 each). Includes a 30% fee allowance.' },
  { id: 'theater', title: 'Broadway (a stage in the show’s colours)', subject: { category: 'broadway', primary: { kind: 'production', slug: 'wicked', name: 'Wicked' }, opponent: null, venueKeys: [] }, name: 'Wicked', where: 'Gershwin Theatre, New York', when: 'Sunday, November 8, at 2 p.m.', seat: 'Rear Mezzanine · Row C', total: 'About $402', party: 'for all three', basis: '$309 before fees ($103 each). Includes a 30% fee allowance.' },
];

const partySize = (p: string) => ({ 'for two': 2, 'for all three': 3, 'for all four': 4 } as Record<string, number>)[p] ?? 1;

export async function renderPreviewSamples(db: DbOrTx): Promise<Array<{ id: string; title: string; artwork: string | null; html: string; text: string }>> {
  const out = [];
  for (const [i, s] of SAMPLES.entries()) {
    const artwork = await loadBriefArtwork(db, s.subject);
    const brief: TicketBrief = {
      kind: 'price_lead',
      // The packet's own wording (picksAnswer), so the preview shows what a customer reads.
      headline: `${s.total} ${s.party}, with fees.`,
      rationale: `That’s the lowest listing I can see: ${s.seat.replace(' · ', ', ')}.`,
      points: i === 0 ? ['Prices are rising. The cheapest listed pair is up 19% since three days ago. Waiting has cost money so far.'] : [],
      category: categoryLabel(s.subject.category),
      event: { name: s.name, where: s.where, when: sportStart(s.when, sportFor(s.subject.category, s.subject.genre)) },
      artworkUrl: artwork,
      seatLine: s.seat,
      total: s.total,
      forWhom: s.party,
      each: s.party === 'for one' ? null : `About ${briefDollars(Math.round(Number(s.total.replace(/[^\d]/g, '')) * 100 / partySize(s.party)))} a ticket, with fees`,
      basis: [s.basis],
      facts: [['Seats together', 'Not confirmed'], ['Listed on', 'StubHub']],
      action: { label: 'Search StubHub for these seats', url: 'https://www.stubhub.com/' },
      secondary: null,
      actionNote: 'From resale data refreshed in the last couple of hours. Not held; availability can change.',
      affiliate: false,
      alternatives: [],
      // One made-up series on the first sample, so the price-movement module can be seen.
      trend: i === 0 ? SAMPLE_TREND : null,
      after: [],
      evidenceNote: 'Preview: made-up prices, never sent.',
    };
    // A relative artwork path works in the preview, which is served by this app; the live card takes https only.
    const top = briefTop(brief);
    const card = briefCard({ ...brief, artworkUrl: artwork?.startsWith('/') ? `https://preview.invalid${artwork}` : artwork }, { trend: false });
    const ev = briefEvidence(brief);
    const html = [`<p style="margin:0 0 16px;font-size:16px;line-height:25px;">Hey,</p>`, ...top.html, ...card.html, ev.html].join('\n').replaceAll('https://preview.invalid/', '/');
    out.push({ id: s.id, title: s.title, artwork, html, text: ['Hey,', ...top.text, ...card.text, ev.text].join('\n\n') });
  }
  return out;
}
