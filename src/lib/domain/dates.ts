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
 * The instant at which a venue's local wall-clock time occurs. Discovery gives most events a start instant,
 * but a time-to-be-announced event has only a local date; this turns that into a comparable instant without
 * a timezone library, by guessing UTC and correcting by the zone's offset at that guess (two passes cover a
 * DST edge). It is only ever used for ordering and windowing, never shown as the event time.
 */
export function localToInstant(localDate: string, localTime: string, timeZone: string): Date {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const [hh, mm] = localTime.split(':').map(Number) as [number, number];
  let guess = Date.UTC(y, m - 1, d, hh, mm ?? 0);
  for (let pass = 0; pass < 2; pass += 1) {
    const p = localDateParts(new Date(guess), timeZone);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hour, minuteInZone(new Date(guess), timeZone));
    const want = Date.UTC(y, m - 1, d, hh, mm ?? 0);
    guess += want - seen;
  }
  return new Date(guess);
}

function minuteInZone(instant: Date, timeZone: string): number {
  const s = new Intl.DateTimeFormat('en-US', { timeZone, minute: '2-digit', hour12: false }).format(instant);
  return Number(s) || 0;
}
