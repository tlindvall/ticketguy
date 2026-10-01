/**
 * Relative date resolution. "tomorrow" is resolved against the message's received instant
 * expressed in the confirmed venue timezone (A03). A forwarded email's historical Date header is
 * never used as the reference time.
 */

export function localDateParts(instant: Date, timeZone: string): { y: number; m: number; d: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hour: Number(parts.hour) };
}

export function toIsoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDaysToCalendar(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export type RelativeDateResolution =
  | { kind: 'resolved'; localDate: string; ambiguous: boolean; note: string | null }
  | { kind: 'unresolved'; reason: string };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Resolves a small set of relative expressions. Anything else is unresolved and must be clarified.
 * Near-midnight (23:00–01:00 local) results are flagged ambiguous so the pipeline clarifies rather than guesses.
 */
export function resolveRelativeDate(expression: string, receivedAt: Date, venueTimeZone: string | null): RelativeDateResolution {
  if (!venueTimeZone) return { kind: 'unresolved', reason: 'venue_timezone_unknown' };
  const expr = expression.trim().toLowerCase();
  const now = localDateParts(receivedAt, venueTimeZone);
  const nearMidnight = now.hour >= 23 || now.hour < 1;
  const note = nearMidnight ? 'received near local midnight; confirm the date with the customer' : null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expr);
  if (iso) return { kind: 'resolved', localDate: expr, ambiguous: false, note: null };

  let offset: number | null = null;
  if (expr === 'today' || expr === 'tonight') offset = 0;
  else if (expr === 'tomorrow' || expr === 'tomorrow night') offset = 1;
  else if (expr === 'day after tomorrow') offset = 2;
  else if (/^in (\d{1,2}) days?$/.test(expr)) offset = Number(/^in (\d{1,2}) days?$/.exec(expr)![1]);
  else {
    const wd = /^(this |next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(expr);
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[2]!);
      const todayIdx = new Date(Date.UTC(now.y, now.m - 1, now.d)).getUTCDay();
      let delta = (target - todayIdx + 7) % 7;
      if (delta === 0) delta = 7;
      if (wd[1] === 'next ' && delta < 7) delta += 7;
      offset = delta;
    }
  }
  if (offset === null) return { kind: 'unresolved', reason: 'unsupported_expression' };
  const t = addDaysToCalendar(now.y, now.m, now.d, offset);
  return { kind: 'resolved', localDate: toIsoDate(t.y, t.m, t.d), ambiguous: nearMidnight, note };
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * A month named without a day ("sometime in November") narrows the event search without resolving it.
 * Returns the inclusive local-date window for that month, or null when the expression names no bare month.
 * A month already past in the reference year is read as next year, the same rule resolveMonthDay uses.
 */
export function monthWindowFor(expression: string, receivedAt: Date): { from: string; to: string } | null {
  const m = /(?:^|\b)(?:sometime\s+)?(?:in|during|for)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?(?:\b|$)/i.exec(expression.trim());
  if (!m) return null;
  // A day number anywhere in the expression means it is a specific date, not a whole month.
  if (/\d{1,2}(?:st|nd|rd|th)?\b/.test(expression.replace(/\b\d{4}\b/g, ''))) return null;
  const month = MONTH_NAMES.findIndex((n) => n.startsWith(m[1]!.toLowerCase().slice(0, 3))) + 1;
  if (month === 0) return null;
  const refY = receivedAt.getUTCFullYear();
  const refM = receivedAt.getUTCMonth() + 1;
  const year = m[2] ? Number(m[2]) : month < refM ? refY + 1 : refY;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: toIsoDate(year, month, 1), to: toIsoDate(year, month, lastDay) };
}

/** Local calendar date of an event instant in its venue timezone. */
export function eventLocalDate(startAt: Date, timeZone: string): string {
  const p = localDateParts(startAt, timeZone);
  return toIsoDate(p.y, p.m, p.d);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

/**
 * Every instant at which a venue's wall-clock time occurs (R2-TIME-FOLD-01), earliest first: one normally, two
 * in the hour that repeats when clocks go back (1:30 AM in Los Angeles on Nov 1, 2026 is both 08:30Z and
 * 09:30Z), none in the hour skipped when they go forward. Only an explicit offset tells the two apart, so a
 * caller that must not guess checks for more than one.
 */
export function localTimeInstants(localDate: string, localTime: string, timeZone: string): Date[] {
  const want = wallMs(localDate, localTime);
  // The zone's offsets a day either side cover both sides of any transition near this time.
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((d) => offsetMs(new Date(want + d), timeZone)));
  const out = [...offsets].map((o) => want - o).filter((ms) => offsetMs(new Date(ms), timeZone) === want - ms);
  return [...new Set(out)].sort((a, b) => a - b).map((ms) => new Date(ms));
}

/**
 * One instant for a venue's local wall-clock time. Discovery gives most events a start instant, but a
 * time-to-be-announced event has only a local date; this turns that into a comparable instant without a
 * timezone library. It is only ever used for ordering, windowing and deadlines, never shown as the event time.
 * In the repeated hour it is the first occurrence, so a deadline is never later than meant; in a skipped hour
 * it is that clock time after the jump (2:30 AM reads as 3:30 AM), as a clock would show it.
 */
export function localToInstant(localDate: string, localTime: string, timeZone: string): Date {
  const all = localTimeInstants(localDate, localTime, timeZone);
  if (all.length) return all[0]!;
  const want = wallMs(localDate, localTime);
  return new Date(want - offsetMs(new Date(want - 86_400_000), timeZone));
}

/** "2026-11-01", "01:30" read as if it were UTC: the wall time in milliseconds. */
function wallMs(localDate: string, localTime: string): number {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const [hh, mm] = localTime.split(':').map(Number) as [number, number];
  return Date.UTC(y, m - 1, d, hh, mm ?? 0);
}

/** How far the zone's wall clock is ahead of UTC at an instant (negative in the Americas). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = localDateParts(instant, timeZone);
  const whole = Math.floor(instant.getTime() / 60_000) * 60_000;
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, minuteInZone(instant, timeZone)) - whole;
}

function minuteInZone(instant: Date, timeZone: string): number {
  const s = new Intl.DateTimeFormat('en-US', { timeZone, minute: '2-digit', hour12: false }).format(instant);
  return Number(s) || 0;
}

/**
 * "This week", "next week" and the weekend phrases narrow the search to a span of days without picking one.
 * Weeks run Monday to Sunday in the venue's timezone. "Next weekend" is genuinely read two ways (the coming
 * one, or the one after), so it spans both and lets the resolver ask rather than guess. Returns the
 * inclusive local-date window, or null when the expression names no week.
 */
export function weekWindowFor(expression: string, receivedAt: Date, timeZone: string): { from: string; to: string } | null {
  const e = expression.trim().toLowerCase();
  const kind = /\bnext\s+weekend\b/.test(e) ? 'next_weekend' : /\b(?:this|the)\s+weekend\b|^weekend$|\bover the weekend\b/.test(e) ? 'this_weekend' : /\bnext\s+week\b/.test(e) ? 'next_week' : /\bthis\s+week\b|\blater this week\b/.test(e) ? 'this_week' : null;
  if (!kind) return null;
  const now = localDateParts(receivedAt, timeZone);
  const dow = new Date(Date.UTC(now.y, now.m - 1, now.d)).getUTCDay(); // 0 Sunday … 6 Saturday
  const toMonday = dow === 0 ? -6 : 1 - dow;
  const day = (offset: number) => {
    const t = addDaysToCalendar(now.y, now.m, now.d, offset);
    return toIsoDate(t.y, t.m, t.d);
  };
  const thisSunday = toMonday + 6;
  // The coming Friday, or today when the weekend has already started.
  const toFriday = dow === 0 ? 0 : dow === 6 ? 0 : 5 - dow;
  if (kind === 'this_week') return { from: day(0), to: day(thisSunday) };
  if (kind === 'next_week') return { from: day(toMonday + 7), to: day(thisSunday + 7) };
  if (kind === 'this_weekend') return { from: day(toFriday), to: day(dow === 0 ? 0 : thisSunday) };
  return { from: day(toFriday), to: day((dow === 0 ? 0 : thisSunday) + 7) };
}

const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const monthIndex = (word: string) => MONTH_NAMES.findIndex((n) => n.startsWith(word.toLowerCase().slice(0, 3))) + 1;
/** A named month in the reference year, or the next one when it has already passed (the monthWindowFor rule). */
const yearFor = (month: number, receivedAt: Date, explicit?: string) => (explicit ? Number(explicit) : month < receivedAt.getUTCMonth() + 1 ? receivedAt.getUTCFullYear() + 1 : receivedAt.getUTCFullYear());
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Part of a month, a day range, or a short run of weeks — the ways people actually say when they are free:
 * "the first week of October" (also "on"/"in", a common slip), "early/mid/late October", "the end of October",
 * "Oct 1-7", "1st to 7th October", "the next few weeks", "this/next month". Returns the inclusive local-date
 * window, or null. Checked before the whole-month rule, because "the first week in October" also contains
 * "in October" and would otherwise widen to the whole month.
 */
export function spanWindowFor(expression: string, receivedAt: Date, timeZone: string): { from: string; to: string } | null {
  const e = expression.trim().toLowerCase();
  const now = localDateParts(receivedAt, timeZone);
  const today = toIsoDate(now.y, now.m, now.d);
  const plus = (days: number) => {
    const t = addDaysToCalendar(now.y, now.m, now.d, days);
    return toIsoDate(t.y, t.m, t.d);
  };

  const week = new RegExp(`\\b(first|1st|second|2nd|third|3rd|fourth|4th|last|final)\\s+week\\s+(?:of|on|in)\\s+${MONTH_RE}(?:\\s+(\\d{4}))?`).exec(e);
  if (week) {
    const month = monthIndex(week[2]!);
    const year = yearFor(month, receivedAt, week[3]);
    const last = lastDayOf(year, month);
    const n = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3 }[week[1]! as 'first'];
    if (n === undefined) return { from: toIsoDate(year, month, last - 6), to: toIsoDate(year, month, last) };
    return { from: toIsoDate(year, month, 1 + n * 7), to: toIsoDate(year, month, Math.min(7 + n * 7, last)) };
  }

  const part = new RegExp(`\\b(early|beginning of|start of|mid|middle of|late|end of)\\s*-?\\s*${MONTH_RE}(?:\\s+(\\d{4}))?`).exec(e);
  if (part) {
    const month = monthIndex(part[2]!);
    const year = yearFor(month, receivedAt, part[3]);
    const last = lastDayOf(year, month);
    const which = part[1]!;
    const [a, b] = /early|beginning|start/.test(which) ? [1, 10] : /mid|middle/.test(which) ? [11, 20] : [21, last];
    return { from: toIsoDate(year, month, a), to: toIsoDate(year, month, b) };
  }

  const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
  const TO = '\\s*(?:-|–|—|to|through|thru|until)\\s*';
  const rangeMonthFirst = new RegExp(`\\b${MONTH_RE}\\s+${DAY}${TO}(?:${MONTH_RE}\\s+)?${DAY}\\b`).exec(e);
  const rangeDayFirst = new RegExp(`\\b${DAY}${TO}${DAY}\\s+(?:of\\s+)?${MONTH_RE}`).exec(e);
  if (rangeMonthFirst || rangeDayFirst) {
    const [m1, d1, m2, d2] = rangeMonthFirst ? [rangeMonthFirst[1]!, rangeMonthFirst[2]!, rangeMonthFirst[3] ?? rangeMonthFirst[1]!, rangeMonthFirst[4]!] : [rangeDayFirst![3]!, rangeDayFirst![1]!, rangeDayFirst![3]!, rangeDayFirst![2]!];
    const month1 = monthIndex(m1);
    const month2 = monthIndex(m2);
    const year1 = yearFor(month1, receivedAt);
    const year2 = month2 < month1 ? year1 + 1 : year1;
    const from = toIsoDate(year1, month1, Math.min(Number(d1), lastDayOf(year1, month1)));
    const to = toIsoDate(year2, month2, Math.min(Number(d2), lastDayOf(year2, month2)));
    if (from <= to) return { from, to };
  }

  if (/\b(?:next|coming)\s+(?:few|couple(?:\s+of)?)\s+weeks\b/.test(e)) return { from: today, to: plus(21) };
  const nWeeks = /\b(?:next|coming)\s+(\d|two|three|four)\s+weeks\b/.exec(e);
  if (nWeeks) {
    const n = ({ two: 2, three: 3, four: 4 } as Record<string, number>)[nWeeks[1]!] ?? Number(nWeeks[1]);
    return { from: today, to: plus(7 * n) };
  }
  if (/\bthis\s+month\b/.test(e)) return { from: today, to: toIsoDate(now.y, now.m, lastDayOf(now.y, now.m)) };
  if (/\bnext\s+month\b/.test(e)) {
    const y = now.m === 12 ? now.y + 1 : now.y;
    const m = now.m === 12 ? 1 : now.m + 1;
    return { from: toIsoDate(y, m, 1), to: toIsoDate(y, m, lastDayOf(y, m)) };
  }
  return null;
}

/** Any span a date phrase names without naming a day: part of a month, a range, a month or a week. */
export function dateWindowFor(expression: string, receivedAt: Date, timeZone: string): { from: string; to: string } | null {
  return spanWindowFor(expression, receivedAt, timeZone) ?? monthWindowFor(expression, receivedAt) ?? weekWindowFor(expression, receivedAt, timeZone);
}
