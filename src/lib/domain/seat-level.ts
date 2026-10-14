/**
 * The level of the building a buyer asks for ("lower bowl please", "upper deck is fine", "100 level"), and which level
 * an offer is in. Kept apart from the area words in listing-evidence (floor, balcony, mezzanine): "lower" and "upper"
 * alone are never a level ("a lower price"), only with the word that makes them one.
 */
export type SeatLevel = 'lower' | 'upper';

const LOWER = /\blower\s+(?:bowl|level|deck|tier|sections?|seats?)\b|\b100s?(?:\s*-?\s*level|\s+sections?)\b|\b(?:plaza|field)\s+level\b/i;
const UPPER = /\bupper\s+(?:bowl|level|deck|tier|sections?|seats?)\b|\b[23]00s?(?:\s*-?\s*level|\s+sections?)\b|\bnosebleeds?\b/i;
/** "Lower bowl is fine", "upper deck if needed": acceptable, not wanted. */
const SOFT = /\b(?:is|are|would be|'s)\s+(?:fine|ok|okay)\b|\bif (?:needed|necessary|we have to)\b|\bdon'?t (?:need|mind)\b|\beither\b/i;

/** The level they want, or null. The last level named in a clause that wants it wins; a soft mention is not a want. */
export function seatLevelWanted(text: string | null | undefined): SeatLevel | null {
  let want: SeatLevel | null = null;
  for (const clause of (text ?? '').replace(/[’‘]/g, "'").split(/[.!?;\n,]+|\bbut\b/i)) {
    if (SOFT.test(clause) || /\b(?:no|not|avoid|anything but)\b/i.test(clause)) continue;
    if (LOWER.test(clause)) want = 'lower';
    if (UPPER.test(clause)) want = 'upper';
  }
  return want;
}

/** The offer's level from its seat class ("lower", "Upper Level"), else its section number (100s lower; 200s-300s upper). */
export function seatLevelOf(o: { seatClass?: string | null; section?: string | null }): SeatLevel | null {
  const c = (o.seatClass ?? '').toLowerCase();
  if (/\blower\b|\bplaza\b|\bfield\b/.test(c)) return 'lower';
  if (/\bupper\b|\bbalcony\b|\bterrace\b/.test(c)) return 'upper';
  const n = /^\D*(\d{3})\b/.exec(o.section ?? '');
  if (!n) return null;
  const s = Number(n[1]);
  return s >= 100 && s < 200 ? 'lower' : s >= 200 && s < 400 ? 'upper' : null;
}
