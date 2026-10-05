/**
 * Venues that sell most of their nights outside the official listings we read (Ticketmaster), with their own
 * calendar. Live Oct 5: "What shows are happening at Elsewhere next week?" got "There's one on: … Slow Magic", while
 * elsewhere.club/events listed a full week of nights sold through its own site. A venue question about one of these
 * says how much we can see and links its calendar; we read nothing from it.
 *
 * Only calendars opened and checked by a person are listed (as with RA_EVENT_PAGES): a wrong link is worse than none.
 */
export type VenueCalendar = { name: string; url: string; sells: string };

const CALENDARS: Array<{ match: RegExp; calendar: VenueCalendar }> = [
  // Checked Oct 5 2026 (owner): club and live rooms, tickets through Elsewhere's own site.
  { match: /\belsewhere\b/i, calendar: { name: 'Elsewhere', url: 'https://www.elsewhere.club/events', sells: 'its own site' } },
];

export function venueCalendar(terms: readonly string[] | null | undefined): VenueCalendar | null {
  for (const term of terms ?? []) {
    const hit = CALENDARS.find((c) => c.match.test(term));
    if (hit) return hit.calendar;
  }
  return null;
}
