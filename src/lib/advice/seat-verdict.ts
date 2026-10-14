import { and, eq, inArray } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import type { Offer } from '@/lib/domain/types';
import { formatUsd } from '@/lib/domain/money';

/**
 * "Are these good seats?" (#149): a verdict on the seats they named, first: where they are (the level from the venue's
 * seat zones, the row), and what they cost against the other seats checked for the same party. Never a judgment of a
 * section the zones don't place.
 */
export const GOOD_SEATS_ASKED = /\b(?:are|r|is) (?:these|those|they|this|it|that|them)\s+(?:any\s+)?(?:good|decent|great|ok|okay|bad)\b|\bgood seats?\b|\bany good\b|\bhow (?:good )?(?:are|is) (?:the|these|those) (?:seats?|view)\b/i;

/** "Section 224 row G", "sec 224 row g", "sect. 105, row 12". */
export function sectionAndRow(text: string): { section: string; row: string | null } | null {
  const s = /\bsec(?:t(?:ion)?)?\.?\s*([a-z]{0,4}\s?\d{1,3}[a-z]?)\b/i.exec(text);
  if (!s) return null;
  const r = /\brow\s+([a-z]{1,2}|\d{1,2})\b/i.exec(text.slice(s.index));
  return { section: s[1]!.toUpperCase().replace(/\s+/g, ' '), row: r ? r[1]!.toUpperCase() : null };
}

const PREMIUM = new Set(['lower', 'floor', 'field', 'orchestra', 'club', 'courtside', 'plaza']);
const MIDDLE = new Set(['mezzanine', 'loge', 'dress circle']);
const LEVEL_WORDS: Record<string, string> = { lower: 'the lower bowl', upper: 'the upper level', floor: 'the floor', field: 'the field level', orchestra: 'the orchestra', mezzanine: 'the mezzanine', balcony: 'the balcony', loge: 'the loge level', terrace: 'the terrace level', pavilion: 'the pavilion' };
const level = (zone: string) => LEVEL_WORDS[zone] ?? `the ${zone} level`;
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];

function rowNote(row: string | null): string {
  if (!row) return '';
  const n = /^[A-Z]$/.test(row) ? row.charCodeAt(0) - 64 : /^\d+$/.test(row) ? Number(row) : null;
  return n && n <= ORDINALS.length ? `, row ${row} (the ${ORDINALS[n - 1]} row of that section)` : `, row ${row}`;
}

export type SeatVerdictInput = {
  section: string;
  row: string | null;
  /** The zone of their section, when the venue's zones (or the listing) place it. */
  zone: string | null;
  quantity: number;
  /** What their seats cost in total, when known (the matching listing, or the price they gave). */
  theirTotalCents: number | null;
  /** Other seats checked for the same party, with their zone and comparable total. */
  others: Array<{ zone: string | null; section: string | null; totalCents: number }>;
  venueName: string;
};

/** The verdict line, or null when their section isn't placed (no zone on file): never a guess about where it is. */
export function seatVerdict(i: SeatVerdictInput): string | null {
  if (!i.zone) return null;
  const zone = i.zone.toLowerCase();
  const where = `Section ${i.section}${rowNote(i.row)} is in ${level(zone)} at ${i.venueName}`;
  const pair = i.quantity === 2 ? 'two' : i.quantity === 1 ? 'one' : String(i.quantity);
  const others = i.others.filter((o) => !(o.section && o.section.toUpperCase() === i.section && (i.theirTotalCents === null || o.totalCents === i.theirTotalCents)));
  const sameZone = others.filter((o) => o.zone?.toLowerCase() === zone).sort((a, b) => a.totalCents - b.totalCents);
  const better = others.filter((o) => o.zone && PREMIUM.has(o.zone.toLowerCase()) && !PREMIUM.has(zone)).sort((a, b) => a.totalCents - b.totalCents)[0];
  const cheaperSame = i.theirTotalCents !== null ? sameZone.find((o) => o.totalCents < i.theirTotalCents!) : undefined;
  const verdict = PREMIUM.has(zone)
    ? cheaperSame ? 'Good seats, but not the best price for them' : 'Good seats'
    : MIDDLE.has(zone)
      ? 'Solid seats'
      : cheaperSame ? 'Not great seats, and not the cheapest of their kind' : i.theirTotalCents !== null ? 'Good value, but not great seats' : 'Not great seats';
  const parts = [`${verdict}: ${where}.`];
  if (i.theirTotalCents !== null) {
    if (cheaperSame) parts.push(`There’s a cheaper set in ${level(zone)}: section ${cheaperSame.section ?? 'unlisted'} for ${formatUsd(cheaperSame.totalCents)} for ${pair}, against ${formatUsd(i.theirTotalCents)}.`);
    else if (sameZone.length || others.length) parts.push(`At ${formatUsd(i.theirTotalCents)} for ${pair}, nothing in ${level(zone)} I checked is cheaper.`);
  }
  if (better) parts.push(`${level(better.zone!.toLowerCase()).replace(/^./, (c) => c.toUpperCase())} starts at ${formatUsd(better.totalCents)} for ${pair}${better.section ? ` (section ${better.section})` : ''}${i.theirTotalCents !== null && better.totalCents > i.theirTotalCents ? `, ${formatUsd(better.totalCents - i.theirTotalCents)} more` : ''}.`);
  return parts.join(' ');
}

/**
 * The verdict for the seats named in their message: their section's zone from the listing or the venue's seat zones,
 * their price from the matching listing or the one they gave, against the other listings checked for the party.
 */
export async function seatVerdictFor(db: DbHandle['db'], a: { text: string; venue: { id: string; name: string; layoutVersion: string | null }; quantity: number; offers: Array<{ offer: Offer; comparableTotalCents: number | null }>; quotedTotalCents: number | null }): Promise<string | null> {
  if (!GOOD_SEATS_ASKED.test(a.text)) return null;
  const named = sectionAndRow(a.text);
  if (!named) return null;
  const sections = [...new Set([named.section, ...a.offers.map((o) => o.offer.section?.toUpperCase()).filter((s): s is string => !!s)])];
  const zones = a.venue.layoutVersion
    ? await db.select({ section: t.venueSeatZones.section, zone: t.venueSeatZones.zone }).from(t.venueSeatZones).where(and(eq(t.venueSeatZones.venueId, a.venue.id), eq(t.venueSeatZones.layoutVersion, a.venue.layoutVersion), eq(t.venueSeatZones.status, 'active'), inArray(t.venueSeatZones.section, sections)))
    : [];
  const zoneOf = (section: string | null | undefined, seatClass?: string | null) => (section ? zones.find((z) => z.section.toUpperCase() === section.toUpperCase())?.zone : undefined) ?? seatClass ?? null;
  const priced = a.offers.filter((o) => o.comparableTotalCents !== null && o.offer.quantity === a.quantity);
  const theirs = priced.find((o) => o.offer.section?.toUpperCase() === named.section && (!named.row || o.offer.row?.toUpperCase() === named.row));
  return seatVerdict({
    section: named.section,
    row: named.row,
    zone: zoneOf(named.section, theirs?.offer.seatClass),
    quantity: a.quantity,
    theirTotalCents: theirs?.comparableTotalCents ?? a.quotedTotalCents,
    others: priced.filter((o) => o !== theirs).map((o) => ({ zone: zoneOf(o.offer.section, o.offer.seatClass), section: o.offer.section ?? null, totalCents: o.comparableTotalCents! })),
    venueName: a.venue.name,
  });
}
