import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';

/**
 * Research 1 discovery regression (Oct 1 2026, build 9eb3679): the catalog the three live conversations saw, as
 * far as the captured emails show it. Event names, venues, dates and genres are copied from those replies;
 * start times are typical evening times. Nothing here asserts real availability, seats or prices.
 */
const id = (n: number) => `7e200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const D = {
  v: { moody: id(1), bass: id(2), stubbs: id(3), mohawk: id(4), elsewhere: id(5), greek: id(6), moroccan: id(7), constellation: id(8), basement: id(9) },
};

export async function seedDiscovery(h: DbHandle) {
  const V = D.v;
  const CT = 'America/Chicago';
  const PT = 'America/Los_Angeles';
  await h.db.insert(t.venues).values([
    { id: V.moody, name: 'Moody Center ATX', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: CT, latitude: 30.2818, longitude: -97.7323 },
    { id: V.bass, name: 'Bass Concert Hall', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: CT, latitude: 30.2858, longitude: -97.7314 },
    { id: V.stubbs, name: 'Stubb’s Waller Creek Amphitheater', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: CT, latitude: 30.2683, longitude: -97.7361 },
    { id: V.mohawk, name: 'Mohawk Austin', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: CT, latitude: 30.2701, longitude: -97.7362 },
    { id: V.elsewhere, name: 'Elsewhere', aliases: [], city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7094, longitude: -73.9232 },
    { id: V.basement, name: 'Brooklyn Basement', aliases: [], city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7128, longitude: -73.9363 },
    { id: V.greek, name: 'Greek Theatre', aliases: [], city: 'Los Angeles', state: 'CA', country: 'US', timezone: PT, latitude: 34.1197, longitude: -118.2965 },
    { id: V.moroccan, name: 'The Moroccan Lounge', aliases: [], city: 'Los Angeles', state: 'CA', country: 'US', timezone: PT, latitude: 34.0478, longitude: -118.2341 },
    { id: V.constellation, name: 'Constellation Room', aliases: [], city: 'Santa Ana', state: 'CA', country: 'US', timezone: PT, latitude: 33.7455, longitude: -117.8677 },
  ]);
  const dusky = id(50);
  await h.db.insert(t.entities).values({ id: dusky, kind: 'performer', name: 'Dusky', slug: 'r1d-dusky' });
  let n = 100;
  const ev = (name: string, genre: string, venueId: string, start: string, category = 'concert', entity: string | null = null): typeof t.events.$inferInsert => ({ id: id(n++), name, category, genre, venueId, primaryEntityId: entity, localStartAt: new Date(start), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
  const rows = [
    // Austin: nothing country on Fri Oct 2 or Sat Oct 3 (a rock show the Saturday); country from Oct 7 on.
    ev('Late Static', 'rock / alternative rock', V.mohawk, '2026-10-04T01:00:00Z'),
    ev('Kacey Musgraves - Middle of Nowhere Tour', 'country / country', V.moody, '2026-10-08T00:30:00Z'),
    ev('Kacey Musgraves - Middle of Nowhere Tour', 'country / country', V.moody, '2026-10-09T00:30:00Z'),
    ev('THE CHICKS - TAKING THE LONG WAY', 'country / country', V.bass, '2026-10-21T00:30:00Z'),
    ev('Cameron Whitcomb - Kingdom of Fear Tour', 'country / country', V.stubbs, '2026-10-24T00:30:00Z'),
    // Brooklyn: Dusky at Elsewhere, Friday Oct 2, 10:30pm; another house night on the Saturday elsewhere in Brooklyn.
    ev('Dusky - 21+', 'dance/electronic / house', V.elsewhere, '2026-10-03T02:30:00Z', 'electronic_nightlife', dusky),
    ev('Night Shift: Deep House', 'dance/electronic / house', V.basement, '2026-10-04T03:00:00Z', 'electronic_nightlife'),
    // Los Angeles: Fri Oct 9 two in the city and one in Santa Ana; Sat Oct 10 one in the city.
    ev('for KING & COUNTRY', 'pop / pop', V.greek, '2026-10-10T02:30:00Z'),
    ev('Parrotfish', 'pop / indie pop', V.moroccan, '2026-10-10T03:00:00Z'),
    ev('Lilyisthatyou - The Flowers Have Feelings Tour', 'pop / pop', V.constellation, '2026-10-10T03:00:00Z'),
    ev('Rachel Bochner: The "Sorry If It\'s Selfish" Tour', 'pop / pop', V.moroccan, '2026-10-11T03:00:00Z'),
  ];
  await h.db.insert(t.events).values(rows);
  for (const r of rows) await h.db.insert(t.eventSourceMappings).values({ eventId: r.id!, sourceId: 'ticketmaster', sourceEventId: `D${r.id!.slice(-6)}`, authoritativeUrl: `https://www.ticketmaster.com/event/D${r.id!.slice(-6)}`, role: 'discovery', confidence: 'provider_id' });
}
