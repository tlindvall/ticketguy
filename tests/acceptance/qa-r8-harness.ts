import sharp from 'sharp';
import { eq, inArray } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { teamAliases } from '@/lib/catalog/sync';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { setKillSwitch } from '@/lib/email/send-gate';
import { buildTestInbound, TEST_MODE_KEY } from '@/lib/email/test-mode';
import type { RequestExtraction } from '@/lib/domain/types';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { RecordingProvider, testEnv } from '../harness';
import replay from '../fixtures/qa-r8-sports-cases.json';

/**
 * The TGQA-R8 sports QA (30 Sep 2026, deploy 2a0b5d1, 27 scenarios, 61 turns), replayed through test mode the way
 * the QA ran it. The catalog is seeded the way Ticketmaster Discovery gives it to the live service, traps included:
 * - the Knicks' Oct 5 preseason game in Philadelphia is named "New York Knicks v Philadelphia 76ers", which the
 *   sync reads as a Knicks home game (isHome true);
 * - venues carry no aliases (no "MSG"), and teams no home venue, as Discovery-synced rows don't;
 * - the Knicks also play the 76ers at MSG on Oct 20, and in Boston on Fri Oct 23.
 *
 * Each case runs twice. `rules` reads every email with the deterministic reader. `live` reads it the same way and
 * then puts back the fields the production model read on the day (from the QA's own trace: city, date, budget,
 * quantity, intent, ambiguities), so the model's omissions reach the rest of the pipeline as they did live. That
 * is a replay of recorded model output, not a new model call: no model is reachable from this environment.
 */
export const CLOCK = new Date(replay.clock);
export type Case = (typeof replay.cases)[number] & { thread?: string; from?: string; name?: string; subject?: string };
export type Mode = 'rules' | 'live';

const V = {
  philly: '10000000-0000-4000-8000-0000000008c1',
  boston: '10000000-0000-4000-8000-0000000008c2',
  ubs: '10000000-0000-4000-8000-0000000008c3',
  prudential: '10000000-0000-4000-8000-0000000008c4',
  crypto: '10000000-0000-4000-8000-0000000008c5',
  dodger: '10000000-0000-4000-8000-0000000008c6',
};
const E = {
  lightning: '20000000-0000-4000-8000-0000000008c1',
  sixers: '20000000-0000-4000-8000-0000000008c2',
  wizards: '20000000-0000-4000-8000-0000000008c3',
  nets: '20000000-0000-4000-8000-0000000008c4',
  celtics: '20000000-0000-4000-8000-0000000008c5',
  magic: '20000000-0000-4000-8000-0000000008c6',
  cavaliers: '20000000-0000-4000-8000-0000000008c7',
  blazers: '20000000-0000-4000-8000-0000000008c8',
  pacers: '20000000-0000-4000-8000-0000000008c9',
  lakers: '20000000-0000-4000-8000-0000000008ca',
  dodgers: '20000000-0000-4000-8000-0000000008cb',
  devils: '20000000-0000-4000-8000-0000000008cc',
  bruins: '20000000-0000-4000-8000-0000000008cd',
  suns: '20000000-0000-4000-8000-0000000008ce',
};
export const EV = {
  rangersTb: '30000000-0000-4000-8000-0000000008c1',
  knicksAtPhilly: '30000000-0000-4000-8000-0000000008c2',
  knicksWizards: '30000000-0000-4000-8000-0000000008c3',
  knicksSixersHome: '30000000-0000-4000-8000-0000000008c4',
  knicksAtBoston: '30000000-0000-4000-8000-0000000008c5',
  knicksMagic: '30000000-0000-4000-8000-0000000008c6',
  knicksCavs: '30000000-0000-4000-8000-0000000008c7',
  knicksBlazers: '30000000-0000-4000-8000-0000000008c8',
  knicksPacers: '30000000-0000-4000-8000-0000000008c9',
  netsSixers: '30000000-0000-4000-8000-0000000008ca',
  lakersSuns: '30000000-0000-4000-8000-0000000008cb',
  dodgersG1: '30000000-0000-4000-8000-0000000008cc',
  dodgersG2: '30000000-0000-4000-8000-0000000008cd',
  dodgersG3: '30000000-0000-4000-8000-0000000008ce',
  islandersUbs: '30000000-0000-4000-8000-0000000008cf',
  devilsPru: '30000000-0000-4000-8000-0000000008d0',
  rangersBruins7pm: '30000000-0000-4000-8000-0000000008d1',
};

export async function seedR8(h: DbHandle) {
  const ET = 'America/New_York';
  const LA = 'America/Los_Angeles';
  // The fixture world's own games would not be on the live calendar.
  const fx = [FX.events.knicks, FX.events.rangersPreseason, FX.events.rangersRegular];
  await h.db.update(t.events).set({ status: 'cancelled' }).where(inArray(t.events.id, fx));
  // Discovery-synced rows: no aliases, no home venues.
  await h.db.update(t.venues).set({ aliases: [], latitude: 40.7505, longitude: -73.9934 }).where(eq(t.venues.id, FX.venues.msg));
  await h.db.update(t.venues).set({ aliases: [], city: 'Brooklyn', latitude: 40.6826, longitude: -73.9754 }).where(eq(t.venues.id, FX.venues.barclays));
  await h.db.update(t.entities).set({ homeVenueId: null }).where(inArray(t.entities.id, [FX.entities.knicks, FX.entities.rangers]));
  await h.db.update(t.adapterConfigs).set({ enabled: false });
  await h.db.insert(t.venues).values([
    { id: V.philly, name: 'Xfinity Mobile Arena', aliases: [], city: 'Philadelphia', state: 'PA', country: 'US', timezone: ET, latitude: 39.9012, longitude: -75.172 },
    { id: V.boston, name: 'TD Garden', aliases: [], city: 'Boston', state: 'MA', country: 'US', timezone: ET, latitude: 42.3662, longitude: -71.0621 },
    { id: V.ubs, name: 'UBS Arena', aliases: [], city: 'Elmont', state: 'NY', country: 'US', timezone: ET, latitude: 40.7126, longitude: -73.7257 },
    { id: V.prudential, name: 'Prudential Center', aliases: [], city: 'Newark', state: 'NJ', country: 'US', timezone: ET, latitude: 40.7334, longitude: -74.1711 },
    { id: V.crypto, name: 'Crypto.com Arena', aliases: [], city: 'Los Angeles', state: 'CA', country: 'US', timezone: LA, latitude: 34.043, longitude: -118.2673 },
    { id: V.dodger, name: 'Dodger Stadium', aliases: [], city: 'Los Angeles', state: 'CA', country: 'US', timezone: LA, latitude: 34.0739, longitude: -118.24 },
  ]);
  // As the Discovery sync writes them: the last word of the name as the only alias ("Lakers").
  const team = (id: string, name: string, league: string, aliases: string[]) => ({ id, kind: 'team', name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), aliases: [...aliases, ...teamAliases(name)], league, homeVenueId: null });
  await h.db.insert(t.entities).values([
    team(E.lightning, 'Tampa Bay Lightning', 'NHL', []),
    team(E.sixers, 'Philadelphia 76ers', 'NBA', []),
    team(E.wizards, 'Washington Wizards', 'NBA', []),
    team(E.nets, 'Brooklyn Nets', 'NBA', []),
    team(E.celtics, 'Boston Celtics', 'NBA', []),
    team(E.magic, 'Orlando Magic', 'NBA', []),
    team(E.cavaliers, 'Cleveland Cavaliers', 'NBA', []),
    team(E.blazers, 'Portland Trail Blazers', 'NBA', []),
    team(E.pacers, 'Indiana Pacers', 'NBA', []),
    team(E.lakers, 'Los Angeles Lakers', 'NBA', []),
    team(E.dodgers, 'Los Angeles Dodgers', 'MLB', []),
    team(E.devils, 'New Jersey Devils', 'NHL', []),
    team(E.bruins, 'Boston Bruins', 'NHL', []),
    team(E.suns, 'Phoenix Suns', 'NBA', []),
  ]);
  const g = { status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: false } as const;
  await h.db.insert(t.events).values([
    { id: EV.rangersTb, name: 'New York Rangers vs. Tampa Bay Lightning', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, opponentEntityId: E.lightning, isHome: true, localStartAt: new Date('2026-10-01T23:00:00Z'), ...g },
    // Discovery's name for an away preseason game; the sync reads "X v Y" as X at home.
    { id: EV.knicksAtPhilly, name: 'Preseason: New York Knicks v Philadelphia 76ers', category: 'nba', subtype: 'preseason', venueId: V.philly, primaryEntityId: FX.entities.knicks, opponentEntityId: E.sixers, isHome: true, localStartAt: new Date('2026-10-05T23:00:00Z'), ...g },
    { id: EV.knicksWizards, name: 'Preseason: New York Knicks v Washington Wizards', category: 'nba', subtype: 'preseason', venueId: FX.venues.msg, primaryEntityId: FX.entities.knicks, opponentEntityId: E.wizards, isHome: true, localStartAt: new Date('2026-10-08T23:30:00Z'), ...g },
    { id: EV.netsSixers, name: 'Brooklyn Nets v. Philadelphia 76ers (Preseason Game)', category: 'nba', subtype: 'preseason', venueId: FX.venues.barclays, primaryEntityId: E.nets, opponentEntityId: E.sixers, isHome: true, localStartAt: new Date('2026-10-08T23:30:00Z'), ...g },
    { id: EV.lakersSuns, name: 'Los Angeles Lakers vs. Phoenix Suns', category: 'nba', subtype: 'preseason', venueId: V.crypto, primaryEntityId: E.lakers, opponentEntityId: E.suns, isHome: true, localStartAt: new Date('2026-10-10T02:30:00Z'), ...g },
    { id: EV.dodgersG1, name: 'TBD at Los Angeles Dodgers: NLDS (Home Game 1)', category: 'mlb', subtype: 'postseason', venueId: V.dodger, primaryEntityId: E.dodgers, isHome: true, localStartAt: new Date('2026-10-03T23:00:00Z'), ...g },
    { id: EV.dodgersG2, name: 'TBD at Los Angeles Dodgers: NLDS (Home Game 2)', category: 'mlb', subtype: 'postseason', venueId: V.dodger, primaryEntityId: E.dodgers, isHome: true, localStartAt: new Date('2026-10-04T23:00:00Z'), ...g },
    { id: EV.dodgersG3, name: 'TBD at Los Angeles Dodgers: NLDS (Home Game 3, If Necessary)', category: 'mlb', subtype: 'postseason', venueId: V.dodger, primaryEntityId: E.dodgers, isHome: true, localStartAt: new Date('2026-10-10T01:00:00Z'), ...g },
    { id: EV.knicksSixersHome, name: 'New York Knicks vs. Philadelphia 76ers', category: 'nba', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.knicks, opponentEntityId: E.sixers, isHome: true, localStartAt: new Date('2026-10-20T23:00:00Z'), ...g },
    { id: EV.knicksAtBoston, name: 'Boston Celtics vs. New York Knicks', category: 'nba', subtype: 'regular_season', venueId: V.boston, primaryEntityId: FX.entities.knicks, opponentEntityId: E.celtics, isHome: false, localStartAt: new Date('2026-10-23T23:00:00Z'), ...g },
    { id: EV.knicksMagic, name: 'New York Knicks vs. Orlando Magic', category: 'nba', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.knicks, opponentEntityId: E.magic, isHome: true, localStartAt: new Date('2026-10-25T23:00:00Z'), ...g },
    // On general sale: the official-sale route answers it.
    { id: EV.knicksCavs, name: 'New York Knicks vs. Cleveland Cavaliers', category: 'nba', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.knicks, opponentEntityId: E.cavaliers, isHome: true, localStartAt: new Date('2026-11-12T00:00:00Z'), saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), ...g },
    // November is Eastern Standard Time.
    { id: EV.rangersBruins7pm, name: 'New York Rangers vs. Boston Bruins', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, opponentEntityId: E.bruins, isHome: true, localStartAt: new Date('2026-11-15T00:00:00Z'), ...g },
    { id: EV.knicksBlazers, name: 'New York Knicks vs. Portland Trail Blazers', category: 'nba', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.knicks, opponentEntityId: E.blazers, isHome: true, localStartAt: new Date('2026-11-22T00:30:00Z'), ...g },
    { id: EV.knicksPacers, name: 'New York Knicks vs. Indiana Pacers', category: 'nba', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.knicks, opponentEntityId: E.pacers, isHome: true, localStartAt: new Date('2026-11-23T01:00:00Z'), ...g },
    { id: EV.islandersUbs, name: 'New York Islanders vs. Boston Bruins', category: 'nhl', subtype: 'regular_season', venueId: V.ubs, primaryEntityId: FX.entities.islanders, opponentEntityId: E.bruins, isHome: true, localStartAt: new Date('2026-11-22T00:30:00Z'), ...g },
    { id: EV.devilsPru, name: 'New Jersey Devils vs. Tampa Bay Lightning', category: 'nhl', subtype: 'regular_season', venueId: V.prudential, primaryEntityId: E.devils, opponentEntityId: E.lightning, isHome: true, localStartAt: new Date('2026-11-29T00:30:00Z'), ...g },
  ]);
  const tm = (eventId: string, id: string) => ({ eventId, sourceId: 'ticketmaster', sourceEventId: id, authoritativeUrl: `https://www.ticketmaster.com/event/${id}`, role: 'discovery', confidence: 'provider_id' });
  await h.db.insert(t.eventSourceMappings).values(Object.values(EV).map((id, i) => tm(id, `R8SPORT${String(i).padStart(4, '0')}`)));
}

const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, eventTime: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] } as ListingRead;
/** The synthetic QA screenshot (screenshots/knicks-listing.png) as a model reads it. */
export class R8Reader implements ListingReader {
  readonly name = 'fake';
  async read(input: { image?: { base64: string } | null }): Promise<ListingRead> {
    if (!input.image) return blank;
    return { ...blank, kind: 'ticket_listing', confidence: 'high', eventName: 'New York Knicks vs Washington Wizards', eventDate: '2026-10-08', eventTime: '19:30', venue: 'Madison Square Garden', city: 'New York', quantity: 3, priceText: '$52 each; fees for entire order $24; total $180', priceDollars: 52, priceBasis: 'per_ticket', feeBasis: 'before_fees', totalDollars: 180, section: '214', row: '12', seatNumbers: null, seatsTogether: true, restrictions: ['Limited view', 'SYNTHETIC QA LISTING, NOT FOR SALE'], deliveryText: 'Mobile transfer by October 8 at 4:00 PM EDT', deliveryBy: '2026-10-08' } as ListingRead;
  }
}

type Live = { intent?: string; performerOrTeam?: string | null; city?: string | null; dateExpression?: string | null; resolvedLocalDate?: string | null; quantity?: number | null; budgetCents?: number | null; budgetBasis?: 'per_ticket' | 'whole_party' | null; togetherRequired?: boolean | null; ambiguities?: string[] };

/** The rules reader, with what the production model read on the day put back over it for that exact email. */
export class RecordedModelExtractor implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  constructor(private readonly byText: Map<string, Live>) {}
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    const x = await this.rules.extract(input);
    const live = this.byText.get(input.text.trim());
    if (!live) return x;
    const keys = ['performerOrTeam', 'city', 'dateExpression', 'resolvedLocalDate', 'quantity', 'budgetCents', 'budgetBasis', 'togetherRequired'] as const;
    const out = { ...x } as Record<string, unknown>;
    for (const k of keys) if (k in live) out[k] = live[k] ?? null;
    // The trace records the city, not the state: a model that read no city read no state either.
    if ('city' in live && !live.city) out.state = null;
    if (live.ambiguities) out.ambiguities = live.ambiguities;
    if (live.intent) out.intent = live.intent;
    return out as RequestExtraction;
  }
}

export type Reply = { text: string; html: string; template: string; state: string };

export async function replayR8(h: DbHandle, opts: { mode: Mode; cases?: Case[]; only?: string[] }) {
  const cases = (opts.cases ?? (replay.cases as Case[])).filter((k) => !opts.only || opts.only.includes(k.id) || (k.thread && opts.only.includes(k.thread)));
  const env = testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules', STAFF_EMAIL_ALLOWLIST: 'staff@ticketguy.test', AUTO_APPROVE_WHILE_TESTING: 'true', EMAIL_TEST_RECIPIENT_ALLOWLIST: 'owner@ticketguy.test' });
  const live = new Map<string, Live>();
  for (const k of cases) for (const tt of k.turns as Array<{ text: string; live?: Live }>) if (tt.live) live.set(tt.text.trim(), tt.live);
  const extractor = opts.mode === 'live' ? new RecordedModelExtractor(live) : new FixtureExtractor();
  const png = new Uint8Array(await sharp({ create: { width: 90, height: 60, channels: 3, background: '#ffffff' } }).png().toBuffer());
  const c = new Concierge({ db: h.db, env, extractor, drafter: new FixtureDrafter(), clock: () => CLOCK, emailProvider: new RecordingProvider(), fixtureOffers: {}, listingReader: new R8Reader() });
  await setKillSwitch(h.db, TEST_MODE_KEY, true, 'staff-1', 'R8 replay');
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
  for (const k of cases) {
    const turns: Reply[][] = [];
    for (const [i, turn] of (k.turns as Array<{ text: string; attachment?: string }>).entries()) {
      // A reply goes to the request our last email was about, as a mail client's In-Reply-To would.
      const thread = i === 0 ? (k.thread ? requestOf.get(k.thread) : undefined) : requestOf.get(k.id);
      const built = await buildTestInbound(h.db, env, { from: thread ? null : k.from!, fromName: k.name, subject: thread ? null : k.subject, text: turn.text, replyToRequestId: thread ?? null, attachments: turn.attachment ? [{ filename: turn.attachment, contentType: 'image/png', bytes: png as Uint8Array<ArrayBuffer> }] : [] }, CLOCK);
      if (!built.ok) throw new Error(`${k.id} turn ${i + 1}: ${built.error}`);
      const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
      const r = (await c.ingestInbound(built.message)) as { requestId?: string };
      if (r.requestId) requestOf.set(k.id, r.requestId);
      await drain();
      const reqId = requestOf.get(k.id);
      const [req] = reqId ? await h.db.select({ state: t.requests.state }).from(t.requests).where(eq(t.requests.id, reqId)) : [];
      const ack = (s: { bodyText: string }) => Number(s.bodyText.includes("Here's what I have"));
      const after = (await h.db.select().from(t.sendIntents)).filter((s) => !before.has(s.id)).sort((x, y) => ack(y) - ack(x));
      turns.push(after.map((s) => ({ text: s.bodyText, html: s.bodyHtml, template: `${s.messageClass}:${s.state}`, state: req?.state ?? '?' })));
    }
    replies.set(k.id, turns);
  }
  return { replies, requestOf, concierge: c };
}

/** The reply text without the signature block. */
export const body = (r: Reply) => r.text.split(/\n\nTicket Guy\n/)[0]!;
