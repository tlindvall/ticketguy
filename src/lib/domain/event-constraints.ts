import { dateWindowFor, localDateParts, toIsoDate } from './dates';

/**
 * The hard rules a customer puts on which event they mean, read from their own words across the thread: the
 * venue ("at MSG only"), home games only, the start time ("evening only", "starting AFTER 7pm, not at 7", "the
 * 7pm show"), the days ("Saturday or Sunday", "not Monday or Thursday"), a month or range ("NOVEMBER 2026 only")
 * and "the next one". These are checked against every candidate before any event is chosen or linked, whatever
 * the extractor read, and a candidate that breaks one is never recommended (TGQA-R6 1001, 1004). For each rule
 * the latest message that states it wins, so a correction replaces what came before.
 */
export type TimeBound = { minutes: number; strict: boolean };
export type EventConstraints = {
  /** Venues they named, as written in the catalog (name or alias, lowercase). Null when they named none. */
  venueTerms: string[] | null;
  /** Venues they ruled out ("No Prudential Center or UBS Arena"): never a venue to search, always one to drop (TGQA-R8 S04). */
  excludedVenues: string[];
  homeOnly: boolean;
  after: TimeBound | null;
  before: TimeBound | null;
  /** "the 7pm show", "the screenshot says 7pm": that performance. Minutes after midnight, local. */
  exactTime: number | null;
  /** Start times they ruled out ("not 4pm", "not the 1pm matinee"). */
  notTimes: number[];
  partOfDay: 'evening' | 'matinee' | null;
  /** Days of the week allowed (0 Sunday … 6 Saturday), or null for any. */
  weekdays: number[] | null;
  /** Days ruled out ("not Monday or Thursday"). */
  notWeekdays: number[];
  /** A month or range they named, and "next Saturday" read both ways (the coming one or the one after). */
  window: { from: string; to: string; source: 'month' | 'range' | 'next_weekday' } | null;
  /** "the next home game", "their next date": the earliest that fits. */
  next: boolean;
};

export const NO_CONSTRAINTS: EventConstraints = { venueTerms: null, excludedVenues: [], homeOnly: false, after: null, before: null, exactTime: null, notTimes: [], partOfDay: null, weekdays: null, notWeekdays: [], window: null, next: false };

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_RE = '(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?s?';
const dayIndex = (w: string) => DAYS.findIndex((d) => d.startsWith(w.toLowerCase().slice(0, 3)));
const MONTHS = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/**
 * Words run together in some mail clients and forms ("Thursday October8", "after7pm", "kids12 and15",
 * "section112 row8", "November2026"): spaced out for reading, links left alone.
 */
export function unglue(text: string): string {
  return text
    .split(/(\bhttps?:\/\/\S+)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(new RegExp(`\\b${MONTHS}(\\d)`, 'gi'), '$1 $2')
            .replace(/\b(after|before|by|not|at|from|until|than|and|or|to|kids?|children|ages?|aged|sec|section|row|seats?)(\d)/gi, '$1 $2')
            .replace(/\b(all)(two|three|four|five|six|seven|eight)\b/gi, '$1 $2'),
    )
    .join('');
}

/**
 * What fans call the big venues, whether or not the catalog row carries it: a venue synced from Ticketmaster has no
 * aliases, so "MSG" matched nothing live and a home-at-MSG request went to Philadelphia (TGQA-R8 S03).
 */
const KNOWN_VENUE_ALIASES: Array<[RegExp, string[]]> = [
  [/^madison square garden$/i, ['MSG', 'the Garden']],
  [/^barclays cent(?:er|re)$/i, ['Barclays']],
  [/^ubs arena$/i, ['UBS']],
  [/^prudential cent(?:er|re)$/i, ['Prudential', 'the Rock']],
  [/^metlife stadium$/i, ['MetLife']],
  [/^yankee stadium$/i, []],
  [/^citi field$/i, []],
  [/^crypto\.com arena$/i, ['Crypto.com', 'Staples Center']],
  [/^td garden$/i, []],
  [/^radio city music hall$/i, ['Radio City']],
  [/^kia forum$/i, ['the Forum']],
];
export function withKnownAliases(v: { name: string; aliases: string[] }): { name: string; aliases: string[] } {
  const extra = KNOWN_VENUE_ALIASES.find(([re]) => re.test(v.name.trim()))?.[1] ?? [];
  return { name: v.name, aliases: [...new Set([...v.aliases, ...extra])] };
}

/** "7pm", "7:30 PM", "7" (read as evening), "noon": minutes after midnight. */
function clock(h: string, m: string | undefined, ap: string | undefined): number {
  if (/^noon$/i.test(h)) return 720;
  let hh = Number(h) % 12;
  if (!ap || /^p/i.test(ap)) hh += 12; // a bare "7" for a show is the evening
  return hh * 60 + Number(m ?? 0);
}
const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*([ap])?\\.?\\s*m?\\.?';

function timesIn(t: string) {
  // Delivery and travel times are not the show's start: "delivered by 8am", "arrives by 5pm", "we fly at 9".
  const clean = t.replace(new RegExp(`\\b(?:deliver\\w*|transfer\\w*|arriv\\w*|in (?:our|my) account|by|fly\\w*|flight|leave|leaving|land\\w*)\\s+(?:is\\s+)?(?:by\\s+|at\\s+|before\\s+)?${TIME}`, 'gi'), ' ');
  let after: TimeBound | null = null;
  let before: TimeBound | null = null;
  let exactTime: number | null = null;
  const notTimes: number[] = [];
  const a = new RegExp(`\\b(?:(?:start(?:s|ing)?|begin(?:s|ning)?|show(?:s)?)\\s+)?(after|later than|no earlier than|not before|from|at or after)\\s+${TIME}(\\s+or later)?(?!\\s*(?:tickets?|seats?|people|of us|\\$|%))`, 'i').exec(clean);
  if (a && (a[4] || /start|show|begin/i.test(clean.slice(Math.max(0, a.index - 20), a.index + a[0].length)) || /^(?:after|later than)$/i.test(a[1]!))) {
    after = { minutes: clock(a[2]!, a[3], a[4]), strict: /^(?:after|later than)$/i.test(a[1]!) && !a[5] };
  }
  const b = new RegExp(`\\b(?:start(?:s|ing)?|begin(?:s|ning)?|show(?:s)?)\\s+(?:no later than|before|by)\\s+${TIME}`, 'i').exec(clean);
  if (b) before = { minutes: clock(b[1]!, b[2], b[3]), strict: /before/i.test(b[0]) };
  // "the 7pm show", "it is the 7PM October 3 show", "the screenshot says 7pm", "the 7PM performance".
  const ex = new RegExp(`\\b${TIME}\\s+(?:[a-z]+\\s+\\d{1,2}\\s+)?(?:show|performance|showing|one|start)\\b|\\b(?:says|shows|is at|starts at|it'?s at)\\s+${TIME}(?=[\\s,.;]|$)`, 'i').exec(clean);
  if (ex) {
    const [h, m, ap] = ex[1] ? [ex[1], ex[2], ex[3]] : [ex[4]!, ex[5], ex[6]];
    if (ap || /pm|am/i.test(ex[0])) exactTime = clock(h!, m, ap);
  }
  for (const n of clean.matchAll(new RegExp(`\\bnot\\s+(?:at\\s+|the\\s+)?${TIME}(?:\\s+(?:either|show|matinee|performance))?`, 'gi'))) {
    if (n[3] || /\bnot\s+(?:at\s+)?\d{1,2}\s*$|\bnot at\b/i.test(n[0]) || /pm|am/i.test(n[0])) notTimes.push(clock(n[1]!, n[2], n[3]));
  }
  // "starting AFTER 7pm, not at 7" is strict, whatever the first phrase said.
  if (after && notTimes.includes(after.minutes)) after = { ...after, strict: true };
  return { after, before, exactTime, notTimes };
}

function weekdaysIn(t: string): { weekdays: number[] | null; notWeekdays: number[] } {
  const notWeekdays: number[] = [];
  for (const m of t.matchAll(new RegExp(`\\b(?:not|no|never|except)\\s+(?:on\\s+)?((?:${DAY_RE})(?:\\s*(?:,|or|and|nor|/)\\s*(?:${DAY_RE}))*)`, 'gi'))) {
    for (const d of m[1]!.matchAll(new RegExp(DAY_RE, 'gi'))) notWeekdays.push(dayIndex(d[1]!));
  }
  if (/\bnot\s+(?:on\s+)?weekdays?\b|\bweekends?\s+only\b|\bonly\s+(?:on\s+)?(?:a\s+|the\s+)?weekends?\b|\b(?:a|the)\s+weekend\s+that works\b|\bsat(?:urday)?s?\s*(?:or|and|\/|&)\s*sun(?:day)?s?\b|\bany\s+weekend\b/i.test(t)) return { weekdays: [6, 0], notWeekdays };
  // "Knicks tickets for next weekend": Saturday or Sunday, not the Monday or Thursday game between, and not a
  // Friday called a weekend match (TGQA-R8 S04).
  if (/\b(?:this|next|the|that|a)\s+weekend\b|\bover the weekend\b/i.test(t)) return { weekdays: [6, 0], notWeekdays };
  if (/\bweekdays?\s+only\b|\bnot\s+(?:on\s+)?(?:a\s+|the\s+)?weekends?\b/i.test(t)) return { weekdays: [1, 2, 3, 4, 5], notWeekdays };
  // "Saturday October 3 ONLY", "any Friday": that day of the week.
  const only = new RegExp(`\\b${DAY_RE}\\b[^.?!]{0,30}?\\bonly\\b|\\bonly\\s+(?:on\\s+)?${DAY_RE}\\b|\\bany\\s+${DAY_RE}\\b`, 'i').exec(t);
  if (only) {
    const w = (only[1] ?? only[2] ?? only[3])!;
    return { weekdays: [dayIndex(w)], notWeekdays };
  }
  return { weekdays: null, notWeekdays };
}

function windowIn(t: string, receivedAt: Date, timeZone: string): EventConstraints['window'] {
  const range = new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\s*(?:-|–|to|through|thru|until)\\s*(?:${MONTHS}\\s+)?\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, 'i').exec(t);
  if (range) {
    const w = dateWindowFor(range[0].replace(/,?\s+\d{4}/g, ''), receivedAt, timeZone);
    if (w) return { ...w, source: 'range' };
  }
  // Part of a month: "mid-November", "early October", "the end of November".
  const part = new RegExp(`\\b(?:early|beginning of|start of|mid|middle of|late|end of)\\s*-?\\s*${MONTHS}`, 'i').exec(t);
  if (part) {
    const w = dateWindowFor(part[0], receivedAt, timeZone);
    if (w) return { ...w, source: 'range' };
  }
  // A month named without a day: "in November", "NOVEMBER 2026 only", "November 2026", "in October 2026".
  const month = new RegExp(`\\b(?:in|during|for|sometime in|only in)?\\s*${MONTHS}(?:\\s+(20\\d{2}))?\\b(?!\\s+\\d{1,2}\\b)`, 'i').exec(t);
  if (month && (month[2] || /\b(?:in|during|sometime|only)\s+\S+$/i.test(t.slice(0, month.index + month[0].length).trimEnd()) || /\bonly\b/i.test(t.slice(month.index, month.index + month[0].length + 8)))) {
    const w = dateWindowFor(`in ${month[1]}${month[2] ? ` ${month[2]}` : ''}`, receivedAt, timeZone);
    if (w) return { ...w, source: 'month' };
  }
  // "next Saturday" said on a Wednesday means this Saturday to some people and the one after to others; with no
  // other date, both are in the window, and "next" then takes the first that fits.
  const nw = new RegExp(`\\bnext\\s+${DAY_RE}\\b`, 'i').exec(t);
  if (nw) {
    const now = localDateParts(receivedAt, timeZone);
    const today = new Date(Date.UTC(now.y, now.m - 1, now.d));
    const target = dayIndex(nw[1]!);
    let delta = (target - today.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    const d1 = new Date(today.getTime() + delta * 86_400_000);
    const d2 = new Date(d1.getTime() + (delta < 7 ? 7 : 0) * 86_400_000);
    const iso = (d: Date) => toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    return { from: iso(d1), to: iso(d2), source: 'next_weekday' };
  }
  return null;
}

export function eventConstraints(messagesOldestFirst: string[], ctx: { receivedAt: Date; timeZone: string; venues: Array<{ name: string; aliases: string[] }> }): EventConstraints {
  const out: EventConstraints = { ...NO_CONSTRAINTS, notTimes: [], notWeekdays: [] };
  // Each venue once, by its catalog name, however they wrote it ("MSG", "Madison Square Garden").
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const venues = ctx.venues.map((v0) => {
    const v = v0.name ? withKnownAliases(v0) : v0;
    return { canonical: (v.name || v.aliases[0] || '').toLowerCase(), names: [v.name, ...v.aliases].filter((n) => n.length >= 3).map((n) => n.toLowerCase()) };
  }).filter((v) => v.canonical && v.names.length);
  const nameRe = (n: string) => esc(n).replace(/ /g, '\\s+');
  for (const raw of messagesOldestFirst) {
    const t = unglue(raw).replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
    const lower = t.toLowerCase();
    // A venue named as where the event is, not where they eat or stay ("dinner near MSG" is not a venue rule).
    // Ruled out, not asked for: "No Prudential Center or UBS Arena", "Prudential Center and UBS Arena are EXCLUDED".
    const excluded = new Set<string>();
    // Only venues the message names at all: the catalog has thousands.
    const mentioned = venues.filter((v) => v.names.some((n) => lower.includes(n)));
    const any = mentioned.flatMap((x) => x.names).map(nameRe).join('|');
    for (const v of mentioned) {
      for (const n of v.names) {
        const listed = `(?:the\\s+)?(?:${any})(?:\\s*(?:,|or|and|nor|/)\\s*(?:the\\s+)?(?:${any}))*`;
        const before = new RegExp(`\\b(?:no|not|excluding|exclude|except|without|other than|never|avoid|nothing at)\\s+(?:at\\s+|in\\s+)?(?=${listed})(?:[^.;!?]*?)(?<![\\w-])${nameRe(n)}(?![\\w-])`, 'i');
        const after = new RegExp(`(?<![\\w-])${nameRe(n)}(?![\\w-])(?:\\s*(?:,|or|and|nor|/)\\s*(?:the\\s+)?(?:${any}))*\\s+(?:are|is)\\s+(?:excluded|not (?:permitted|allowed|ok|okay|wanted|an option)|ruled out|out|off the table)`, 'i');
        const m = before.exec(lower);
        if ((m && new RegExp(`^(?:no|not|excluding|exclude|except|without|other than|never|avoid|nothing at)\\s+(?:at\\s+|in\\s+)?${listed}$`, 'i').test(m[0])) || after.test(lower)) excluded.add(v.canonical);
      }
    }
    if (excluded.size) out.excludedVenues = [...excluded];
    const named = [...new Set(mentioned.filter((v) => !excluded.has(v.canonical) && v.names.some((n) => new RegExp(`(?<![\\w-])${nameRe(n)}(?![\\w-])`, 'i').test(lower) && !new RegExp(`\\b(?:near|by|around|walk (?:of|from)|close to)\\s+(?:the\\s+)?${nameRe(n)}`, 'i').test(lower))).map((v) => v.canonical))];
    if (named.length) out.venueTerms = named;
    if (out.venueTerms) out.venueTerms = out.venueTerms.filter((n) => !out.excludedVenues.includes(n));
    if (out.venueTerms && !out.venueTerms.length) out.venueTerms = null;
    if (/\bhome\s+(?:game|match|fixture|date|opener|games|matches)\b|\bnot\s+(?:an?\s+)?away\b|\bsubstitute an away\b|\bhome\s+only\b/i.test(t)) out.homeOnly = true;
    const times = timesIn(t);
    if (times.after || times.before || times.exactTime !== null) {
      out.after = times.after;
      out.before = times.before;
      out.exactTime = times.exactTime;
    }
    if (times.notTimes.length) out.notTimes = times.notTimes;
    const evening = /\bevening\b|\b(?:sun|mon|tues|wednes|thurs|fri|satur)day\s+night\b|\bnight\s+(?:show|performance)\b/i.test(t);
    const matinee = /\b(?<!not\s(?:the\s)?(?:\d{1,2}\s?[ap]m\s)?)(?:matinee|afternoon)\b/i.test(t) && !/\bnot\s+(?:the\s+)?(?:\d{1,2}\s*[ap]m\s+)?matinee\b/i.test(t);
    if (evening) out.partOfDay = 'evening';
    else if (matinee) out.partOfDay = 'matinee';
    const days = weekdaysIn(t);
    if (days.weekdays) out.weekdays = days.weekdays;
    if (days.notWeekdays.length) out.notWeekdays = days.notWeekdays;
    const w = windowIn(t, ctx.receivedAt, ctx.timeZone);
    if (w) out.window = w;
    // A day they now name ("Thursday October 8, 2026") replaces a month or range from an earlier message (TGQA-R6 24).
    else if (new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS}\\b`, 'i').test(t)) out.window = null;
    // "next Saturday" is a Saturday, whichever of the two it is.
    if (w?.source === 'next_weekday' && !days.weekdays) out.weekdays = [new Date(`${w.from}T12:00:00Z`).getUTCDay()];
    if (/\bnext\b[^.?!]{0,30}?\b(?:game|match|show|performance|date|fixture|concert|one)\b|\b(?:find|any)\s+(?:a|the next|the earliest)\s+(?:weekend|saturday|sunday|date|game)\b|\bearliest\b/i.test(t)) out.next = true;
  }
  return out;
}

/** Local start minutes and weekday of an event in its venue's zone. */
export function localStart(startAt: Date, timeZone: string): { minutes: number; weekday: number; date: string } {
  const p = localDateParts(startAt, timeZone);
  const mm = Number(new Intl.DateTimeFormat('en-US', { timeZone, minute: '2-digit' }).format(startAt)) || 0;
  return { minutes: p.hour * 60 + mm, weekday: new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(), date: toIsoDate(p.y, p.m, p.d) };
}

const timeLabel = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
};

/**
 * Why an event breaks their rules, in words for the reply ("it's in Philadelphia, not at Madison Square
 * Garden", "it starts at 7pm, and you asked for after 7pm"), or [] when it fits them all.
 */
export function breaks(c: EventConstraints, e: { localStartAt: Date; isHome: boolean | null }, v: { name: string; aliases: string[]; city: string | null; timezone: string }, opts: { team: boolean; atHome?: boolean | null }): string[] {
  const why: string[] = [];
  const at = localStart(e.localStartAt, v.timezone);
  const vn = [v.name, ...v.aliases].map((n) => n.toLowerCase());
  if (c.excludedVenues?.some((n) => vn.includes(n))) why.push(`it's at ${v.name}, which you ruled out`);
  if (c.venueTerms && !why.length) {
    const wanted = c.venueTerms.map(displayVenue).join(' or ');
    // The label already names the venue; the reason says what matters about it.
    if (!c.venueTerms.some((n) => vn.includes(n))) why.push(v.city && !/new york|brooklyn/i.test(v.city) ? `it's in ${v.city}, not at ${wanted}` : `it's at ${v.name}, not at ${wanted}`);
  }
  // Away is away whatever the catalog says: a synced "Knicks v 76ers" in Philadelphia is marked home (TGQA-R8 S03), so
  // the team's own market decides when it is known.
  if (c.homeOnly && opts.team && (e.isHome === false || opts.atHome === false) && !why.length) why.push(`it's an away game${v.city ? `, in ${v.city}` : ''}`);
  if (c.exactTime !== null && at.minutes !== c.exactTime) why.push(`it starts at ${timeLabel(at.minutes)}, not ${timeLabel(c.exactTime)}`);
  if (c.notTimes.includes(at.minutes)) why.push(`it starts at ${timeLabel(at.minutes)}, which you ruled out`);
  if (c.after && (c.after.strict ? at.minutes <= c.after.minutes : at.minutes < c.after.minutes)) why.push(`it starts at ${timeLabel(at.minutes)}, and you asked for ${c.after.strict ? 'after' : 'no earlier than'} ${timeLabel(c.after.minutes)}`);
  if (c.before && (c.before.strict ? at.minutes >= c.before.minutes : at.minutes > c.before.minutes)) why.push(`it starts at ${timeLabel(at.minutes)}, later than you want`);
  if (c.partOfDay === 'evening' && at.minutes < 17 * 60) why.push(`it's the ${timeLabel(at.minutes)} matinee, and you asked for an evening show`);
  if (c.partOfDay === 'matinee' && at.minutes >= 17 * 60) why.push(`it's the ${timeLabel(at.minutes)} evening show, and you asked for a matinee`);
  if (c.weekdays && !c.weekdays.includes(at.weekday)) why.push(`it's on a ${DAYS[at.weekday]!.replace(/^./, (x) => x.toUpperCase())}`);
  else if (c.notWeekdays.includes(at.weekday)) why.push(`it's on a ${DAYS[at.weekday]!.replace(/^./, (x) => x.toUpperCase())}, which you ruled out`);
  if (c.window && (at.date < c.window.from || at.date > c.window.to)) why.push('it falls outside the dates you gave');
  return why;
}

function displayVenue(term: string): string {
  return term.length <= 4 ? term.toUpperCase() : term.replace(/\b\w/g, (x) => x.toUpperCase());
}

export function describeTimeRule(c: EventConstraints): string | null {
  if (c.exactTime !== null) return `the ${timeLabel(c.exactTime)} show`;
  if (c.after) return `starting ${c.after.strict ? 'after' : 'at or after'} ${timeLabel(c.after.minutes)}`;
  if (c.partOfDay === 'evening') return 'an evening show';
  if (c.partOfDay === 'matinee') return 'a matinee';
  return null;
}
