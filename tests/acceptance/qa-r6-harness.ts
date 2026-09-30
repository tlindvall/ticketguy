import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { setKillSwitch } from '@/lib/email/send-gate';
import { buildTestInbound, TEST_MODE_KEY } from '@/lib/email/test-mode';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { RecordingProvider, testEnv } from '../harness';
import replay from '../fixtures/qa-r6-cases.json';

/**
 * The TGQA-R6 API QA (30 Sep 2026, 30 scenarios, 74 turns), replayed through the same test-mode path the QA used:
 * each turn is injected as the test API injects it (a reply quotes our last email the way Gmail does), the whole
 * pipeline runs as live, and every email is recorded instead of sent. The catalog is seeded with the events the
 * QA ran into, including the traps: the Knicks' Oct 5 game in Philadelphia, a 1pm and an 8pm Hamilton, a 4pm and
 * a 7pm Kanan Gill with the link's event id on the 7pm one, and November shows that only partly fit.
 */
export const CLOCK = new Date(replay.clock);
export type Case = (typeof replay.cases)[number];

const V = {
  philly: '10000000-0000-4000-8000-0000000000c1',
  rodgers: '10000000-0000-4000-8000-0000000000c2',
  townHall: '10000000-0000-4000-8000-0000000000c3',
  gershwin: '10000000-0000-4000-8000-0000000000c4',
  bowery: '10000000-0000-4000-8000-0000000000c5',
  irving: '10000000-0000-4000-8000-0000000000c6',
  birdland: '10000000-0000-4000-8000-0000000000c7',
};
const E = {
  lightning: '20000000-0000-4000-8000-0000000000c1',
  sixers: '20000000-0000-4000-8000-0000000000c2',
  wizards: '20000000-0000-4000-8000-0000000000c3',
  nets: '20000000-0000-4000-8000-0000000000c4',
  raptors: '20000000-0000-4000-8000-0000000000c5',
  hamilton: '20000000-0000-4000-8000-0000000000c6',
  kananGill: '20000000-0000-4000-8000-0000000000c7',
  wicked: '20000000-0000-4000-8000-0000000000c8',
  indieBand: '20000000-0000-4000-8000-0000000000c9',
  popStar: '20000000-0000-4000-8000-0000000000ca',
  jazzBand: '20000000-0000-4000-8000-0000000000cb',
};
export const EV = {
  rangersTb: '30000000-0000-4000-8000-0000000000c1',
  knicksAtPhilly: '30000000-0000-4000-8000-0000000000c2',
  knicksWizards: '30000000-0000-4000-8000-0000000000c3',
  netsAway: '30000000-0000-4000-8000-0000000000c4',
  netsHome: '30000000-0000-4000-8000-0000000000c5',
  hamiltonMatinee: '30000000-0000-4000-8000-0000000000c6',
  hamiltonEvening: '30000000-0000-4000-8000-0000000000c7',
  kanan4pm: '30000000-0000-4000-8000-0000000000c8',
  kanan7pm: '30000000-0000-4000-8000-0000000000c9',
  wickedSep30: '30000000-0000-4000-8000-0000000000ca',
  wickedNov7: '30000000-0000-4000-8000-0000000000cb',
  wickedNov11: '30000000-0000-4000-8000-0000000000cc',
  wickedNov14: '30000000-0000-4000-8000-0000000000cd',
  indieNov3: '30000000-0000-4000-8000-0000000000ce',
  indieIrvingNov2: '30000000-0000-4000-8000-0000000000cf',
  popMsgNov20: '30000000-0000-4000-8000-0000000000d0',
  jazzOct1: '30000000-0000-4000-8000-0000000000d1',
  indieOct3: '30000000-0000-4000-8000-0000000000d2',
};
/** The event id the scenario-17 link carries, on the 7pm performance (checked in the QA's previous run). */
export const KANAN_7PM_TM_ID = '0300643DF03B25CE';

export async function seedR6(h: DbHandle) {
  const NY = { city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' } as const;
  await h.db.insert(t.venues).values([
    { id: V.philly, name: 'Xfinity Mobile Arena', aliases: [], city: 'Philadelphia', state: 'PA', country: 'US', timezone: 'America/New_York', latitude: 39.9012, longitude: -75.172 },
    { id: V.rodgers, name: 'Richard Rodgers Theatre', aliases: [], ...NY, latitude: 40.7593, longitude: -73.9866 },
    { id: V.townHall, name: 'Town Hall', aliases: ['The Town Hall'], ...NY, latitude: 40.7557, longitude: -73.9847 },
    { id: V.gershwin, name: 'Gershwin Theatre', aliases: [], ...NY, latitude: 40.7624, longitude: -73.9855 },
    { id: V.bowery, name: 'Bowery Ballroom', aliases: [], ...NY, latitude: 40.7204, longitude: -73.9934 },
    { id: V.irving, name: 'Irving Plaza', aliases: [], ...NY, latitude: 40.7349, longitude: -73.9882 },
    { id: V.birdland, name: 'Birdland Theater', aliases: [], ...NY, latitude: 40.7592, longitude: -73.9894 },
  ]);
  // Live has no seat sources connected: the replay doesn't either, so no fixture listings are "checked".
  await h.db.update(t.adapterConfigs).set({ enabled: false });
  await h.db.update(t.venues).set({ latitude: 40.7505, longitude: -73.9934 }).where(eq(t.venues.id, FX.venues.msg));
  await h.db.update(t.venues).set({ latitude: 40.6826, longitude: -73.9754, aliases: ['Barclays'] }).where(eq(t.venues.id, FX.venues.barclays));
  await h.db.insert(t.entities).values([
    { id: E.lightning, kind: 'team', name: 'Tampa Bay Lightning', slug: 'tampa-bay-lightning', aliases: ['Lightning'], league: 'NHL' },
    { id: E.sixers, kind: 'team', name: 'Philadelphia 76ers', slug: 'philadelphia-76ers', aliases: ['76ers', 'Sixers'], league: 'NBA' },
    { id: E.wizards, kind: 'team', name: 'Washington Wizards', slug: 'washington-wizards', aliases: ['Wizards'], league: 'NBA' },
    { id: E.nets, kind: 'team', name: 'Brooklyn Nets', slug: 'brooklyn-nets', aliases: ['Nets'], league: 'NBA', homeVenueId: FX.venues.barclays },
    { id: E.raptors, kind: 'team', name: 'Toronto Raptors', slug: 'toronto-raptors', aliases: ['Raptors'], league: 'NBA' },
    { id: E.hamilton, kind: 'artist', name: 'Hamilton', slug: 'hamilton', aliases: ['Hamilton on Broadway'] },
    { id: E.kananGill, kind: 'artist', name: 'Kanan Gill', slug: 'kanan-gill', aliases: [] },
    { id: E.wicked, kind: 'artist', name: 'Wicked', slug: 'wicked', aliases: [] },
    { id: E.indieBand, kind: 'artist', name: 'Twisted Teens', slug: 'twisted-teens', aliases: [] },
    { id: E.popStar, kind: 'artist', name: 'Arena Pop Star', slug: 'arena-pop-star', aliases: [] },
    { id: E.jazzBand, kind: 'artist', name: 'The High Society New Orleans Jazz Band', slug: 'high-society-jazz', aliases: [] },
  ]);
  const onsale = { status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-06-01T14:00:00Z'), publicSaleEndAt: null } as const;
  const game = { status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true } as const;
  await h.db.insert(t.events).values([
    { id: EV.rangersTb, name: 'New York Rangers vs. Tampa Bay Lightning', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, opponentEntityId: E.lightning, isHome: true, localStartAt: new Date('2026-10-01T23:00:00Z'), ...game },
    { id: EV.knicksAtPhilly, name: 'Preseason: New York Knicks v Philadelphia 76ers', category: 'nba', subtype: 'preseason', venueId: V.philly, primaryEntityId: FX.entities.knicks, opponentEntityId: E.sixers, isHome: false, localStartAt: new Date('2026-10-05T23:00:00Z'), ...game },
    { id: EV.knicksWizards, name: 'Preseason: New York Knicks v Washington Wizards', category: 'nba', subtype: 'preseason', venueId: FX.venues.msg, primaryEntityId: FX.entities.knicks, opponentEntityId: E.wizards, isHome: true, localStartAt: new Date('2026-10-08T23:30:00Z'), ...game },
    { id: EV.netsAway, name: 'Preseason: Brooklyn Nets v Philadelphia 76ers', category: 'nba', subtype: 'preseason', venueId: V.philly, primaryEntityId: E.nets, opponentEntityId: E.sixers, isHome: false, localStartAt: new Date('2026-10-06T23:00:00Z'), ...game },
    { id: EV.netsHome, name: 'Brooklyn Nets vs. Toronto Raptors', category: 'nba', subtype: 'preseason', venueId: FX.venues.barclays, primaryEntityId: E.nets, opponentEntityId: E.raptors, isHome: true, localStartAt: new Date('2026-10-10T23:30:00Z'), ...game },
    { id: EV.hamiltonMatinee, name: 'Hamilton (NY)', category: 'broadway', venueId: V.rodgers, primaryEntityId: E.hamilton, localStartAt: new Date('2026-10-03T17:00:00Z'), ...onsale },
    { id: EV.hamiltonEvening, name: 'Hamilton (NY)', category: 'broadway', venueId: V.rodgers, primaryEntityId: E.hamilton, localStartAt: new Date('2026-10-04T00:00:00Z'), ...onsale },
    { id: EV.kanan4pm, name: 'Kanan Gill: Not This Again', category: 'comedy', venueId: V.townHall, primaryEntityId: E.kananGill, localStartAt: new Date('2026-10-03T20:00:00Z'), ...onsale },
    { id: EV.kanan7pm, name: 'Kanan Gill: Not This Again', category: 'comedy', venueId: V.townHall, primaryEntityId: E.kananGill, localStartAt: new Date('2026-10-03T23:00:00Z'), ...onsale },
    { id: EV.wickedSep30, name: 'Wicked', category: 'broadway', genre: 'musical', venueId: V.gershwin, primaryEntityId: E.wicked, localStartAt: new Date('2026-09-30T23:00:00Z'), ...onsale },
    // November is Eastern Standard Time: 7pm is 00:00Z the next day.
    { id: EV.wickedNov7, name: 'Wicked', category: 'broadway', genre: 'musical', venueId: V.gershwin, primaryEntityId: E.wicked, localStartAt: new Date('2026-11-08T00:00:00Z'), ...onsale },
    { id: EV.wickedNov11, name: 'Wicked', category: 'broadway', genre: 'musical', venueId: V.gershwin, primaryEntityId: E.wicked, localStartAt: new Date('2026-11-12T01:00:00Z'), ...onsale },
    { id: EV.wickedNov14, name: 'Wicked', category: 'broadway', genre: 'musical', venueId: V.gershwin, primaryEntityId: E.wicked, localStartAt: new Date('2026-11-15T01:00:00Z'), ...onsale },
    { id: EV.indieNov3, name: 'Twisted Teens', category: 'concert', genre: 'rock / indie rock', venueId: V.bowery, primaryEntityId: E.indieBand, localStartAt: new Date('2026-11-04T01:00:00Z'), ...onsale },
    { id: EV.indieIrvingNov2, name: 'Twisted Teens (Irving Plaza)', category: 'concert', genre: 'rock / alternative rock', venueId: V.irving, primaryEntityId: E.indieBand, localStartAt: new Date('2026-11-03T01:00:00Z'), ...onsale },
    { id: EV.popMsgNov20, name: 'Arena Pop Star: World Tour', category: 'concert', genre: 'pop / pop', venueId: FX.venues.msg, primaryEntityId: E.popStar, localStartAt: new Date('2026-11-21T01:00:00Z'), ...onsale },
    { id: EV.jazzOct1, name: 'The High Society New Orleans Jazz Band', category: 'concert', genre: 'jazz / folk jazz', venueId: V.birdland, primaryEntityId: E.jazzBand, localStartAt: new Date('2026-10-01T23:30:00Z'), ...onsale },
    { id: EV.indieOct3, name: 'Twisted Teens (Saturday)', category: 'concert', genre: 'rock / indie rock', venueId: V.bowery, primaryEntityId: E.indieBand, localStartAt: new Date('2026-10-04T01:00:00Z'), ...onsale },
  ]);
  const tm = (eventId: string, sourceEventId: string, slug: string) => ({ eventId, sourceId: 'ticketmaster', sourceEventId, authoritativeUrl: `https://www.ticketmaster.com/${slug}/event/${sourceEventId}`, role: 'discovery', confidence: 'provider_id' });
  await h.db.insert(t.eventSourceMappings).values([
    tm(EV.kanan7pm, KANAN_7PM_TM_ID, 'kanan-gill-not-this-again-new-york-new-york-10-03-2026'),
    tm(EV.kanan4pm, '0300643DF03B25AA', 'kanan-gill-not-this-again-new-york-new-york-10-03-2026'),
    tm(EV.hamiltonMatinee, 'Z1R6HAM0001', 'hamilton-ny-new-york-new-york-10-03-2026'),
    tm(EV.hamiltonEvening, 'Z1R6HAM0002', 'hamilton-ny-new-york-new-york-10-03-2026'),
    ...[EV.wickedSep30, EV.wickedNov7, EV.wickedNov11, EV.wickedNov14].map((id, i) => tm(id, `Z1R6WIC000${i}`, 'wicked-new-york')),
    ...[EV.indieNov3, EV.indieIrvingNov2, EV.popMsgNov20, EV.jazzOct1, EV.indieOct3].map((id, i) => tm(id, `Z1R6CON000${i}`, 'concert-new-york')),
  ]);
}

const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, eventTime: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] } as ListingRead;
/** What the two synthetic QA images show, as a model reads them (screenshots/manifest.json). */
export class R6Reader implements ListingReader {
  readonly name = 'fake';
  constructor(private readonly which: Map<number, 'listing' | 'ticket'>) {}
  async read(input: { image?: { base64: string } | null }): Promise<ListingRead> {
    if (!input.image) return blank;
    const w = (await sharp(Buffer.from(input.image.base64, 'base64')).metadata()).width ?? 0;
    const kind = this.which.get(w);
    if (kind === 'ticket') return { ...blank, kind: 'ticket_listing', sensitiveContent: true, confidence: 'high' };
    if (kind !== 'listing') return blank;
    return { ...blank, kind: 'ticket_listing', confidence: 'high', eventName: 'Kanan Gill: Not This Again', eventDate: '2026-10-03', eventTime: '19:00', venue: 'Town Hall', city: 'New York', quantity: 3, priceText: '$52.00 each; fees for entire order $24.00; total for 3 tickets $180.00', priceDollars: 52, priceBasis: 'per_ticket', feeBasis: 'before_fees', totalDollars: 180, section: 'Balcony', row: 'L', seatNumbers: ['11', '12', '13'], seatsTogether: true, restrictions: ['Limited view', 'Availability not guaranteed'], deliveryText: 'Mobile transfer by 6:00 PM on October 3', deliveryBy: '2026-10-03' } as ListingRead;
  }
}

export type Reply = { text: string; html: string; template: string; state: string };

/**
 * Sends every case in order, each turn after the previous one's replies are recorded, and returns the replies
 * per case and turn. 27–29 continue earlier threads; 30 writes from 01's address in a new thread.
 */
export async function replayR6(h: DbHandle, opts: { only?: string[] } = {}) {
  const env = testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules', STAFF_EMAIL_ALLOWLIST: 'staff@ticketguy.test', AUTO_APPROVE_WHILE_TESTING: 'true', EMAIL_TEST_RECIPIENT_ALLOWLIST: 'owner@ticketguy.test' });
  // Two blank images the reader tells apart by width: one listing, one ticket with a barcode.
  const png = async (width: number) => new Uint8Array(await sharp({ create: { width, height: 60, channels: 3, background: '#ffffff' } }).png().toBuffer());
  const images = { 'listing.png': await png(81), 'ticket-details.png': await png(82) };
  const reader = new R6Reader(new Map([[81, 'listing'], [82, 'ticket']]));
  const c = new Concierge({ db: h.db, env, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => CLOCK, emailProvider: new RecordingProvider(), fixtureOffers: {}, listingReader: reader });
  await setKillSwitch(h.db, TEST_MODE_KEY, true, 'staff-1', 'R6 replay');
  const drain = async () => {
    for (let i = 0; i < 15; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: CLOCK });
      if (!leased.length) return;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        else if (ev.eventType === 'email.send_requested') await c.dispatchSend(p.sendIntentId!);
        else if (ev.eventType === 'staff.alert') await c.alertStaff({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, CLOCK);
      }
    }
  };
  const requestOf = new Map<string, string>();
  const replies = new Map<string, Reply[][]>();
  for (const k of replay.cases as Case[]) {
    if (opts.only && !opts.only.includes(k.id) && !(k.thread && opts.only.includes(k.thread))) continue;
    const turns: Reply[][] = [];
    for (const [i, turn] of k.turns.entries()) {
      const thread = i === 0 ? (k.thread ? requestOf.get(k.thread) : undefined) : requestOf.get(k.id);
      const file = (turn as { attachment?: keyof typeof images }).attachment;
      const built = await buildTestInbound(h.db, env, { from: thread ? null : k.from, fromName: k.name, subject: thread ? null : k.subject, text: turn.text, replyToRequestId: thread ?? null, attachments: file ? [{ filename: file, contentType: 'image/png', bytes: images[file] as Uint8Array<ArrayBuffer> }] : [] }, CLOCK);
      if (!built.ok) throw new Error(`${k.id} turn ${i + 1}: ${built.error}`);
      const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
      const r = (await c.ingestInbound(built.message)) as { requestId?: string };
      if (r.requestId && !requestOf.has(k.id)) requestOf.set(k.id, r.requestId);
      await drain();
      const reqId = requestOf.get(k.id);
      const [req] = reqId ? await h.db.select({ state: t.requests.state }).from(t.requests).where(eq(t.requests.id, reqId)) : [];
      const after = (await h.db.select().from(t.sendIntents)).filter((s) => !before.has(s.id))
        // The clock is fixed, so creation times tie: an acknowledgment is always the first email of a turn.
        .sort((x, y) => Number(x.bodyText.includes('Here\'s what I have')) > Number(y.bodyText.includes('Here\'s what I have')) ? -1 : Number(x.bodyText.includes('Here\'s what I have')) < Number(y.bodyText.includes('Here\'s what I have')) ? 1 : 0);
      turns.push(after.map((s) => ({ text: s.bodyText, html: s.bodyHtml, template: `${s.messageClass}:${s.state}`, state: req?.state ?? '?' })));
    }
    replies.set(k.id, turns);
  }
  return { replies, requestOf, concierge: c };
}

/** The reply text without the greeting's name line and the signature block. */
export const body = (r: Reply) => r.text.split(/\n\nTicket Guy\n/)[0]!;
