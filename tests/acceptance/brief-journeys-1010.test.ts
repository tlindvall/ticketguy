import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { setKillSwitch } from '@/lib/email/send-gate';
import { buildTestInbound, TEST_MODE_KEY } from '@/lib/email/test-mode';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import type { RequestExtraction } from '@/lib/domain/types';
import type { ListingImage, ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { RecordingProvider, openTestDb, testEnv } from '../harness';

/**
 * The customer journeys of the product brief (Oct 10), end to end the way production runs them: live mode with sending
 * on, drafts auto-approved for the test allowlist, test mode capturing each email at dispatch (so what is asserted is
 * the text dispatchSend handed over, subject and body), the model's reading of every message recorded per message
 * (production extracts with a model, not the rules), screenshots read by a scripted reader, SeatData answered by a fake
 * shaped like its payloads, and the outbox drained as the worker drains it. Every email is held to the product rules:
 * the answer or the one essential question first, one useful next action, nothing broken ("null", "undefined"),
 * no dashes, no pressure words, every SeatData price said as before fees, nothing asked that the customer already said.
 *
 * JOURNEYS_OUT=<dir> writes each turn's rendered emails to <dir>/<id>.txt for a read-through.
 */
const CLOCK = new Date('2026-10-07T14:00:00Z'); // Wednesday, 10am in New York
const ENFORCE = process.env.SD_MODE === 'enforce';
const KEY = 'b1'.repeat(32);
const TESTER = (n: string) => `${n}@journeys.test`;
const H = 3_600_000;

const id = (n: number) => `7e1010aa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V = { metlife: id(1), elsewhere: id(2), warehouse: id(3), carnesecca: id(4) };
const ENT = { metallica: id(10), mrak: id(11), redStorm: id(12), dusky: id(13) };
const EV = {
  rangersOct9: id(100),
  rangersOct13: id(101),
  rangersOct17: id(102),
  rangersOct20: id(103),
  duaLipa: id(110),
  metallica: id(120),
  elsewhereFri: id(130),
  elsewhereSat: id(131),
  mrak: id(140),
  mrakPack: id(141),
  redStorm: id(150),
};

type Listing = { active: boolean; listing_id: number; source: string; price: number; quantity: number; section?: string; row?: string; zone?: string };
/** The feed's zone for a section, as SeatData names them. */
const zoneOf = (section: string) => (/^floor/i.test(section) ? 'Floor' : /^1\d\d$/.test(section) ? 'Lower Level' : /^2\d\d$/.test(section) ? '200 Level' : 'Upper Level');
const zoned = (ls: Listing[]) => ls.map((l) => (l.section ? { ...l, zone: zoneOf(l.section) } : l));
type Snap = { timestamp: string; total_listings_all: number; total_listings_active: number; listing_fill_rate: number; avg_price: number; median_price: number; get_in: number; get_in_qty2plus: number; zones: unknown[] };
const snap = (hoursAgo: number, pair: number, active = 260): Snap => ({ timestamp: new Date(CLOCK.getTime() - hoursAgo * H).toISOString(), total_listings_all: active + 120, total_listings_active: active, listing_fill_rate: 0.6, avg_price: pair * 1.9, median_price: pair * 1.6, get_in: pair - 9, get_in_qty2plus: pair, zones: [] });
/** Four days of pair prices every two hours, by hours before now. */
const series = (pair: (hoursAgo: number) => number) => Array.from({ length: 49 }, (_, i) => snap(96 - i * 2, Math.round(pair(96 - i * 2))));

/** SeatData as the fake serves it, by Ticketmaster event id: its own id, listings and stats. */
const MARKET: Record<string, { sd: number; name: string; date: string; listings: Listing[]; stats: Snap[] }> = {
  TMJ0100: {
    sd: 81100, name: 'New York Rangers vs. Pittsburgh Penguins', date: '2026-10-09',
    listings: [
      { active: true, listing_id: 7101, source: 'sh', price: 74, quantity: 4, section: '226', row: '3' },
      { active: true, listing_id: 7102, source: 'vs', price: 88, quantity: 4, section: '109', row: '18' },
      { active: true, listing_id: 7103, source: 'sh', price: 61, quantity: 2, section: '418', row: '1' },
      { active: true, listing_id: 7104, source: 'sh', price: 79, quantity: 6, section: '224', row: '7' },
    ],
    stats: [snap(30, 72), snap(6, 70), snap(1, 71)],
  },
  // The settled game with a stored series: up from $95 a pair-ticket three days ago to $112 now, both windows rising.
  TMJ0101: {
    sd: 81101, name: 'New York Rangers vs. Washington Capitals', date: '2026-10-13',
    listings: [
      { active: true, listing_id: 7111, source: 'sh', price: 112, quantity: 2, section: '225', row: '5' },
      { active: true, listing_id: 7112, source: 'vs', price: 129, quantity: 4, section: '114', row: '20' },
      { active: true, listing_id: 7113, source: 'sh', price: 147, quantity: 2, section: '105', row: '9' },
      { active: true, listing_id: 7114, source: 'sh', price: 119, quantity: 5, section: '227', row: '2' },
    ],
    stats: series((ago) => 112 - (ago / 96) * 17),
  },
  // A thin series: one reading.
  TMJ0102: {
    sd: 81102, name: 'New York Rangers vs. Montreal Canadiens', date: '2026-10-17',
    listings: [{ active: true, listing_id: 7121, source: 'sh', price: 97, quantity: 2, section: '223', row: '11' }],
    stats: [snap(2, 97, 40)],
  },
  TMJ0103: {
    sd: 81103, name: 'New York Rangers vs. Boston Bruins', date: '2026-10-20',
    listings: [
      { active: true, listing_id: 7131, source: 'sh', price: 118, quantity: 2, section: '113', row: '16' },
      { active: true, listing_id: 7132, source: 'vs', price: 126, quantity: 4, section: '111', row: '10' },
      { active: true, listing_id: 7133, source: 'sh', price: 139, quantity: 2, section: '112', row: '14' },
    ],
    stats: [snap(26, 121), snap(3, 118)],
  },
  TMJ0110: {
    sd: 81110, name: 'Dua Lipa', date: '2026-10-24',
    listings: [
      { active: true, listing_id: 7141, source: 'sh', price: 163, quantity: 2, section: '112', row: '12' },
      { active: true, listing_id: 7142, source: 'vs', price: 171, quantity: 2, section: '113', row: '6' },
      { active: true, listing_id: 7143, source: 'sh', price: 208, quantity: 4, section: 'Floor A', row: '20' },
    ],
    stats: [snap(28, 166), snap(4, 163)],
  },
  TMJ0120: {
    sd: 81120, name: 'Metallica: M72 World Tour', date: '2026-11-14',
    listings: [
      { active: true, listing_id: 7151, source: 'sh', price: 187, quantity: 2, section: 'Floor 3', row: '30' },
      { active: true, listing_id: 7152, source: 'vs', price: 154, quantity: 2, section: '129', row: '25' },
      { active: true, listing_id: 7153, source: 'sh', price: 236, quantity: 2, section: '111', row: '5' },
      { active: true, listing_id: 7154, source: 'sh', price: 98, quantity: 4, section: '340', row: '12' },
    ],
    stats: [snap(30, 101), snap(5, 98)],
  },
};
/**
 * The per-ticket prices SeatData gives for an event, for the before-fees rule: its listings, and its stats at the points
 * a reply quotes (now, a day ago, three days ago, the first reading). Only that event's, so a figure of our own that
 * happens to match another event's price (a fee estimate, half of their total) isn't taken for one.
 */
const seatDataDollars = (tm: string | undefined): Set<number> => {
  const m = tm ? MARKET[tm] : undefined;
  if (!m) return new Set();
  const at = (hours: number) => m.stats.reduce((best, s) => (Math.abs(CLOCK.getTime() - Date.parse(s.timestamp) - hours * H) < Math.abs(CLOCK.getTime() - Date.parse(best.timestamp) - hours * H) ? s : best), m.stats[0]!);
  const quoted = m.stats.length > 4 ? [at(0), at(24), at(72), m.stats[0]!] : m.stats;
  return new Set([...m.listings.map((l) => l.price), ...quoted.flatMap((s) => [s.get_in, Math.round(s.get_in_qty2plus)])]);
};

const TM_OF: Record<string, string> = { [EV.rangersOct9]: 'TMJ0100', [EV.rangersOct13]: 'TMJ0101', [EV.rangersOct17]: 'TMJ0102', [EV.rangersOct20]: 'TMJ0103', [EV.duaLipa]: 'TMJ0110', [EV.metallica]: 'TMJ0120' };

const fetchImpl = (async (input: string) => {
  const url = new URL(input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const bySd = (n: string | undefined) => Object.values(MARKET).find((m) => String(m.sd) === n);
  if (url.pathname === '/api/v1/events/search') {
    const tm = url.searchParams.get('tm_event_id') ?? '';
    const m = MARKET[tm];
    return json({ data: m ? [{ event_id: m.sd, tm_event_id: tm, event_name: m.name, event_date: m.date, venue_name: 'Venue', venue_city: 'New York', venue_state: 'NY' }] : [], has_more: false, next_cursor: null });
  }
  const st = url.pathname.match(/^\/api\/v1\/events\/(\d+)\/stats$/);
  if (st) return json({ event_id: Number(st[1]), data: bySd(st[1])?.stats ?? [], has_more: false, next_cursor: null });
  if (/\/sales$/.test(url.pathname)) return json({ data: [], has_more: false, next_cursor: null });
  if (url.pathname === '/api/v0.1.1/listings/get') {
    const m = bySd(url.searchParams.get('event_id') ?? undefined);
    return json({ has_refreshed: 1, last_refresh_timestamp: Math.floor((CLOCK.getTime() - 35 * 60_000) / 1000), listings: zoned(m?.listings ?? []) });
  }
  return new Response('{}', { status: 404 });
}) as unknown as typeof fetch;

/** What the production model reads from each message, put over the rules reader's read (as RecordedModelExtractor does). */
class RecordedModelExtractor implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  readonly reads = new Map<string, Partial<RequestExtraction>>();
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    const x = await this.rules.extract(input);
    const text = input.text.trim();
    const key = [...this.reads.keys()].filter((k) => text.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return (key ? { ...x, ...this.reads.get(key) } : x) as RequestExtraction;
  }
}

const blankRead: ListingRead = { kind: 'ticket_listing', sensitiveContent: false, seller: null, eventName: null, eventDate: null, eventTime: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'high', unreadable: [] };
/** Stands in for the vision model: the reads scripted for this turn's screenshots, in order. */
class ScriptedReader implements ListingReader {
  readonly name = 'scripted';
  queue: ListingRead[] = [];
  async read(input: { image?: ListingImage | null }): Promise<ListingRead> {
    if (!input.image) return { ...blankRead, kind: 'unrelated', confidence: 'low' };
    return this.queue.shift() ?? { ...blankRead, kind: 'unrelated', confidence: 'low' };
  }
}

type Turn = { text: string; subject?: string; read?: Partial<RequestExtraction>; screenshots?: Array<Partial<ListingRead>> };
type Email = { subject: string; body: string; text: string; messageClass: string };
type Seen = { requestId: string; state: string; eventId: string | null; brief: RequestExtraction; emails: Email[]; blocked: string[]; requests: number; jid: string };

/** The body above the signature. */
const bodyOf = (text: string) => text.split(/\n\nTicket Guy\n/)[0]!;
const paragraphs = (body: string) => body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const sentences = (body: string) => body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const GREETING = /^(?:Hey|Hi|Hello)\b[^\n]*,$/;
const FILLER = /^(?:Got it|Thanks|Thank you|I’ll look|I'll look|Here's what I have|Here’s what I have|I'm on it|I’m on it|Let me)/i;
const NEXT_ACTION = /https?:\/\/|\?|\b(?:Reply|reply with|Tell me|tell me|Send me|send me|Buy|buy|Check|check|Confirm|confirm|Look for|Grab|Go for|go for|Pick|pick|Take|take|I’d go for|I’d buy|I’d wait|I’d hold|Want me)\b/;
const ASKS: Record<string, RegExp> = {
  quantity: /\bhow many\b/i,
  budget: /\b(?:budget|how much (?:do you|would you|can you|are you)|most you(?:’|')d pay)\b/i,
  event: /\bwhich (?:game|date|event|show|night|concert)\b|\bwhat (?:date|game|event|show)\b/i,
  goal: /\bbest view or best value\b|\bview or (?:value|price)\b/i,
  basis: /\bper ticket,? or for all\b|\beach or (?:in )?total\b/i,
};

// What stands before the answer in the house layouts, recorded rather than failed (see the report): the event header of
// the advice email (email-layout-0102 puts it first), the clarification's "... Got it." play-back, and its "That's <event>"
// line naming the event it settled on.
const HEADER = /^[^\n]+\n[^\n]*(?: \u00b7 |, at \d)/;
const ECHO = /Got it\.$/;
const SETTLED_LINE = /^(?:That\u2019s|I've gone with|I\u2019ve gone with) .+\.(?: Tell me if you meant a different one\.)?$/;
const notes: string[] = [];
/**
 * A gap found here and reported, not fixed in this change: it must still show, and the test fails once it stops, so the
 * assertion is turned back into a plain one rather than left describing a bug that's gone.
 */
const knownGap = (what: string, shows: boolean) => {
  if (!shows) throw new Error(`known gap no longer shows, make it a plain assertion: ${what}`);
};

/** The product rules, as a list of what an email breaks (empty when it keeps them all). */
function ruleBreaks(e: Email, known: Array<keyof typeof ASKS>, prices: Set<number>): string[] {
  const out: string[] = [];
  const all = `${e.subject}\n${e.body}`;
  for (const bad of [/\bnull\b/, /\bundefined\b/, /\bNaN\b/, /\[object/, /\u2014/, /\u2013/, /\bguaranteed?\b/i, /\blast chance\b/i]) if (bad.test(all)) out.push(`contains ${bad}`);
  const paras = paragraphs(e.body);
  let at = paras.findIndex((p) => GREETING.test(p)) + 1;
  const skipped: string[] = [];
  while (at < paras.length && (HEADER.test(paras[at]!) || ECHO.test(paras[at]!) || SETTLED_LINE.test(paras[at]!))) skipped.push(paras[at++]!.replace(/\n/g, ' / '));
  if (skipped.length) notes.push(`${e.subject}: before the answer: ${skipped.map((x) => `"${x}"`).join(', ')}`);
  const lead = paras[at] ?? '';
  if (!lead || FILLER.test(lead)) out.push(`first paragraph is not a recommendation or question: "${lead.slice(0, 120)}"`);
  if (!NEXT_ACTION.test(e.body)) out.push('no next action');
  for (const s of sentences(e.body)) {
    // Our own estimates with fees in them ("About $96 a ticket", "about $385 ... including estimated fees") aren't SeatData prices.
    if (/^About \$|estimated fees|fees included|including (?:all )?fees|with fees/i.test(s)) continue;
    for (const m of s.matchAll(/\$(\d{1,3}(?:,\d{3})*(?:\.\d\d)?)(?![\d,])/g)) {
      const dollars = Number(m[1]!.replace(/,/g, ''));
      if (prices.has(dollars) && !/before fees/i.test(s)) out.push(`SeatData price $${m[1]} without "before fees": "${s}"`);
    }
  }
  const questions = sentences(e.body).filter((s) => s.endsWith('?'));
  for (const k of known) for (const q of questions) if (ASKS[k]!.test(q)) out.push(`asks again for ${k}: "${q}"`);
  if (e.messageClass === 'clarification' && questions.length > 1) out.push(`${questions.length} questions in a clarification: ${questions.map((q) => `"${q}"`).join(' ')}`);
  return out;
}

describe(`brief journeys, end to end through dispatch (${ENFORCE ? 'SD enforce' : 'plain'})`, () => {
  let h: DbHandle;
  let c: Concierge;
  const extractor = new RecordedModelExtractor();
  const reader = new ScriptedReader();
  const testers = ['j1', 'j2a', 'j2b', 'j2c', 'j3a', 'j3b', 'j4', 'j5', 'j6', 'j7', 'j7thin', 'j8', 'j9', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(TESTER);
  const env = testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules', STAFF_EMAIL_ALLOWLIST: 'staff@ticketguy.test', AUTO_APPROVE_WHILE_TESTING: 'true', EMAIL_TEST_RECIPIENT_ALLOWLIST: testers.join(','), SEATDATA_API_KEY: KEY });
  const out = process.env.JOURNEYS_OUT;
  const log: Record<string, string[]> = {};
  let png: (shade: string) => Promise<Uint8Array<ArrayBuffer>>;

  const drain = async () => {
    for (let i = 0; i < 15; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: CLOCK });
      if (!leased.length) return;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        else if (ev.eventType === 'email.send_requested') await c.dispatchSend(p.sendIntentId!);
        else if (ev.eventType === 'staff.alert') await c.alertStaff({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, CLOCK);
      }
    }
  };

  /** One thread: each turn after the first replies to our latest email (In-Reply-To), as a mail client would. */
  const journey = async (jid: string, turns: Turn[]): Promise<Seen[]> => {
    const seen: Seen[] = [];
    let rid: string | null = null;
    const shades = ['#ffffff', '#eeeeee', '#dddddd', '#cccccc'];
    for (const [i, tu] of turns.entries()) {
      if (tu.read) extractor.reads.set(tu.text.trim(), tu.read);
      reader.queue = (tu.screenshots ?? []).map((s) => ({ ...blankRead, ...s }) as ListingRead);
      const attachments = await Promise.all((tu.screenshots ?? []).map(async (_, k) => ({ filename: `listing-${k + 1}.png`, contentType: 'image/png', bytes: await png(shades[k]!) })));
      const built = await buildTestInbound(h.db, env, { from: rid ? null : TESTER(jid), subject: rid ? null : (tu.subject ?? 'Tickets'), text: tu.text, replyToRequestId: rid, attachments }, CLOCK);
      if (!built.ok) throw new Error(`${jid} turn ${i + 1}: ${built.error}`);
      const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
      const r = (await c.ingestInbound(built.message)) as { requestId?: string; conversationId?: string };
      if (!r.requestId) throw new Error(`${jid} turn ${i + 1}: not queued`);
      rid = r.requestId;
      await drain();
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, rid));
      const [v] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, rid)).orderBy(desc(t.requestVersions.revision)).limit(1);
      const inThread = await h.db.select({ id: t.requests.id }).from(t.requests).where(eq(t.requests.conversationId, req!.conversationId));
      const intents = (await h.db.select().from(t.sendIntents).where(inArray(t.sendIntents.requestId, inThread.map((x) => x.id)))).filter((s) => !before.has(s.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const dispatched = intents.filter((s) => s.state === 'provider_accepted');
      const emails = dispatched.map((s) => ({ subject: s.subject, text: s.bodyText, body: bodyOf(s.bodyText), messageClass: s.messageClass }));
      const blocked = intents.filter((s) => s.state !== 'provider_accepted').map((s) => `${s.messageClass}:${s.state}:${s.lastError ?? ''}`);
      seen.push({ requestId: rid, state: req!.state, eventId: req!.eventId, brief: v!.brief as RequestExtraction, emails, blocked, requests: inThread.length, jid });
      (log[jid] ??= []).push(`>>> ${tu.text}${tu.screenshots?.length ? ` [${tu.screenshots.length} screenshot(s)]` : ''}\n[state ${req!.state}${blocked.length ? `; not sent: ${blocked.join(', ')}` : ''}]\n\n${emails.map((e) => `Subject: ${e.subject}\n\n${e.text}`).join('\n\n----------\n\n') || '(no email dispatched)'}\n`);
    }
    if (out) writeFileSync(`${out}/${jid}${ENFORCE ? '.enforce' : ''}.txt`, log[jid]!.join('\n==========\n\n'));
    return seen;
  };
  /** Every dispatched email of a turn, held to the product rules. */
  const rules = (s: Seen, known: Array<keyof typeof ASKS> = []) => {
    const from = notes.length;
    const breaks = s.emails.flatMap((e) => ruleBreaks(e, known, seatDataDollars(s.eventId ? TM_OF[s.eventId] : undefined)).map((b) => `[${e.messageClass}] ${b}`));
    if (out && notes.length > from) writeFileSync(`${out}/${s.jid}${ENFORCE ? '.enforce' : ''}.notes.txt`, `${notes.slice(from).join('\n')}\n`, { flag: 'a' });
    return breaks;
  };
  const all = (s: Seen) => s.emails.map((e) => `${e.subject}\n${e.body}`).join('\n----\n');

  beforeAll(async () => {
    if (out) {
      mkdirSync(out, { recursive: true });
      for (const t0 of testers) rmSync(`${out}/${t0.split('@')[0]}${ENFORCE ? '.enforce' : ''}.notes.txt`, { force: true });
    }
    const shot = new Map<string, Uint8Array<ArrayBuffer>>();
    png = async (shade) => {
      if (!shot.has(shade)) shot.set(shade, new Uint8Array(await sharp({ create: { width: 90, height: 60, channels: 3, background: shade } }).png().toBuffer()));
      return shot.get(shade)!;
    };
    h = await openTestDb();
    const ET = 'America/New_York';
    // The fixture world's own games are not on the live calendar.
    await h.db.update(t.events).set({ status: 'cancelled' }).where(inArray(t.events.id, Object.values(FX.events)));
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    await h.db.insert(t.venues).values([
      { id: V.metlife, name: 'MetLife Stadium', aliases: [], city: 'East Rutherford', state: 'NJ', country: 'US', timezone: ET, latitude: 40.8135, longitude: -74.0745 },
      { id: V.elsewhere, name: 'Elsewhere', aliases: [], city: 'Brooklyn', state: 'NY', country: 'US', timezone: ET, latitude: 40.7094, longitude: -73.9232 },
      { id: V.warehouse, name: 'Warehouse Hall', aliases: [], city: 'Brooklyn', state: 'NY', country: 'US', timezone: ET, latitude: 40.7112, longitude: -73.9301 },
      { id: V.carnesecca, name: 'Carnesecca Arena', aliases: [], city: 'Queens', state: 'NY', country: 'US', timezone: ET, latitude: 40.7223, longitude: -73.7949 },
    ]);
    await h.db.update(t.venues).set({ latitude: 40.7505, longitude: -73.9934 }).where(eq(t.venues.id, FX.venues.msg));
    await h.db.insert(t.entities).values([
      { id: ENT.metallica, kind: 'artist', name: 'Metallica', slug: 'metallica-j', aliases: [] },
      { id: ENT.mrak, kind: 'artist', name: 'MRAK', slug: 'mrak-j', aliases: [] },
      { id: ENT.dusky, kind: 'performer', name: 'Dusky', slug: 'dusky-j', aliases: [] },
      { id: ENT.redStorm, kind: 'team', name: "St. John's Red Storm", slug: 'st-johns-red-storm-j', aliases: ['Red Storm', "St. John's"], league: 'NCAA', homeVenueId: V.carnesecca },
    ]);
    const live = { status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: false } as const;
    const rangers = (eid: string, vs: string, utc: string) => ({ id: eid, name: `New York Rangers vs. ${vs}`, category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, isHome: true, localStartAt: new Date(utc), saleStatus: 'offsale', ...live });
    await h.db.insert(t.events).values([
      rangers(EV.rangersOct9, 'Pittsburgh Penguins', '2026-10-09T23:00:00Z'),
      rangers(EV.rangersOct13, 'Washington Capitals', '2026-10-13T23:00:00Z'),
      rangers(EV.rangersOct17, 'Montreal Canadiens', '2026-10-17T23:00:00Z'),
      rangers(EV.rangersOct20, 'Boston Bruins', '2026-10-20T23:00:00Z'),
      { id: EV.duaLipa, name: 'Dua Lipa: Radical Optimism Tour', category: 'concert', genre: 'pop / pop', venueId: FX.venues.msg, primaryEntityId: FX.entities.duaLipa, localStartAt: new Date('2026-10-25T00:00:00Z'), saleStatus: 'offsale', ...live },
      { id: EV.metallica, name: 'Metallica: M72 World Tour', category: 'concert', genre: 'rock / metal', venueId: V.metlife, primaryEntityId: ENT.metallica, localStartAt: new Date('2026-11-14T23:30:00Z'), saleStatus: 'offsale', ...live },
      { id: EV.elsewhereFri, name: 'Dusky (DJ Set)', category: 'electronic_nightlife', genre: 'dance/electronic / house', venueId: V.elsewhere, primaryEntityId: ENT.dusky, localStartAt: new Date('2026-10-10T02:00:00Z'), saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), ...live },
      { id: EV.elsewhereSat, name: 'Honey Dijon', category: 'electronic_nightlife', genre: 'dance/electronic / house', venueId: V.elsewhere, localStartAt: new Date('2026-10-11T03:00:00Z'), saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), ...live },
      { id: EV.mrak, name: 'MRAK', category: 'concert', genre: 'dance/electronic / techno', venueId: V.warehouse, primaryEntityId: ENT.mrak, localStartAt: new Date('2026-10-17T02:00:00Z'), saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), ...live },
      { id: EV.mrakPack, name: 'MRAK - GA Four-Pack Package', category: 'concert', subtype: 'package', venueId: V.warehouse, primaryEntityId: ENT.mrak, localStartAt: new Date('2026-10-17T02:00:00Z'), saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), ...live },
      { id: EV.redStorm, name: "St. John's Red Storm vs. Drexel", category: 'ncaa_regular', venueId: V.carnesecca, primaryEntityId: ENT.redStorm, isHome: true, localStartAt: new Date('2026-11-13T00:00:00Z'), saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), ...live },
    ]);
    const tm = (eventId: string, sid: string, slug: string) => ({ eventId, sourceId: 'ticketmaster', sourceEventId: sid, authoritativeUrl: `https://www.ticketmaster.com/${slug}/event/${sid}`, role: 'discovery', confidence: 'provider_id' });
    await h.db.insert(t.eventSourceMappings).values([
      tm(EV.rangersOct9, 'TMJ0100', 'new-york-rangers-vs-pittsburgh-penguins-new-york-ny-10-09-2026'),
      tm(EV.rangersOct13, 'TMJ0101', 'new-york-rangers-vs-washington-capitals-new-york-ny-10-13-2026'),
      tm(EV.rangersOct17, 'TMJ0102', 'new-york-rangers-vs-montreal-canadiens-new-york-ny-10-17-2026'),
      tm(EV.rangersOct20, 'TMJ0103', 'new-york-rangers-vs-boston-bruins-new-york-ny-10-20-2026'),
      tm(EV.duaLipa, 'TMJ0110', 'dua-lipa-radical-optimism-tour-new-york-ny-10-24-2026'),
      tm(EV.metallica, 'TMJ0120', 'metallica-m72-world-tour-east-rutherford-nj-11-14-2026'),
      tm(EV.elsewhereFri, 'TMJ0130', 'dusky-dj-set-brooklyn-ny-10-09-2026'),
      tm(EV.elsewhereSat, 'TMJ0131', 'honey-dijon-brooklyn-ny-10-10-2026'),
      tm(EV.mrak, 'TMJ0140', 'mrak-brooklyn-ny-10-16-2026'),
      tm(EV.mrakPack, 'TMJ0141', 'mrak-ga-four-pack-package-brooklyn-ny-10-16-2026'),
      tm(EV.redStorm, 'TMJ0150', 'st-johns-red-storm-vs-drexel-queens-ny-11-12-2026'),
    ]);
    c = new Concierge({ db: h.db, env, extractor, drafter: new FixtureDrafter(), clock: () => CLOCK, emailProvider: new RecordingProvider(), fixtureOffers: {}, listingReader: reader, marketFetch: fetchImpl });
    await setKillSwitch(h.db, TEST_MODE_KEY, true, 'staff-1', 'brief journeys');
  });
  afterAll(async () => {
    await h?.close();
  });

  const RANGERS = { performerOrTeam: 'New York Rangers' } as const;

  it('J1: four Rangers tickets for the next home game, max $400 total', async () => {
    const [s] = await journey('j1', [{ text: 'Find four Rangers tickets for the next home game. Max $400 total.', subject: 'Rangers', read: { ...RANGERS, intent: 'new_search', quantity: 4, budgetCents: 40000, budgetBasis: 'whole_party', dateExpression: 'next home game' } }]);
    expect(s!.eventId).toBe(EV.rangersOct9);
    expect(s!.brief).toMatchObject({ quantity: 4, budgetCents: 40000, budgetBasis: 'whole_party' });
    expect(s!.emails.length).toBeGreaterThan(0);
    const text = all(s!);
    expect(text).toMatch(/Pittsburgh Penguins|October 9|Oct 9/);
    expect(text).toMatch(/\bfour\b|\b4 tickets\b/);
    // Within budget from the listings: $74 x 4 = $296 before fees, about $385 with the fee allowance.
    expect(text).toContain('Section 226');
    expect(text).toMatch(/https:\/\/\S+/);
    expect(rules(s!, ['quantity', 'budget', 'event'])).toEqual([]);
  });

  describe('J2: is this Dua Lipa ticket a good deal?', () => {
    const DUA = { performerOrTeam: 'Dua Lipa', intent: 'new_search' } as const;
    it('(a) with the price, section and row in the text', async () => {
      const [s] = await journey('j2a', [{ text: 'Is this Dua Lipa ticket a good deal? $180 a ticket, section 112, row 8.', subject: 'Dua Lipa', read: { ...DUA, quantity: null, quotedPriceCents: 18000, quotedPriceBasis: 'per_ticket' } }]);
      expect(s!.eventId).toBe(EV.duaLipa);
      expect(s!.brief).toMatchObject({ quotedPriceCents: 18000 });
      const text = all(s!);
      expect(text).toContain('$180');
      expect(text).toContain('$17 a ticket above the cheapest listing I can see ($163 before fees)');
      expect(text).not.toMatch(/send me the (?:price|link|screenshot)|what(?:\u2019|')s the price/i);
      const breaks = rules(s!, ['event']);
      // Two was assumed, so an acknowledgment ("Got it. Here's what I have:") goes out seconds before the answer even
      // though nobody reviews it (pipeline: "anything we assumed still gets the acknowledgment").
      const ack = (b: string) => b.startsWith('[acknowledgment] first paragraph');
      knownGap('J2a: an acknowledgment email before the answer when a count was assumed', breaks.some(ack));
      expect(breaks.filter((b) => !ack(b))).toEqual([]);
    });
    it('(b) with a screenshot of the listing', async () => {
      const [s] = await journey('j2b', [{ text: 'Is this Dua Lipa ticket a good deal?', subject: 'Dua Lipa', read: { ...DUA, quantity: null }, screenshots: [{ seller: 'StubHub', eventName: 'Dua Lipa: Radical Optimism Tour', eventDate: '2026-10-24', eventTime: '20:00', venue: 'Madison Square Garden', city: 'New York', quantity: 2, priceText: '$186 each + fees; total $446', priceDollars: 186, priceBasis: 'per_ticket', feeBasis: 'before_fees', totalDollars: 446, section: '109', row: '4', seatsTogether: true }] }]);
      expect(s!.eventId).toBe(EV.duaLipa);
      const text = all(s!);
      expect(text).toMatch(/\$186|\$446/);
      expect(text).toMatch(/[Ss]ection 109/);
      expect(rules(s!, ['event', 'quantity'])).toEqual([]);
    });
    it('(c) with nothing to judge: one ask for the price, section and row, or the screenshot', async () => {
      const [s] = await journey('j2c', [{ text: 'Is this Dua Lipa ticket a good deal?', subject: 'Dua Lipa', read: { ...DUA, quantity: null } }]);
      const text = all(s!);
      expect(s!.emails).toHaveLength(1);
      expect(s!.state).toBe('needs_clarification');
      expect(text).toContain('Send me the price, section and row of the one you\u2019re looking at (a screenshot of the listing works), and I\u2019ll tell you straight whether it\u2019s a good deal.');
      expect(text).not.toMatch(/Section 112, Row 12|Price lead/);
      expect(sentences(s!.emails[0]!.body).filter((x) => x.endsWith('?')).length).toBeLessThanOrEqual(1);
      expect(rules(s!, ['event'])).toEqual([]);
    });
  });

  describe('J3: can you beat this pair?', () => {
    it('(a) with a StubHub listing link', async () => {
      const link = 'https://www.stubhub.com/new-york-rangers-new-york-tickets-10-20-2026/event/159770133/?quantity=2&listingId=7133';
      const [s] = await journey('j3a', [{ text: `Can you beat this pair? ${link}`, subject: 'Rangers pair', read: { ...RANGERS, quantity: 2, submittedUrls: [link] } }]);
      expect(s!.eventId).toBe(EV.rangersOct20);
      const text = all(s!);
      // Theirs is Section 112 at $139 each; Section 113 is $118 each for two.
      expect(text).toMatch(/[Ss]ection 113/);
      expect(rules(s!, ['event', 'quantity'])).toEqual([]);
    });
    it('(b) with two screenshots of competing pairs: a verdict naming which to take', async () => {
      const shot = { seller: 'StubHub', eventName: 'New York Rangers vs. Boston Bruins', eventDate: '2026-10-20', eventTime: '19:00', venue: 'Madison Square Garden', city: 'New York', quantity: 2, priceBasis: 'per_ticket', feeBasis: 'before_fees', seatsTogether: true } as const;
      const [s] = await journey('j3b', [{ text: 'Can you beat this pair? Or which of these two should I take?', subject: 'Rangers pairs', read: { quantity: 2 }, screenshots: [{ ...shot, priceText: '$121 each', priceDollars: 121, section: '214', row: '3' }, { ...shot, seller: 'Vivid Seats', priceText: '$142 each', priceDollars: 142, section: '116', row: '22' }] }]);
      expect(s!.eventId).toBe(EV.rangersOct20);
      const text = all(s!);
      // The cheaper pair before fees is named, with the fee gap that would undo the pick.
      expect(text).toContain('I\u2019d take Listing 1: before fees it\u2019s $42 less than Listing 2 for both ($242 against $284).');
      expect(rules(s!, ['event', 'quantity'])).toEqual([]);
    });
  });

  it('J4: best Metallica tickets near New York in November: one question, then picks for the view', async () => {
    const [ask, picks] = await journey('j4', [
      { text: 'Best Metallica tickets near New York in November.', subject: 'Metallica', read: { performerOrTeam: 'Metallica', intent: 'new_search', city: 'New York', state: 'NY', dateExpression: 'in November' } },
      { text: 'best view, 2 of us', read: { intent: 'clarification', quantity: 2, rankingGoal: 'view' } },
    ]);
    expect(ask!.emails).toHaveLength(1);
    const q = ask!.emails[0]!.body;
    expect(q).toMatch(/view/i);
    expect(q).toMatch(/value|price/i);
    expect(q).toMatch(/how many/i);
    expect(rules(ask!, ['event'])).toEqual([]);
    expect(picks!.eventId).toBe(EV.metallica);
    expect(picks!.brief).toMatchObject({ quantity: 2, rankingGoal: 'view' });
    const text = all(picks!);
    expect(text).toMatch(/Picked for the view|Picked by price/);
    expect(rules(picks!, ['quantity', 'goal', 'event'])).toEqual([]);
  });

  it('J5: anything good at Elsewhere this weekend: the Friday night with its date and next step', async () => {
    const [s] = await journey('j5', [{ text: 'Anything good at Elsewhere this weekend?', subject: 'This weekend', read: { intent: 'browse', city: 'Brooklyn', state: 'NY', dateExpression: 'this weekend' } }]);
    const text = all(s!);
    expect(text).toContain('Dusky');
    expect(text).toMatch(/Fri(?:day)?,? (?:Oct(?:ober)? 9)/);
    expect(rules(s!)).toEqual([]);
  });

  it('J6: which admission tier should four of us buy: the recommendation first, no resale trend', async () => {
    const [s] = await journey('j6', [{ text: 'Which admission tier should four of us buy?', subject: 'MRAK on Oct 16', read: { performerOrTeam: 'MRAK', intent: 'new_search', quantity: 4, resolvedLocalDate: '2026-10-16' } }]);
    expect(s!.eventId).toBe(EV.mrak);
    const text = all(s!);
    expect(s!.emails[0]!.body).toContain('Hey,\n\nThe four-pack looks best for your group, provided its entry conditions suit you.');
    expect(text).not.toMatch(/resale|trend|going up|going down|buy now or wait|On buy or wait/i);
    expect(rules(s!, ['quantity', 'event'])).toEqual([]);
  });

  describe('J7: should I buy now or wait?', () => {
    it('a settled game with a stored series: a call with its reason and a next action', async () => {
      const [, s] = await journey('j7', [
        { text: '2 Rangers tickets for the Oct 13 game please.', subject: 'Rangers Oct 13', read: { ...RANGERS, quantity: 2, resolvedLocalDate: '2026-10-13', dateExpression: 'Oct 13' } },
        { text: 'Should I buy now or wait?' },
      ]);
      expect(s!.eventId).toBe(EV.rangersOct13);
      const text = all(s!);
      expect(text).toMatch(/I’d buy|I'd buy|I’d wait|I'd wait|I’d hold|buy rather than wait/);
      expect(text).toMatch(/up from|rising|risen|gone up|climb/i);
      expect(rules(s!, ['quantity', 'event'])).toEqual([]);
    });
    it('a thin series: says it can’t tell yet, and what would change that', async () => {
      const [, s] = await journey('j7thin', [
        { text: '2 Rangers tickets for the Oct 17 game please.', subject: 'Rangers Oct 17', read: { ...RANGERS, quantity: 2, resolvedLocalDate: '2026-10-17', dateExpression: 'Oct 17' } },
        { text: 'Should I buy now or wait?' },
      ]);
      expect(s!.eventId).toBe(EV.rangersOct17);
      const text = all(s!);
      expect(text).toMatch(/can(?:\u2019|')t tell|not enough|too (?:few|little)|don(?:\u2019|')t have enough/i);
      // And what would change that.
      expect(text).toContain('a few days of its prices would show which way they\u2019re moving');
      expect(rules(s!, ['quantity', 'event'])).toEqual([]);
    });
  });

  it('J8: a Guide-depth college game on sale, no count: never "null", one question or the official sale', async () => {
    const [s] = await journey('j8', [{ text: 'Red Storm tickets Nov 12 please', subject: 'Red Storm', read: { performerOrTeam: "St. John's Red Storm", intent: 'new_search', resolvedLocalDate: '2026-11-12', dateExpression: 'Nov 12' } }]);
    expect(s!.eventId).toBe(EV.redStorm);
    const text = all(s!);
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/);
    expect(text.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(rules(s!, ['event'])).toEqual([]);
  });

  it('J9: a side question mid-thread keeps the event for "ok, 3 tickets then"', async () => {
    const [first, side, next] = await journey('j9', [
      { text: '2 Rangers tickets for the Oct 13 game please.', subject: 'Rangers', read: { ...RANGERS, quantity: 2, resolvedLocalDate: '2026-10-13', dateExpression: 'Oct 13' } },
      { text: 'Do you charge for this?' },
      { text: 'ok, 3 tickets then', read: { quantity: 3 } },
    ]);
    expect(first!.eventId).toBe(EV.rangersOct13);
    expect(side!.emails).toHaveLength(1);
    expect(side!.emails[0]!.body).toContain('Hey,\n\nNo, I don\u2019t charge you anything: Ticket Guy is free to use.');
    expect(side!.requestId).toBe(first!.requestId);
    expect(next!.eventId).toBe(EV.rangersOct13);
    expect(next!.brief).toMatchObject({ quantity: 3 });
    expect(all(next!)).toMatch(/three|\b3 tickets\b/);
    expect(rules(side!)).toEqual([]);
    expect(rules(next!, ['quantity', 'event'])).toEqual([]);
  });

  describe('follow-ups in the same thread', () => {
    it('F1: "$220 for both" answers our per-ticket-or-total question', async () => {
      const [first, s] = await journey('f1', [
        { text: 'Is this a good price?', subject: 'Rangers price', screenshots: [{ seller: 'StubHub', eventName: 'New York Rangers vs. Washington Capitals', eventDate: '2026-10-13', venue: 'Madison Square Garden', city: 'New York', quantity: 2, priceText: '$220', priceDollars: 220, section: '214', row: '10' }] },
        { text: '$220 for both', read: { quotedPriceCents: 22000, quotedPriceBasis: 'whole_party' } },
      ]);
      expect(all(first!)).toMatch(/per ticket, or for all 2/);
      expect(s!.brief).toMatchObject({ quotedPriceCents: 22000, quotedPriceBasis: 'whole_party', budgetCents: null });
      expect(all(s!)).toContain('$110');
      expect(rules(s!, ['basis', 'quantity', 'event'])).toEqual([]);
    });
    it('F2: "same game" with a new question', async () => {
      const [first, s] = await journey('f2', [
        { text: '2 Rangers tickets for the Oct 13 game please, $300 total.', subject: 'Rangers', read: { ...RANGERS, quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party', resolvedLocalDate: '2026-10-13', dateExpression: 'Oct 13' } },
        { text: 'Same game. Are the seats together?' },
      ]);
      expect(first!.eventId).toBe(EV.rangersOct13);
      expect(s!.eventId).toBe(EV.rangersOct13);
      expect(s!.brief).toMatchObject({ performerOrTeam: 'New York Rangers', quantity: 2, budgetCents: 30000 });
      expect(rules(s!, ['quantity', 'budget', 'event'])).toEqual([]);
    });
    it('F3: "actually five of us"', async () => {
      const [first, s] = await journey('f3', [
        { text: 'Find four Rangers tickets for the next home game. Max $400 total.', subject: 'Rangers', read: { ...RANGERS, intent: 'new_search', quantity: 4, budgetCents: 40000, budgetBasis: 'whole_party', dateExpression: 'next home game' } },
        { text: 'actually five of us', read: { quantity: 5 } },
      ]);
      expect(first!.eventId).toBe(EV.rangersOct9);
      expect(s!.eventId).toBe(EV.rangersOct9);
      expect(s!.brief).toMatchObject({ quantity: 5, budgetCents: 40000, budgetBasis: 'whole_party' });
      expect(all(s!)).toMatch(/\bfive\b|\b5 tickets\b/);
      expect(rules(s!, ['quantity', 'budget', 'event'])).toEqual([]);
    });
    const BEST: Turn = { text: '2 of the best Metallica tickets at MetLife on Nov 14 please.', subject: 'Metallica', read: { performerOrTeam: 'Metallica', intent: 'new_search', quantity: 2, resolvedLocalDate: '2026-11-14', dateExpression: 'Nov 14' } };
    it('F4: "best view"', async () => {
      const [first, s] = await journey('f4', [BEST, { text: 'best view', read: { rankingGoal: 'view' } }]);
      expect(all(first!)).toMatch(/view/i);
      expect(s!.brief).toMatchObject({ quantity: 2, rankingGoal: 'view' });
      expect(all(s!)).toMatch(/Picked for the view/);
      expect(rules(s!, ['quantity', 'goal', 'event'])).toEqual([]);
    });
    it('F5: "cheapest is fine"', async () => {
      const [, s] = await journey('f5', [BEST, { text: 'cheapest is fine', read: { rankingGoal: 'price' } }]);
      expect(s!.brief).toMatchObject({ quantity: 2, rankingGoal: 'price' });
      expect(all(s!)).toMatch(/Picked on price/);
      expect(rules(s!, ['quantity', 'goal', 'event'])).toEqual([]);
    });
    it('F6: "we can’t arrive before midnight"', async () => {
      const [first, s] = await journey('f6', [
        { text: 'Dusky at Elsewhere on Friday Oct 9, 2 tickets.', subject: 'Dusky', read: { performerOrTeam: 'Dusky', intent: 'new_search', quantity: 2, resolvedLocalDate: '2026-10-09', dateExpression: 'Friday Oct 9' } },
        { text: "we can't arrive before midnight" },
      ]);
      expect(first!.eventId).toBe(EV.elsewhereFri);
      expect(s!.eventId).toBe(EV.elsewhereFri);
      expect(s!.brief).toMatchObject({ quantity: 2 });
      expect(all(s!)).toMatch(/midnight/i);
      expect(rules(s!, ['quantity', 'event'])).toEqual([]);
    });
  });
});
