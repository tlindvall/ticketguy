import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';

/**
 * Research 1 (structured testing, prepared Sep 30): the three historical two-turn conversations, rebuilt as a
 * local catalog. Synthetic events only, named for the scenario; nothing here asserts real availability.
 */
const id = (n: number) => `7e100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const R1 = {
  v: { spoke: id(1), stubbs: id(2), acl: id(3), kingdom: id(4), elsewhere: id(5), constellation: id(6), wiltern: id(7), bowl: id(8), greek: id(9) },
  e: { crockett: id(101), rock: id(102), pop: id(103), neon: id(104), dusky: id(105), indie: id(106), huron: id(107), laufey: id(108), greekSat: id(109), crockettSat: id(110) },
  ent: { crockett: id(201), rock: id(202), pop: id(203), neon: id(204), dusky: id(205), indie: id(206), huron: id(207), laufey: id(208), greek: id(209) },
};

export async function seedR1(h: DbHandle, opts: { saturdayCountry?: boolean } = {}) {
  const V = R1.v;
  await h.db.insert(t.venues).values([
    { id: V.spoke, name: 'Broken Spoke', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: 'America/Chicago', latitude: 30.2411, longitude: -97.7842 },
    { id: V.stubbs, name: 'Stubb’s Waller Creek Amphitheater', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: 'America/Chicago', latitude: 30.2683, longitude: -97.7361 },
    { id: V.acl, name: 'ACL Live at The Moody Theater', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: 'America/Chicago', latitude: 30.2654, longitude: -97.7472 },
    { id: V.kingdom, name: 'Kingdom', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: 'America/Chicago', latitude: 30.2671, longitude: -97.7392 },
    { id: V.elsewhere, name: 'Elsewhere', aliases: [], city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7094, longitude: -73.9232 },
    { id: V.constellation, name: 'Constellation Room', aliases: [], city: 'Santa Ana', state: 'CA', country: 'US', timezone: 'America/Los_Angeles', latitude: 33.7455, longitude: -117.8677 },
    { id: V.wiltern, name: 'The Wiltern', aliases: [], city: 'Los Angeles', state: 'CA', country: 'US', timezone: 'America/Los_Angeles', latitude: 34.0617, longitude: -118.3087 },
    { id: V.bowl, name: 'Hollywood Bowl', aliases: [], city: 'Los Angeles', state: 'CA', country: 'US', timezone: 'America/Los_Angeles', latitude: 34.1122, longitude: -118.3391 },
    { id: V.greek, name: 'Greek Theatre', aliases: [], city: 'Los Angeles', state: 'CA', country: 'US', timezone: 'America/Los_Angeles', latitude: 34.1197, longitude: -118.2965 },
  ]);
  const E = R1.ent;
  await h.db.insert(t.entities).values([
    { id: E.crockett, kind: 'performer', name: 'Prairie Lanterns', slug: 'r1-prairie-lanterns' },
    { id: E.rock, kind: 'performer', name: 'Voltage Saints', slug: 'r1-voltage-saints' },
    { id: E.pop, kind: 'performer', name: 'Glitter Theory', slug: 'r1-glitter-theory' },
    { id: E.neon, kind: 'performer', name: 'Neon Pulse', slug: 'r1-neon-pulse' },
    { id: E.dusky, kind: 'performer', name: 'Dusky', slug: 'r1-dusky' },
    { id: E.indie, kind: 'performer', name: 'Paper Coast', slug: 'r1-paper-coast' },
    { id: E.huron, kind: 'performer', name: 'Harbor Lights', slug: 'r1-harbor-lights' },
    { id: E.laufey, kind: 'performer', name: 'Velvet Hours', slug: 'r1-velvet-hours' },
    { id: E.greek, kind: 'performer', name: 'Canyon Choir', slug: 'r1-canyon-choir' },
  ]);
  const ev = (eid: string, name: string, category: string, genre: string, venueId: string, entityId: string, start: string): typeof t.events.$inferInsert => ({ id: eid, name, category, genre, venueId, primaryEntityId: entityId, localStartAt: new Date(start), status: 'scheduled', verifiedSourceId: 'fixture', isFixture: false, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-06-01T15:00:00Z') });
  await h.db.insert(t.events).values([
    // Austin: one country show, on the Friday only; the Saturday has rock, pop and electronic.
    ev(R1.e.crockett, 'Prairie Lanterns', 'concert', 'country / americana', V.spoke, E.crockett, '2026-10-10T01:00:00Z'),
    ev(R1.e.rock, 'Voltage Saints', 'concert', 'rock / hard rock', V.stubbs, E.rock, '2026-10-11T01:00:00Z'),
    ev(R1.e.pop, 'Glitter Theory', 'concert', 'pop / pop', V.acl, E.pop, '2026-10-11T01:30:00Z'),
    ev(R1.e.neon, 'Neon Pulse', 'electronic_nightlife', 'dance/electronic / house', V.kingdom, E.neon, '2026-10-11T03:00:00Z'),
    ...(opts.saturdayCountry ? [ev(R1.e.crockettSat, 'Prairie Lanterns (Night 2)', 'concert', 'country / americana', V.spoke, E.crockett, '2026-10-11T01:00:00Z')] : []),
    // Brooklyn: Dusky, Friday 10:30pm. Start time only: no last-entry time on file.
    ev(R1.e.dusky, 'Dusky', 'electronic_nightlife', 'dance/electronic / house', V.elsewhere, E.dusky, '2026-10-03T02:30:00Z'),
    // LA: Saturday has an Orange County show (Constellation Room, Santa Ana) and two in Los Angeles; Friday one.
    ev(R1.e.indie, 'Paper Coast', 'concert', 'rock / indie rock', V.constellation, E.indie, '2026-10-11T03:00:00Z'),
    ev(R1.e.huron, 'Harbor Lights', 'concert', 'rock / folk rock', V.wiltern, E.huron, '2026-10-11T03:00:00Z'),
    ev(R1.e.greekSat, 'Canyon Choir', 'concert', 'pop / indie pop', V.greek, E.greek, '2026-10-11T02:30:00Z'),
    ev(R1.e.laufey, 'Velvet Hours', 'concert', 'pop / jazz pop', V.bowl, E.laufey, '2026-10-10T03:00:00Z'),
  ]);
  for (const [eventId, slug] of [[R1.e.dusky, 'Z7r9jZ1A7PU4M'], [R1.e.crockett, 'R1CROCKETT'], [R1.e.huron, 'R1HURON'], [R1.e.greekSat, 'R1GREEK'], [R1.e.indie, 'R1INDIE'], [R1.e.laufey, 'R1LAUFEY'], [R1.e.rock, 'R1ROCK'], [R1.e.pop, 'R1POP'], [R1.e.neon, 'R1NEON']] as const) {
    await h.db.insert(t.eventSourceMappings).values({ eventId, sourceId: 'ticketmaster', sourceEventId: slug, authoritativeUrl: `https://www.ticketmaster.com/event/${slug}`, role: 'discovery', confidence: 'provider_id' });
  }
  void eq;
}
