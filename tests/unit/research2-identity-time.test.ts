import { describe, expect, it } from 'vitest';
import { buildPacket, listingCatches, type BuildPacketArgs, type SubjectListing } from '@/lib/advice/packet';
import { renderEvidenceOnly } from '@/lib/advice/renderer';
import { deadlineInstant, localTimeInstants } from '@/lib/domain/dates';
import { teamNickname } from '@/lib/intake/pipeline';

/**
 * Research2 post-deploy (Oct 1 2026) local controls, rebuilt from LOCAL_IDENTITY_CONTROLS.json and
 * PAIR_2_TIME.json / TIME_ORACLE.json.
 */
const NOW = new Date('2026-09-30T23:15:00Z');
const AT = new Date('2026-10-17T23:00:00Z');
const args = (subject: SubjectListing, identity: BuildPacketArgs['eventIdentity'] = { names: ['QA Example Artist', 'QA Example Artist'], nicknames: [], venueNames: ['Test Room A'], city: 'New York' }) => ({
  requestId: 'identity-local', revision: 1, quantity: 2,
  eventLabel: 'QA Example Artist at Test Room A, New York, October 17, 2026, 7:00 PM EDT',
  eventLocalDate: '2026-10-17', eventStartAt: AT, timeZone: 'America/New_York', eventNoun: 'show', eventIdentity: identity,
  best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'qa' },
  priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 30000, togetherRequired: true },
  sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: NOW, evidenceExpiresAt: null, basketKey: 'qa', watchConsentReference: null, isFixture: true, market: null,
  subject,
}) as unknown as BuildPacketArgs;
const listing = (over: Partial<SubjectListing> = {}) => ({
  source: 'listing_text', observedAt: NOW, confidence: 'high', seller: 'Example seller',
  eventName: 'QA Example Artist', eventDate: '2026-10-17', eventTime: '19:00', venue: 'Test Room A', city: 'New York', quantity: 2,
  priceText: '$250 total including fees', perTicketCents: 12500, wholePartyCents: 25000, priceBasis: 'whole_party', feeBasis: 'all_in',
  section: '101', row: 'A', seatNumbers: ['1', '2'], seatsTogether: true, restrictions: [], restrictionCodes: [],
  deliveryText: 'Mobile transfer by October 16', deliveryBy: '2026-10-16', includedBenefits: [], unreadable: [], ...over,
}) as SubjectListing;
const catches = (over: Partial<SubjectListing>, identity?: BuildPacketArgs['eventIdentity']) => { const a = args(listing(over), identity); return listingCatches(a, a.subject!); };
const reply = (over: Partial<SubjectListing>) => renderEvidenceOnly(buildPacket(args(listing(over)))).textBody;

describe('R2-IDENTITY-01: a listing for another performer, city or venue is called out', () => {
  it('I00: the exact listing raises no identity catch', () => {
    expect(catches({})).toEqual([]);
  });
  it('I01: a wrong date still does', () => {
    expect(catches({ eventDate: '2026-10-18' })[0]).toMatch(/isn’t the date I have/);
  });
  it('I02: a wrong artist is the first catch, and the reply says not to buy it as it stands', () => {
    expect(catches({ eventName: 'Another Artist' })[0]).toBe('The listing is for Another Artist, not QA Example Artist. Make sure it’s the right show.');
    expect(reply({ eventName: 'Another Artist' })).toMatch(/Another Artist, not QA Example Artist/);
    expect(reply({})).not.toMatch(/not QA Example Artist/);
  });
  it('I03: a wrong city', () => {
    expect(catches({ city: 'Denver' })).toContain('The listing says Denver, but this show is in New York. Make sure it’s the right show.');
  });
  it('I04: a wrong venue', () => {
    expect(catches({ venue: 'Test Room B' })).toContain('The listing says Test Room B, but this show is at Test Room A. Make sure it’s the right show.');
  });
  // R2-IDENTITY-LEAD-02: a wrong city or room leads the reply, as a wrong date or artist does, never "can't compare its price".
  it.each([
    ['artist', { eventName: 'Another Artist' }, 'I wouldn’t buy this one as it stands: it’s for Another Artist, not QA Example Artist. If that’s the show you want, tell me and I’ll look at that one instead.'],
    ['city', { city: 'Denver' }, 'I wouldn’t buy this one as it stands: it says Denver, but this show is in New York. If that’s the show you want, tell me and I’ll look at that one instead.'],
    ['venue', { venue: 'Test Room B' }, 'I wouldn’t buy this one as it stands: it says Test Room B, but this show is at Test Room A. If that’s the show you want, tell me and I’ll look at that one instead.'],
  ])('the wrong %s is the verdict', (_label, over, verdict) => {
    expect(reply(over)).toContain(verdict);
    expect(reply(over)).not.toContain('I can’t compare its price');
  });
  it('the exact listing keeps its ordinary verdict, and a wrong date says no more than before', () => {
    expect(reply({})).not.toMatch(/I wouldn’t buy this one|look at that one instead/);
    expect(reply({ eventDate: '2026-10-18' })).not.toContain('look at that one instead');
  });

  // The other side: a right listing written differently is not a wrong one.
  const rangers = { names: ['New York Rangers', 'NYR', 'Boston Bruins', 'New York Rangers vs. Boston Bruins'], nicknames: ['Rangers', 'Bruins'], venueNames: ['Madison Square Garden', 'MSG'], city: 'New York' };
  const qa = undefined;
  const game = { eventName: 'New York Rangers vs. Boston Bruins', venue: 'Madison Square Garden' };
  it.each([
    ['a matchup by nicknames', rangers, { ...game, eventName: 'Bruins at Rangers' }],
    ['a venue alias', rangers, { ...game, venue: 'MSG' }],
    ['a tour name after the artist', qa, { eventName: 'QA Example Artist: The Big Tour 2026' }],
    ['accents and case', qa, { eventName: 'qa exámple ARTIST' }],
    ['a borough for the city', qa, { city: 'Manhattan' }],
    ['a city with its state', qa, { city: 'New York, NY' }],
    ['NYC', qa, { city: 'NYC' }],
    ['Saint for St.', { ...rangers, city: 'St. Louis' }, { ...game, city: 'Saint Louis' }],
  ])('no false catch for %s', (_label, identity, over) => {
    expect(catches(over, identity).filter((c) => /, not |The listing says/.test(c))).toEqual([]);
  });
  it('a borough’s arena listed as New York is the same city', () => {
    expect(catches({ venue: 'Barclays Center', city: 'New York' }, { names: ['Brooklyn Nets'], nicknames: ['Nets'], venueNames: ['Barclays Center'], city: 'Brooklyn' }).filter((c) => /says/.test(c))).toEqual([]);
  });
  it('without the event’s identity nothing is compared', () => {
    expect(catches({ eventName: 'Another Artist', city: 'Denver' }, null)).toEqual([]);
  });
  it('team nicknames', () => {
    expect(teamNickname('New York Rangers')).toBe('Rangers');
    expect(teamNickname('Boston Red Sox')).toBe('Red Sox');
    expect(teamNickname('Toronto Maple Leafs')).toBe('Leafs');
  });
});

describe('R2-TIME-FOLD-01: a local time keeps both instants when the clock repeats it', () => {
  // TIME_ORACLE.json: Python zoneinfo, both folds round-tripped.
  it.each([
    ['America/Los_Angeles', '2026-10-17', '23:30', ['2026-10-18T06:30:00.000Z']],
    ['America/Los_Angeles', '2026-11-01', '01:30', ['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z']],
    ['America/Phoenix', '2026-11-01', '01:30', ['2026-11-01T08:30:00.000Z']],
    ['Pacific/Honolulu', '2026-11-01', '01:30', ['2026-11-01T11:30:00.000Z']],
    ['Europe/London', '2026-10-25', '01:30', ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']],
  ])('%s %s %s', (zone, date, time, expected) => {
    expect(localTimeInstants(date, time, zone).map((d) => d.toISOString())).toEqual(expected);
  });
  it('a skipped time has no instant; a deadline in it moves past the jump', () => {
    expect(localTimeInstants('2027-03-14', '02:30', 'America/Los_Angeles')).toEqual([]);
    expect(deadlineInstant('2027-03-14', '02:30', 'America/Los_Angeles').toISOString()).toBe('2027-03-14T10:30:00.000Z');
  });
  it('a deadline at a repeated time is its first occurrence, so it is never later than meant', () => {
    expect(deadlineInstant('2026-11-01', '01:30', 'America/Los_Angeles').toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });
});
