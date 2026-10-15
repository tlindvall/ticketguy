/**
 * The eval world: the base fixture world (src/lib/fixtures, seedFixtures) plus ~35 more events across New York and
 * Los Angeles, so evals can test discovery, lists, theater, sold-out and not-yet-on-sale events, links, price trends
 * and seat quality. Eval-only: the app's own fixtures and its 1,900 unit tests are untouched.
 *
 * Fidelity rules, so a pass here means something in production:
 * - Team entities carry only the aliases production's catalog sync gives them (teamAliases: the last word). Nicknames
 *   ("Blueshirts", "Doyers", "Isles") must be resolved by the app's own roster list, exactly as live.
 * - Every listing price is synthetic. Listings are a mutable map, so a test can move the market between emails.
 */
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import type { Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX, FIXTURE_OFFERS, FIXTURE_NOW } from '@/lib/fixtures';
import { basketKeyFor } from '@/lib/intake/pipeline';
import { teamAliases } from '@/lib/catalog/sync';
import { eventAssetKey } from '@/lib/brand/event-image';
import type { Offer } from '@/lib/domain/types';

const uid = (n: number) => `7e7e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const V = {
  msg: FX.venues.msg,
  barclays: FX.venues.barclays,
  yankee: FX.venues.yankee,
  ubs: uid(1),
  citi: uid(2),
  metlife: uid(3),
  rodgers: uid(4),
  crypto: uid(10),
  dodger: uid(11),
  sofi: uid(12),
  forum: uid(13),
  intuit: uid(14),
  pantages: uid(15),
} as const;

export const ENT = {
  rangers: FX.entities.rangers,
  islanders: FX.entities.islanders,
  knicks: FX.entities.knicks,
  yankees: FX.entities.yankees,
  leafs: FX.entities.leafs,
  duaLipa: FX.entities.duaLipa,
  bruins: uid(100), devils: uid(101), celtics: uid(102), nets: uid(103), heat: uid(104), mets: uid(105), phillies: uid(106),
  nyGiants: uid(107), cowboys: uid(108), lakers: uid(109), warriors: uid(110), clippers: uid(111), suns: uid(112),
  kings: uid(113), ducks: uid(114), rams: uid(115), seahawks: uid(116), dodgers: uid(117), sfGiants: uid(118),
  rockies: uid(119), spurs: uid(120), txRangers: uid(121),
  hamilton: uid(150), wicked: uid(151), billie: uid(152), olivia: uid(153), bruno: uid(154),
} as const;

export const EV = {
  ...FX.events,
  rangersBruins: uid(200), rangersDevils: uid(201), islandersRangers: uid(202), knicksCeltics: uid(203), knicksNets: uid(204),
  netsHeat: uid(205), metsPhillies: uid(206), giantsCowboys: uid(207), hamiltonMatinee: uid(208), hamiltonEvening: uid(209),
  oliviaMsg: uid(210),
  dodgersRockies: uid(220), dodgersGiants: uid(221), billieForum: uid(222),
  kingsJan9: uid(230), lakersWarriors: uid(231), clippersSuns: uid(232), kingsDucks: uid(233), wickedJan14: uid(234),
  lakersCeltics: uid(235), ramsSeahawks: uid(236), brunoForum: uid(237), lakersSpurs: uid(238),
  // Oct 15 live thread (Rangers vs Ducks, $150 for two): nothing fits here, but the Kings game a week later does. Dated
  // in November so the Rangers-week scenarios ("this week", "in October") see the same games as before.
  rangersDucks: uid(240), rangersKings: uid(241),
} as const;

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

const VENUES: Array<typeof t.venues.$inferInsert> = [
  { id: V.ubs, name: 'UBS Arena', aliases: [], city: 'Elmont', state: 'NY', country: 'US', timezone: NY, layoutVersion: 'v2024' },
  { id: V.citi, name: 'Citi Field', aliases: [], city: 'Queens', state: 'NY', country: 'US', timezone: NY, layoutVersion: 'v2024' },
  { id: V.metlife, name: 'MetLife Stadium', aliases: [], city: 'East Rutherford', state: 'NJ', country: 'US', timezone: NY, layoutVersion: 'v2024' },
  { id: V.rodgers, name: 'Richard Rodgers Theatre', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: NY, layoutVersion: 'v2024' },
  { id: V.crypto, name: 'Crypto.com Arena', aliases: ['Staples Center'], city: 'Los Angeles', state: 'CA', country: 'US', timezone: LA, layoutVersion: 'v2024' },
  { id: V.dodger, name: 'Dodger Stadium', aliases: [], city: 'Los Angeles', state: 'CA', country: 'US', timezone: LA, layoutVersion: 'v2024' },
  { id: V.sofi, name: 'SoFi Stadium', aliases: [], city: 'Inglewood', state: 'CA', country: 'US', timezone: LA, layoutVersion: 'v2024' },
  { id: V.forum, name: 'Kia Forum', aliases: ['The Forum'], city: 'Inglewood', state: 'CA', country: 'US', timezone: LA, layoutVersion: 'v2024' },
  { id: V.intuit, name: 'Intuit Dome', aliases: [], city: 'Inglewood', state: 'CA', country: 'US', timezone: LA, layoutVersion: 'v2024' },
  { id: V.pantages, name: 'Hollywood Pantages Theatre', aliases: ['Pantages'], city: 'Los Angeles', state: 'CA', country: 'US', timezone: LA, layoutVersion: 'v2024' },
];

type E = { id: string; kind: 'team' | 'performer' | 'production'; name: string; league?: string; home?: string };
const ENTITIES: E[] = [
  { id: ENT.bruins, kind: 'team', name: 'Boston Bruins', league: 'NHL' },
  { id: ENT.devils, kind: 'team', name: 'New Jersey Devils', league: 'NHL' },
  { id: ENT.celtics, kind: 'team', name: 'Boston Celtics', league: 'NBA' },
  { id: ENT.nets, kind: 'team', name: 'Brooklyn Nets', league: 'NBA', home: V.barclays },
  { id: ENT.heat, kind: 'team', name: 'Miami Heat', league: 'NBA' },
  { id: ENT.mets, kind: 'team', name: 'New York Mets', league: 'MLB', home: V.citi },
  { id: ENT.phillies, kind: 'team', name: 'Philadelphia Phillies', league: 'MLB' },
  { id: ENT.nyGiants, kind: 'team', name: 'New York Giants', league: 'NFL', home: V.metlife },
  { id: ENT.cowboys, kind: 'team', name: 'Dallas Cowboys', league: 'NFL' },
  { id: ENT.lakers, kind: 'team', name: 'Los Angeles Lakers', league: 'NBA', home: V.crypto },
  { id: ENT.warriors, kind: 'team', name: 'Golden State Warriors', league: 'NBA' },
  { id: ENT.clippers, kind: 'team', name: 'Los Angeles Clippers', league: 'NBA', home: V.intuit },
  { id: ENT.suns, kind: 'team', name: 'Phoenix Suns', league: 'NBA' },
  { id: ENT.kings, kind: 'team', name: 'Los Angeles Kings', league: 'NHL', home: V.crypto },
  { id: ENT.ducks, kind: 'team', name: 'Anaheim Ducks', league: 'NHL' },
  { id: ENT.rams, kind: 'team', name: 'Los Angeles Rams', league: 'NFL', home: V.sofi },
  { id: ENT.seahawks, kind: 'team', name: 'Seattle Seahawks', league: 'NFL' },
  { id: ENT.dodgers, kind: 'team', name: 'Los Angeles Dodgers', league: 'MLB', home: V.dodger },
  { id: ENT.sfGiants, kind: 'team', name: 'San Francisco Giants', league: 'MLB' },
  { id: ENT.rockies, kind: 'team', name: 'Colorado Rockies', league: 'MLB' },
  { id: ENT.spurs, kind: 'team', name: 'San Antonio Spurs', league: 'NBA' },
  // No events on file: "Rangers" alone is ambiguous between the NHL and MLB teams.
  { id: ENT.txRangers, kind: 'team', name: 'Texas Rangers', league: 'MLB' },
  { id: ENT.hamilton, kind: 'production', name: 'Hamilton' },
  { id: ENT.wicked, kind: 'production', name: 'Wicked' },
  { id: ENT.billie, kind: 'performer', name: 'Billie Eilish' },
  { id: ENT.olivia, kind: 'performer', name: 'Olivia Rodrigo' },
  { id: ENT.bruno, kind: 'performer', name: 'Bruno Mars' },
];

type Ev = Omit<typeof t.events.$inferInsert, 'verifiedSourceId' | 'isFixture' | 'status'> & { status?: string };
const at = (iso: string) => new Date(iso);
const EVENTS: Ev[] = [
  // New York, autumn 2026 (clock: FIXTURE_NOW = Tue Sep 22 2026, or a scenario's own clock)
  { id: EV.metsPhillies, name: 'New York Mets vs. Philadelphia Phillies', category: 'mlb', subtype: 'regular_season', venueId: V.citi, primaryEntityId: ENT.mets, opponentEntityId: ENT.phillies, isHome: true, localStartAt: at('2026-09-26T20:10:00Z') },
  { id: EV.giantsCowboys, name: 'New York Giants vs. Dallas Cowboys', category: 'nfl', subtype: 'regular_season', venueId: V.metlife, primaryEntityId: ENT.nyGiants, opponentEntityId: ENT.cowboys, isHome: true, localStartAt: at('2026-10-04T17:00:00Z') },
  { id: EV.hamiltonMatinee, name: 'Hamilton', category: 'theater', subtype: 'matinee', venueId: V.rodgers, primaryEntityId: ENT.hamilton, localStartAt: at('2026-10-10T18:00:00Z') },
  { id: EV.hamiltonEvening, name: 'Hamilton', category: 'theater', subtype: 'evening', venueId: V.rodgers, primaryEntityId: ENT.hamilton, localStartAt: at('2026-10-11T00:00:00Z') },
  { id: EV.rangersBruins, name: 'New York Rangers vs. Boston Bruins', category: 'nhl', subtype: 'regular_season', venueId: V.msg, primaryEntityId: ENT.rangers, opponentEntityId: ENT.bruins, isHome: true, localStartAt: at('2026-10-22T23:00:00Z') },
  { id: EV.rangersDevils, name: 'New York Rangers vs. New Jersey Devils', category: 'nhl', subtype: 'regular_season', venueId: V.msg, primaryEntityId: ENT.rangers, opponentEntityId: ENT.devils, isHome: true, localStartAt: at('2026-10-24T23:00:00Z') },
  { id: EV.rangersDucks, name: 'New York Rangers vs. Anaheim Ducks', category: 'nhl', subtype: 'regular_season', venueId: V.msg, primaryEntityId: ENT.rangers, opponentEntityId: ENT.ducks, isHome: true, localStartAt: at('2026-11-16T23:00:00Z') },
  { id: EV.rangersKings, name: 'New York Rangers vs. Los Angeles Kings', category: 'nhl', subtype: 'regular_season', venueId: V.msg, primaryEntityId: ENT.rangers, opponentEntityId: ENT.kings, isHome: true, localStartAt: at('2026-11-23T23:00:00Z') },
  { id: EV.islandersRangers, name: 'New York Islanders vs. New York Rangers', category: 'nhl', subtype: 'regular_season', venueId: V.ubs, primaryEntityId: ENT.islanders, opponentEntityId: ENT.rangers, isHome: true, localStartAt: at('2026-10-27T23:30:00Z') },
  { id: EV.knicksCeltics, name: 'New York Knicks vs. Boston Celtics', category: 'nba', subtype: 'regular_season', venueId: V.msg, primaryEntityId: ENT.knicks, opponentEntityId: ENT.celtics, isHome: true, localStartAt: at('2026-10-28T23:30:00Z') },
  { id: EV.netsHeat, name: 'Brooklyn Nets vs. Miami Heat', category: 'nba', subtype: 'regular_season', venueId: V.barclays, primaryEntityId: ENT.nets, opponentEntityId: ENT.heat, isHome: true, localStartAt: at('2026-10-30T23:30:00Z') },
  { id: EV.knicksNets, name: 'New York Knicks vs. Brooklyn Nets', category: 'nba', subtype: 'regular_season', venueId: V.msg, primaryEntityId: ENT.knicks, opponentEntityId: ENT.nets, isHome: true, localStartAt: at('2026-11-01T23:00:00Z') },
  // Announced, public sale not open yet: no listings to quote.
  { id: EV.oliviaMsg, name: 'Olivia Rodrigo', category: 'concert', venueId: V.msg, primaryEntityId: ENT.olivia, localStartAt: at('2026-11-21T01:00:00Z'), saleStatus: 'offsale', publicSaleStartAt: at('2026-10-02T14:00:00Z') },
  // Los Angeles, autumn 2026
  { id: EV.dodgersRockies, name: 'Los Angeles Dodgers vs. Colorado Rockies', category: 'mlb', subtype: 'regular_season', venueId: V.dodger, primaryEntityId: ENT.dodgers, opponentEntityId: ENT.rockies, isHome: true, localStartAt: at('2026-09-30T02:10:00Z') },
  { id: EV.dodgersGiants, name: 'Los Angeles Dodgers vs. San Francisco Giants', category: 'mlb', subtype: 'regular_season', venueId: V.dodger, primaryEntityId: ENT.dodgers, opponentEntityId: ENT.sfGiants, isHome: true, localStartAt: at('2026-10-01T02:10:00Z') },
  // Sold out at face value; no resale listings on file.
  { id: EV.billieForum, name: 'Billie Eilish', category: 'concert', venueId: V.forum, primaryEntityId: ENT.billie, localStartAt: at('2026-10-10T03:00:00Z'), saleStatus: 'offsale' },
  // Los Angeles, January 2027 ("the week of Jan 12": Mon Jan 11 to Sun Jan 17), with one game either side
  { id: EV.kingsJan9, name: 'Los Angeles Kings vs. Anaheim Ducks', category: 'nhl', subtype: 'regular_season', venueId: V.crypto, primaryEntityId: ENT.kings, opponentEntityId: ENT.ducks, isHome: true, localStartAt: at('2027-01-10T03:00:00Z') },
  { id: EV.lakersWarriors, name: 'Los Angeles Lakers vs. Golden State Warriors', category: 'nba', subtype: 'regular_season', venueId: V.crypto, primaryEntityId: ENT.lakers, opponentEntityId: ENT.warriors, isHome: true, localStartAt: at('2027-01-13T03:30:00Z') },
  { id: EV.clippersSuns, name: 'Los Angeles Clippers vs. Phoenix Suns', category: 'nba', subtype: 'regular_season', venueId: V.intuit, primaryEntityId: ENT.clippers, opponentEntityId: ENT.suns, isHome: true, localStartAt: at('2027-01-14T03:30:00Z') },
  { id: EV.brunoForum, name: 'Bruno Mars', category: 'concert', venueId: V.forum, primaryEntityId: ENT.bruno, localStartAt: at('2027-01-14T04:00:00Z') },
  { id: EV.kingsDucks, name: 'Los Angeles Kings vs. Anaheim Ducks', category: 'nhl', subtype: 'regular_season', venueId: V.crypto, primaryEntityId: ENT.kings, opponentEntityId: ENT.ducks, isHome: true, localStartAt: at('2027-01-15T03:00:00Z') },
  { id: EV.wickedJan14, name: 'Wicked', category: 'theater', subtype: 'evening', venueId: V.pantages, primaryEntityId: ENT.wicked, localStartAt: at('2027-01-15T04:00:00Z') },
  { id: EV.lakersCeltics, name: 'Los Angeles Lakers vs. Boston Celtics', category: 'nba', subtype: 'regular_season', venueId: V.crypto, primaryEntityId: ENT.lakers, opponentEntityId: ENT.celtics, isHome: true, localStartAt: at('2027-01-16T03:30:00Z') },
  { id: EV.ramsSeahawks, name: 'Los Angeles Rams vs. Seattle Seahawks (Wild Card)', category: 'nfl', subtype: 'playoffs', venueId: V.sofi, primaryEntityId: ENT.rams, opponentEntityId: ENT.seahawks, isHome: true, localStartAt: at('2027-01-16T21:30:00Z') },
  { id: EV.lakersSpurs, name: 'Los Angeles Lakers vs. San Antonio Spurs', category: 'nba', subtype: 'regular_season', venueId: V.crypto, primaryEntityId: ENT.lakers, opponentEntityId: ENT.spurs, isHome: true, localStartAt: at('2027-01-22T03:30:00Z') },
];

/** Seat zones (venue_seat_zones) for the sections the listings use, so "are these good seats" has a reference. */
const ZONES: Record<string, Record<string, string[]>> = {
  [V.msg]: { lower: ['101', '102', '104', '105', '110', '111', '112'], upper: ['209', '210', '211', '213', '214', '220', '224', '225', '227', '310'] },
  [V.barclays]: { lower: ['8', '22', '27'], upper: ['201', '206', '225'] },
  [V.yankee]: { field: ['014', '022'], upper: ['420b', '431'] },
  [V.ubs]: { lower: ['108', '114'], upper: ['203', '211'] },
  [V.citi]: { field: ['114', '120'], upper: ['508', '515'] },
  [V.metlife]: { lower: ['115', '139'], upper: ['317', '340'] },
  [V.rodgers]: { orchestra: ['ORCH C', 'ORCH L'], mezzanine: ['FMEZZ', 'RMEZZ'], balcony: ['BALC'] },
  [V.crypto]: { lower: ['104', '111', '117'], upper: ['301', '312', '326'] },
  [V.dodger]: { field: ['24FD', '30FD'], loge: ['130LG', '146LG'], upper: ['8RS', '14TD'], pavilion: ['306PV'] },
  [V.sofi]: { lower: ['118', '130'], upper: ['432', '445'] },
  [V.intuit]: { lower: ['105', '112'], upper: ['221', '230'] },
  [V.forum]: { floor: ['FLR A'], lower: ['105'], upper: ['217'] },
  [V.pantages]: { orchestra: ['ORCH CTR'], mezzanine: ['MEZZ'] },
};

const fxUrl = (s: string) => `https://example.invalid/fixture/${s}`;
function offer(o: Partial<Offer> & { id: string; eventId: string; quantity: number; payableTotalCents: number | null }): Offer {
  const total = o.payableTotalCents;
  return {
    sourceId: FX.source, providerListingId: o.id, observedAt: FIXTURE_NOW.toISOString(), providerUpdatedAt: null, expiresAt: null, currency: 'USD',
    baseTotalCents: total === null ? null : Math.round(total * 0.82), mandatoryFeeTotalCents: total === null ? null : total - Math.round(total * 0.82),
    taxTotalCents: 0, deliveryTotalCents: 0, priceCompleteness: 'verified_total', section: null, row: null, seatNumbers: null, seatsTogether: true, admissionType: 'reserved',
    restrictions: [], deliveryMethod: 'mobile_transfer', expectedDeliveryAt: null, directPurchaseUrl: fxUrl(o.id), affiliateUrl: null,
    affiliateCommissionBps: 0, evidenceId: `fx-ev-${o.id}`, collectionMode: 'fixture', availability: 'available', ...o,
  };
}
const L = (eventId: string, id: string, quantity: number, dollars: number, seatClass: string, section: string, row: string, extra: Partial<Offer> = {}) =>
  offer({ id, eventId, quantity, payableTotalCents: dollars * 100, seatClass, section, row, ...extra });

/** Listings per event. A fresh copy per run (worldOffers()), so tests can move the market without leaking. */
function baseWorldOffers(): Record<string, Offer[]> {
  const o: Record<string, Offer[]> = {
    [EV.rangersBruins]: [
      L(EV.rangersBruins, 'rb-2-upper-224', 2, 260, 'upper', '224', 'G'),
      L(EV.rangersBruins, 'rb-2-upper-227-obs', 2, 180, 'upper', '227', 'A', { restrictions: ['obstructed_view'] }),
      L(EV.rangersBruins, 'rb-2-lower-105', 2, 540, 'lower', '105', 'M'),
      L(EV.rangersBruins, 'rb-4-upper-225', 4, 520, 'upper', '225', 'D'),
      L(EV.rangersBruins, 'rb-5-upper-211', 5, 640, 'upper', '211', 'B'),
      L(EV.rangersBruins, 'rb-5-upper-211-b', 5, 655, 'upper', '211', 'B', { sourceId: FX.sourceB }),
      L(EV.rangersBruins, 'rb-5-lower-104', 5, 1350, 'lower', '104', 'P'),
      L(EV.rangersBruins, 'rb-5-upper-310-split', 5, 560, 'upper', '310', 'H', { seatsTogether: false }),
    ],
    [EV.rangersDevils]: [L(EV.rangersDevils, 'rd-2-upper-213', 2, 300, 'upper', '213', 'C'), L(EV.rangersDevils, 'rd-5-upper-220', 5, 760, 'upper', '220', 'E')],
    // Over $150 for two.
    [EV.rangersDucks]: [L(EV.rangersDucks, 'rdk-2-upper-312', 2, 290, 'upper', '312', 'H'), L(EV.rangersDucks, 'rdk-2-upper-305', 2, 330, 'upper', '305', 'B')],
    [EV.rangersKings]: [L(EV.rangersKings, 'rk-2-upper-318', 2, 140, 'upper', '318', 'F')],
    [EV.islandersRangers]: [L(EV.islandersRangers, 'ir-2-upper-211', 2, 280, 'upper', '211', 'F'), L(EV.islandersRangers, 'ir-4-lower-114', 4, 900, 'lower', '114', 'K')],
    [EV.knicksCeltics]: [
      L(EV.knicksCeltics, 'kc-2-upper-210', 2, 420, 'upper', '210', 'J'),
      L(EV.knicksCeltics, 'kc-2-lower-102', 2, 1100, 'lower', '102', 'E'),
      L(EV.knicksCeltics, 'kc-4-upper-214', 4, 880, 'upper', '214', 'L'),
      L(EV.knicksCeltics, 'kc-4-upper-209-est', 4, null as unknown as number, 'upper', '209', 'Q', { payableTotalCents: null, baseTotalCents: 64000, mandatoryFeeTotalCents: null, taxTotalCents: null, deliveryTotalCents: null, priceCompleteness: 'incomplete' }),
    ],
    [EV.knicksNets]: [L(EV.knicksNets, 'kn2-2-upper-213', 2, 350, 'upper', '213', 'K')],
    [EV.netsHeat]: [L(EV.netsHeat, 'nh-2-upper-206', 2, 120, 'upper', '206', 'R'), L(EV.netsHeat, 'nh-4-lower-22', 4, 520, 'lower', '22', '9')],
    [EV.metsPhillies]: [L(EV.metsPhillies, 'mp-2-upper-508', 2, 110, 'upper', '508', '4'), L(EV.metsPhillies, 'mp-4-field-120', 4, 640, 'field', '120', '18')],
    [EV.giantsCowboys]: [L(EV.giantsCowboys, 'gc-2-upper-317', 2, 460, 'upper', '317', '12'), L(EV.giantsCowboys, 'gc-4-lower-139', 4, 1720, 'lower', '139', '30')],
    [EV.hamiltonMatinee]: [L(EV.hamiltonMatinee, 'hm-2-orch', 2, 520, 'orchestra', 'ORCH C', 'P'), L(EV.hamiltonMatinee, 'hm-2-mezz', 2, 310, 'mezzanine', 'RMEZZ', 'F')],
    [EV.hamiltonEvening]: [L(EV.hamiltonEvening, 'he-2-orch', 2, 640, 'orchestra', 'ORCH C', 'K'), L(EV.hamiltonEvening, 'he-2-balc', 2, 220, 'balcony', 'BALC', 'C')],
    [EV.dodgersRockies]: [L(EV.dodgersRockies, 'dr-2-upper-8rs', 2, 70, 'upper', '8RS', 'T')],
    [EV.dodgersGiants]: [
      L(EV.dodgersGiants, 'dg-2-upper-14td', 2, 180, 'upper', '14TD', 'M'),
      L(EV.dodgersGiants, 'dg-2-pav-306', 2, 280, 'pavilion', '306PV', 'B'),
      L(EV.dodgersGiants, 'dg-2-field-24fd', 2, 520, 'field', '24FD', 'H'),
      L(EV.dodgersGiants, 'dg-4-loge-146', 4, 760, 'loge', '146LG', 'D'),
    ],
    [EV.kingsJan9]: [L(EV.kingsJan9, 'k9-2-upper-312', 2, 120, 'upper', '312', 'S')],
    [EV.lakersWarriors]: [L(EV.lakersWarriors, 'lw-2-upper-312', 2, 380, 'upper', '312', 'N'), L(EV.lakersWarriors, 'lw-2-lower-111', 2, 1200, 'lower', '111', 'C'), L(EV.lakersWarriors, 'lw-4-upper-326', 4, 820, 'upper', '326', 'J')],
    [EV.clippersSuns]: [L(EV.clippersSuns, 'cs-2-upper-221', 2, 160, 'upper', '221', 'G')],
    [EV.brunoForum]: [L(EV.brunoForum, 'bf-2-upper-217', 2, 340, 'upper', '217', 'H')],
    [EV.kingsDucks]: [L(EV.kingsDucks, 'kd-2-upper-301', 2, 140, 'upper', '301', 'D'), L(EV.kingsDucks, 'kd-4-lower-117', 4, 600, 'lower', '117', 'L')],
    [EV.wickedJan14]: [L(EV.wickedJan14, 'wj-2-orch', 2, 360, 'orchestra', 'ORCH CTR', 'M')],
    [EV.lakersCeltics]: [L(EV.lakersCeltics, 'lc-2-upper-301', 2, 640, 'upper', '301', 'B')],
    [EV.ramsSeahawks]: [L(EV.ramsSeahawks, 'rs-2-upper-432', 2, 520, 'upper', '432', '20')],
    [EV.lakersSpurs]: [L(EV.lakersSpurs, 'ls-2-upper-326', 2, 260, 'upper', '326', 'K')],
  };
  return o;
}

/** A fresh, mutable copy of every listing (base fixtures + eval world) for one thread. */
export function worldOffers(): Record<string, Offer[]> {
  const out: Record<string, Offer[]> = {};
  for (const [k, v] of Object.entries({ ...FIXTURE_OFFERS, ...baseWorldOffers() })) out[k] = v.map((x) => ({ ...x }));
  return out;
}

/** Price history for current events: falling, rising, flat. One event (Lakers vs Warriors) has too little to call. */
/** Each history ends at `asOf`: the clock the scenarios about that event use (see scenarios). */
export const AS_OF = { rangersWeek: '2026-10-19T14:00:00Z', knicksWeek: '2026-10-26T14:00:00Z', dodgersWeek: '2026-09-24T17:00:00Z', laJanuary: '2027-01-04T18:00:00Z' } as const;
const TRENDS: Array<{ eventId: string; quantity: number; zone: string; points: Array<[hoursAgo: number, dollars: number]>; start: string; asOf: string }> = [
  { eventId: EV.rangersBruins, quantity: 2, zone: 'upper', start: '2026-10-22T23:00:00Z', asOf: AS_OF.rangersWeek, points: [[72, 340], [48, 315], [24, 290], [0, 260]] },
  { eventId: EV.rangersBruins, quantity: 5, zone: 'upper', start: '2026-10-22T23:00:00Z', asOf: AS_OF.rangersWeek, points: [[72, 820], [48, 760], [24, 700], [0, 640]] },
  { eventId: EV.knicksCeltics, quantity: 2, zone: 'upper', start: '2026-10-28T23:30:00Z', asOf: AS_OF.knicksWeek, points: [[72, 320], [48, 350], [24, 385], [0, 420]] },
  { eventId: EV.dodgersGiants, quantity: 2, zone: 'upper', start: '2026-10-01T02:10:00Z', asOf: AS_OF.dodgersWeek, points: [[72, 182], [48, 178], [24, 181], [0, 180]] },
  { eventId: EV.lakersWarriors, quantity: 2, zone: 'upper', start: '2027-01-13T03:30:00Z', asOf: AS_OF.laJanuary, points: [[0, 380]] },
  // The Kings game's checked total for two, held from earlier the same day: the price the Ducks reply can offer instead.
  { eventId: EV.rangersKings, quantity: 2, zone: 'upper', start: '2026-11-23T23:00:00Z', asOf: '2026-11-12T14:00:00Z', points: [[0, 140]] },
];

/** Links a customer might paste, mapped to the events they name (event_source_mappings), plus links we don't know. */
export const LINKS = {
  rangersBruinsTm: 'https://www.ticketmaster.com/new-york-rangers-vs-boston-bruins-new-york-new-york-10-22-2026/event/3B00612ACE4F1A2B',
  rangersBruinsStubhub: 'https://www.stubhub.com/new-york-rangers-new-york-tickets-10-22-2026/event/158234567/?quantity=2',
  knicksCelticsSeatgeek: 'https://seatgeek.com/celtics-at-knicks-tickets/10-28-2026-new-york-new-york-madison-square-garden/nba/17345678',
  dodgersGiantsTm: 'https://www.ticketmaster.com/los-angeles-dodgers-vs-san-francisco-giants-los-angeles-california-09-30-2026/event/0B00613BD2C04F9E',
  hamiltonTm: 'https://www.ticketmaster.com/hamilton-new-york-new-york-10-10-2026/event/3B00613FA1B2C3D4',
  unknownEventTm: 'https://www.ticketmaster.com/some-band-new-york-new-york-11-05-2026/event/3B0061FFFFFFFFFF',
  appShareLink: 'https://stubhub.app.link/AbCdEf12345',
} as const;
const MAPPINGS: Array<typeof t.eventSourceMappings.$inferInsert> = [
  { eventId: EV.rangersBruins, sourceId: 'ticketmaster', sourceEventId: '3B00612ACE4F1A2B', authoritativeUrl: LINKS.rangersBruinsTm, role: 'official_primary', confidence: 'verified' },
  { eventId: EV.rangersBruins, sourceId: 'stubhub', sourceEventId: '158234567', authoritativeUrl: LINKS.rangersBruinsStubhub, role: 'marketplace', confidence: 'verified' },
  { eventId: EV.dodgersGiants, sourceId: 'ticketmaster', sourceEventId: '0B00613BD2C04F9E', authoritativeUrl: LINKS.dodgersGiantsTm, role: 'official_primary', confidence: 'verified' },
  { eventId: EV.hamiltonMatinee, sourceId: 'ticketmaster', sourceEventId: '3B00613FA1B2C3D4', authoritativeUrl: LINKS.hamiltonTm, role: 'official_primary', confidence: 'verified' },
];

export async function seedWorld(db: Db): Promise<void> {
  await db.insert(t.venues).values(VENUES).onConflictDoNothing();
  await db
    .insert(t.entities)
    .values(ENTITIES.map((e) => ({ id: e.id, kind: e.kind, name: e.name, slug: e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), aliases: e.kind === 'team' ? teamAliases(e.name) : [], league: e.league ?? null, homeVenueId: e.home ?? null })))
    .onConflictDoNothing();
  // Production's catalog gives a team only its last word as an alias; the base fixtures gave a few more ("NYR").
  // Reset them so nickname tests measure the app's roster list, not the fixture file.
  const baseTeams = await db.select({ id: t.entities.id, name: t.entities.name }).from(t.entities).where(inArray(t.entities.id, [ENT.rangers, ENT.islanders, ENT.knicks, ENT.yankees, ENT.leafs]));
  for (const b of baseTeams) await db.update(t.entities).set({ aliases: teamAliases(b.name) }).where(eq(t.entities.id, b.id));
  await db.insert(t.events).values(EVENTS.map((e) => ({ status: 'scheduled', ...e, verifiedSourceId: 'fixture', isFixture: true }))).onConflictDoNothing();
  const zones = Object.entries(ZONES).flatMap(([venueId, byZone]) => Object.entries(byZone).flatMap(([zone, sections]) => sections.map((section) => ({ venueId, layoutVersion: 'v2024', section, zone, evidence: 'eval-fixture', reviewedBy: 'seed' }))));
  await db.insert(t.venueSeatZones).values(zones).onConflictDoNothing();
  const snaps: Array<typeof t.marketSnapshots.$inferInsert> = [];
  for (const tr of TRENDS) {
    const basketKey = basketKeyFor(tr.eventId, tr.quantity, tr.zone);
    for (const [hAgo, dollars] of tr.points) {
      const observedAt = new Date(new Date(tr.asOf).getTime() - hAgo * 3_600_000);
      snaps.push({ datasetId: null, eventId: tr.eventId, basketKey, quantity: tr.quantity, seatZone: tr.zone, observedAt, leadTimeMinutes: Math.round((new Date(tr.start).getTime() - observedAt.getTime()) / 60_000), cheapestEligibleTotalCents: dollars * 100, eligibleOptionCount: 3, sourceIds: [FX.source], feeBasis: 'verified_total', coverageComplete: true, qualityFlags: [`cheapest_source:${FX.source}`], methodVersion: 'fixture', isFixture: true });
    }
  }
  await db.insert(t.marketSnapshots).values(snaps).onConflictDoNothing();
  await db.insert(t.eventSourceMappings).values(MAPPINGS).onConflictDoNothing();
  await seedPreviewImages(db);
}

/**
 * Every eval-world event has the provider image production keeps at catalog sync (#179), already copied: a plain
 * 600x338 JPEG in a colour of its own, so the preview card is exercised with no network call.
 */
async function seedPreviewImages(db: Db): Promise<void> {
  const ids = [...new Set(Object.values(EV))];
  const events = await db.select({ id: t.events.id, name: t.events.name }).from(t.events).where(inArray(t.events.id, ids));
  for (const [i, e] of events.entries()) {
    const assetId = uid(900 + i);
    const shade = (i * 47) % 200;
    const bytes = await sharp({ create: { width: 600, height: 338, channels: 3, background: { r: 20 + shade, g: 60, b: 120 } } }).jpeg({ quality: 70 }).toBuffer();
    await db.insert(t.brandAssets).values({ id: assetId, kind: 'event', key: eventAssetKey(e.id), name: e.name, imageUrl: `https://s1.ticketm.net/dam/eval/${e.id}_16_9.jpg`, imageKind: 'photo', imageWidth: 1024, imageHeight: 576, source: 'ticketmaster', rights: 'provider_terms', sourceUrl: `https://www.ticketmaster.com/event/eval-${i}` }).onConflictDoNothing();
    await db.insert(t.previewImages).values({ assetId, mimeType: 'image/jpeg', width: 600, height: 338, bytes: new Uint8Array(bytes), sourceImageUrl: `https://s1.ticketm.net/dam/eval/${e.id}_16_9.jpg` }).onConflictDoNothing();
  }
}
