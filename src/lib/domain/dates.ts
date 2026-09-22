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

/** Local calendar date of an event instant in its venue timezone. */
export function eventLocalDate(startAt: Date, timeZone: string): string {
  const p = localDateParts(startAt, timeZone);
  return toIsoDate(p.y, p.m, p.d);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}
