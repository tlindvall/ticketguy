import { spellWeekdays } from '@/lib/domain/dates';

/**
 * What a follow-up says that the reply has to answer before anything else (#177): a correction of what kind of event
 * it is ("it's a concert, not a game"), and "which date, Thursday the 19th or Saturday the 21st?". Without these the
 * official-sale reply went out again word for word.
 */

const KINDS = 'game|match|concert|show|gig|play|musical|comedy show|festival|tour';

/** "It's not a game, it's a concert", "a concert, not a game": what they said it is and what it isn't. */
export function kindCorrection(text: string): { is: string; not: string } | null {
  const t = text.replace(/[’‘]/g, "'").toLowerCase();
  const not = new RegExp(`\\b(?:not|isn't|is not|wasn't|ain't)\\s+(?:a|an)\\s+(${KINDS})\\b`).exec(t)?.[1];
  const is = new RegExp(`\\b(?:it's|its|it is|this is|that's|thats|that is)\\s+(?:a|an)\\s+(${KINDS})\\b`).exec(t)?.[1];
  if (!not || !is || not === is) return null;
  return { is, not };
}

export function kindCorrectionLine(c: { is: string; not: string }): string {
  return `You’re right: it’s a ${c.is}, not a ${c.not}.`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The calendar days a message names ("Thursday Nov 19 or Saturday Nov 21", "the 19th or the 21st" beside a month). */
export function daysNamed(text: string, receivedAt: Date): string[] {
  const t = spellWeekdays(text.toLowerCase());
  const y = receivedAt.getUTCFullYear();
  const out = new Set<string>();
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    const mon = MONTHS.indexOf(m[1]!) + 1;
    const day = Number(m[2]);
    if (day < 1 || day > 31) continue;
    // A month already well past this year is next year's.
    const year = Date.UTC(y, mon - 1, day) < receivedAt.getTime() - 30 * 86_400_000 ? y + 1 : y;
    out.add(`${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return [...out];
}

/** Weekdays named without a date ("Thursday or Saturday?"). */
export function weekdaysNamed(text: string): string[] {
  const t = spellWeekdays(text.toLowerCase());
  return WEEKDAYS.filter((d) => new RegExp(`\\b${d}\\b|\\b${d.slice(0, 3)}\\b`).test(t));
}

/** A question about which date ("which show, Thursday or Saturday?", "is it the 19th or the 21st?"). */
export function asksWhichDate(text: string, receivedAt: Date): boolean {
  const t = text.toLowerCase();
  const two = daysNamed(text, receivedAt).length >= 2 || weekdaysNamed(text).length >= 2;
  return two && (/\?|\bwhich\b|\bwhat (?:day|date)\b/.test(t) || /\bor\b/.test(t));
}

export type HeldDate = { localDate: string; weekday: string; label: string };

/**
 * The answer to "which date?": the dates they named, each said as held or not, and which one this email is about.
 * `held` is every date we have for that act at that venue around them; `current` the one the reply goes on to cover.
 */
export function whichDateLine(a: { asked: string[]; askedWeekdays: string[]; held: HeldDate[]; current: HeldDate; noun: string; venue: string }): string | null {
  const named = a.asked.length
    ? a.asked.map((d) => ({ d, hit: a.held.find((h) => h.localDate === d) }))
    : a.askedWeekdays.map((w) => ({ d: w, hit: a.held.find((h) => h.weekday === w) }));
  if (named.length < 2) return null;
  const have = named.filter((n) => n.hit).map((n) => n.hit!);
  const missing = named.filter((n) => !n.hit).map((n) => n.d);
  const say = (d: string) => (/^\d{4}-/.test(d) ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`)) : d[0]!.toUpperCase() + d.slice(1));
  if (have.length >= 2) {
    const others = have.filter((h) => h.localDate !== a.current.localDate);
    return `Both: there’s a ${a.noun} at ${a.venue} on ${have.map((h) => h.label).join(' and on ')}. This email is about ${a.current.label}${others.length ? `; reply with “${others[0]!.weekday[0]!.toUpperCase()}${others[0]!.weekday.slice(1)}” and I’ll look at ${others.length === 1 ? 'that one' : 'the other one'} instead` : ''}.`;
  }
  if (have.length === 1) return `The one I have on file is ${have[0]!.label} at ${a.venue}. I don’t have a ${a.noun} there on ${missing.map(say).join(' or ')}; if you’ve seen one announced, send me the link and I’ll check it.`;
  return `I don’t have a ${a.noun} at ${a.venue} on ${missing.map(say).join(' or ')} on file. The one I have is ${a.current.label}.`;
}
