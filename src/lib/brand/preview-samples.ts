import type { AdvicePacket, ClaimRecord } from '@/lib/advice/packet';
import { validateAndRender, type BriefContext } from '@/lib/advice/renderer';
import { categoryLabel, loadBriefArt, type ArtMode, type ArtSubject } from '@/lib/brand/assets';
import type { DbOrTx } from '@/lib/db';

/**
 * Made-up recommendations for the ticket brief preview (/preview/ticket-brief): the real renderer and the real
 * artwork lookup, fed an invented pick. Nothing here is a listing or a price anyone saw; it is never sent.
 */
type Sample = { id: string; title: string; subject: ArtSubject; eventTitle: string; details: string; seat: string; price: string; notes: string[]; head: string; others: string[] };

const SAMPLES: Sample[] = [
  {
    id: 'rangers', title: 'A game, both teams known',
    subject: { category: 'nhl', primary: { kind: 'team', slug: 'new-york-rangers', name: 'New York Rangers' }, opponent: { kind: 'team', slug: 'new-jersey-devils', name: 'New Jersey Devils' }, venueKeys: [] },
    eventTitle: 'New York Rangers vs. New Jersey Devils', details: 'Madison Square Garden, New York · Saturday, November 14, at 7 p.m. · 2 tickets · up to $500 in total',
    head: 'I’d buy Section 217, Row 6: two seats together for about $412 with fees (estimated), $88 under your $500.',
    seat: 'Section 217 · Row 6 on StubHub', price: 'About $412 for two',
    notes: ['$317 for two before fees ($158.50 each), plus a 30% fee allowance.', 'Right now 14 listings have two together, from $139 to $410 a ticket before fees.', 'Not checked yet: that it’s still listed and the seats are together, from resale data refreshed in the last couple of hours.'],
    others: ['Section 224 · Row 3 on Vivid Seats: $330 for two before fees.'],
  },
  {
    id: 'knicks', title: 'A game, NBA',
    subject: { category: 'nba', primary: { kind: 'team', slug: 'new-york-knicks', name: 'New York Knicks' }, opponent: { kind: 'team', slug: 'boston-celtics', name: 'Boston Celtics' }, venueKeys: [] },
    eventTitle: 'New York Knicks vs. Boston Celtics', details: 'Madison Square Garden, New York · Friday, October 23, at 7:30 p.m. · 4 tickets',
    head: 'I’d buy Section 204, Row 12, the cheapest four together I can see: about $1,180 for all 4 with fees (estimated).',
    seat: 'Section 204 · Row 12', price: 'About $1,180 for four',
    notes: ['$908 for four before fees ($227 each), plus a 30% fee allowance.', 'On StubHub or Vivid Seats; my data doesn’t say which, so search both.', 'Not checked yet: that it’s still listed and the seats are together, from resale data refreshed in the last couple of hours.'],
    others: [],
  },
  {
    id: 'concert', title: 'A concert, no performer image yet (our artwork)',
    subject: { category: 'concert', primary: { kind: 'performer', slug: 'dua-lipa', name: 'Dua Lipa' }, opponent: null, venueKeys: [] },
    eventTitle: 'Dua Lipa', details: 'Barclays Center, Brooklyn · Thursday, November 19, at 8 p.m. · 2 tickets',
    head: 'I’d buy Section 106, Row 9, the cheapest pair I can see: about $386 for both with fees (estimated).',
    seat: 'Section 106 · Row 9 on Vivid Seats', price: 'About $386 for two',
    notes: ['$297 for two before fees ($148.50 each), plus a 30% fee allowance.', 'Not checked yet: that it’s still listed and the seats are together, from resale data about 3 hours old.'],
    others: [],
  },
  {
    id: 'wicked', title: 'A Broadway show, its colours',
    subject: { category: 'broadway', primary: { kind: 'production', slug: 'wicked', name: 'Wicked' }, opponent: null, venueKeys: [] },
    eventTitle: 'Wicked', details: 'Gershwin Theatre, New York · Sunday, November 8, at 2 p.m. · 3 tickets',
    head: 'I’d buy Rear Mezzanine, Row C, the cheapest three together I can see: about $402 for all 3 with fees (estimated).',
    seat: 'Rear Mezzanine · Row C on StubHub', price: 'About $402 for three',
    notes: ['$309 for three before fees ($103 each), plus a 30% fee allowance.', 'Not checked yet: that it’s still listed and the seats are together, from resale data refreshed in the last couple of hours.'],
    others: [],
  },
];

function packetFor(s: Sample): AdvicePacket {
  const picks: ClaimRecord = {
    id: 'C_PICKS', kind: 'market_price', text: `${s.head}\n${s.seat}: ${s.price}, estimated.`, items: [`${s.seat}: ${s.price}, estimated.`, ...s.notes],
    card: { head: s.head, title: s.seat, price: s.price, notes: s.notes, others: s.others, after: [] },
    url: 'https://www.stubhub.com/', linkLabel: `Search StubHub for this ${s.subject.category === 'nhl' || s.subject.category === 'nba' ? 'game' : 'show'}`,
    values: {}, scope: { quantity: null, seatZone: null, feeBasis: 'listed_before_fees', observedAt: null }, evidenceIds: [], methodVersion: 'preview', limitations: ['not_a_verified_offer'], customerVisible: true,
  };
  return {
    requestId: 'preview', revision: 1, verifiedOfferObservationIds: [], basketKey: 'preview', basketVersion: 1, benchmarkRunId: null, trendRunId: null,
    historicalAdequacy: 'insufficient', trendAdequacy: 'insufficient', customerPriorities: {}, policyVersion: 'preview', decision: 'insufficient_evidence', reasonCodes: [], abstentions: [],
    claimRecords: [picks], followUps: ['Want me to narrow it down? Tell me your budget, fees included, or where you’d like to sit.'],
    headline: `${s.eventTitle} · ${s.details}`, headlineTitle: s.eventTitle, headlineDetails: s.details,
    evidenceExpiresAt: null, nextCheckpointAt: null, stopConditions: [], watchConsentReference: null, isFixture: true,
  };
}

export async function renderPreviewSamples(db: DbOrTx, mode: ArtMode, appUrl: string): Promise<Array<{ id: string; title: string; html: string; text: string }>> {
  const out = [];
  for (const s of SAMPLES) {
    const brief: BriefContext = { label: categoryLabel(s.subject.category), art: await loadBriefArt(db, s.subject, { mode, appUrl }) };
    const r = validateAndRender(packetFor(s), { decision: 'insufficient_evidence', opening: '', paragraphs: [{ claimIds: ['C_PICKS'], prose: '' }], closing: '' }, { brief });
    if (!r.ok) throw new Error(`preview sample ${s.id}: ${r.errors.join('; ')}`);
    out.push({ id: s.id, title: s.title, html: r.htmlBody, text: r.textBody });
  }
  return out;
}
