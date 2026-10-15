/**
 * Runs one email thread through the real pipeline (real model, eval world, in-memory database, no email sent).
 * A thread is a list of steps: a customer email (text, optional screenshots), or time passing (the market can move
 * and price alerts are checked). Every email Ticket Guy produces is captured with its class, text and HTML.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { openTestDb, inbound, testEnv } from '../tests/harness';
import * as t from '@/lib/db/schema';
import { Concierge } from '@/lib/intake/pipeline';
import { ModelDrafter, ModelExtractor, ModelListingReader } from '@/lib/ai/model-client';
import { OpenAiClient } from '@/lib/ai/openai';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import type { Offer, RequestExtraction } from '@/lib/domain/types';
import { seedWorld, worldOffers } from './world';

export type Expect = {
  eventId?: string | null;
  /** Any of these events is acceptable (e.g. "a Rangers game this week" with two candidates). */
  eventIdIn?: string[];
  quantity?: number;
  budgetCents?: number;
  budgetBasis?: 'per_ticket' | 'whole_party';
  /** At least one of these must appear in the reply. Each entry may be a regex source prefixed with "re:". */
  mustMentionAny?: string[];
  /** Every one of these must appear. */
  mustMentionAll?: string[];
  /** None may appear (e.g. a game the customer didn't pick, a price that no longer exists). */
  forbid?: string[];
  /** A closing message ("thanks, all set") must not produce a new recommendation. */
  noNewRecommendation?: boolean;
  /** The reply should ask exactly one clarifying question (ambiguous request). */
  asksOneQuestion?: boolean;
  /** A price alert must be on file after this step, for this event and target. */
  watch?: { eventId: string; targetTotalCents?: number };
  /** After time passes: exactly this many alert emails. */
  alertsRaised?: number;
};

export type Screenshot = { marketplace: string; event: string; when: string; section: string; row: string; quantity: number; totalDollars: number; feesIncluded: boolean; blurry?: boolean };
export type Step =
  | { kind?: 'email'; text: string; screenshots?: Screenshot[]; expect?: Expect; /** Real images (production replay). */ images?: Array<{ mime: string; base64: string }>; /** Absolute send time (production replay); default 15 minutes after the last step. */ at?: string; subject?: string }
  | { kind: 'wait'; hours: number; market?: (offers: Record<string, Offer[]>) => void; checkAlerts?: boolean; expect?: Expect; note?: string };
export type Scenario = {
  id: string; capability: string; tags?: string[]; now?: string; steps: Step[];
  /** Env overrides, e.g. a feature that is off in production but under test (tagged flag-off-in-prod). */
  env?: Record<string, string>;
  /** Simulated customer: writes the next step from the thread so far; null ends the thread. Steps run first. */
  next?: (soFar: TurnOut[]) => Promise<Step | null>;
  maxSteps?: number;
  /** 'none' skips the eval world (production replay brings its own catalog slice). */
  world?: 'eval' | 'none';
  /** Extra catalog rows (production replay), seeded after the eval world. */
  seed?: (db: Parameters<typeof seedWorld>[0]) => Promise<void>;
  /** Extra listings by event id (production replay), added to the eval world's. */
  offers?: Record<string, Offer[]>;
  /** Prices the thread may quote beyond the eval world's (production replay), in cents. */
  groundedCents?: number[];
  /** Links the thread may contain beyond the eval world's (production replay: the recorded catalog and what the customer sent). */
  groundedLinks?: string[];
};

export type Email = { cls: string; subject: string; text: string; html: string };
export type TurnOut = {
  step: number;
  customer: string;
  at: string;
  reply: string;
  emails: Email[];
  state: string | null;
  eventId: string | null;
  brief: RequestExtraction | null;
  newRecommendations: number;
  watches: Array<{ eventId: string; targetTotalCents: number; quantity: number; state: string; pauseReason: string | null }>;
  /** Price alerts raised this step (pending staff approval before any email goes out). */
  alertsRaised: number;
  alertRun?: unknown;
  expect?: Expect;
};

/** A plausible marketplace checkout screenshot, drawn locally (no real site is reproduced). */
export async function screenshot(s: Screenshot): Promise<Uint8Array<ArrayBuffer>> {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const price = `$${s.totalDollars.toLocaleString('en-US')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="750" height="520" viewBox="0 0 750 520">
  <rect width="750" height="520" fill="#ffffff"/>
  <rect width="750" height="64" fill="#3b2a8c"/>
  <text x="28" y="42" font-family="Helvetica, Arial" font-size="26" font-weight="700" fill="#fff">${esc(s.marketplace)}</text>
  <text x="28" y="118" font-family="Helvetica, Arial" font-size="26" font-weight="700" fill="#111">${esc(s.event)}</text>
  <text x="28" y="154" font-family="Helvetica, Arial" font-size="20" fill="#555">${esc(s.when)}</text>
  <rect x="28" y="188" width="694" height="210" rx="12" fill="#f4f4f7" stroke="#ddd"/>
  <text x="56" y="236" font-family="Helvetica, Arial" font-size="22" fill="#111">Section ${esc(s.section)} · Row ${esc(s.row)}</text>
  <text x="56" y="276" font-family="Helvetica, Arial" font-size="20" fill="#555">${s.quantity} tickets · seats together</text>
  <text x="56" y="350" font-family="Helvetica, Arial" font-size="36" font-weight="700" fill="#111">${price}</text>
  <text x="56" y="380" font-family="Helvetica, Arial" font-size="18" fill="#555">${s.feesIncluded ? 'Total incl. fees' : 'Before fees'}</text>
  <rect x="28" y="430" width="694" height="60" rx="30" fill="#3b2a8c"/>
  <text x="375" y="469" text-anchor="middle" font-family="Helvetica, Arial" font-size="22" font-weight="700" fill="#fff">Buy now</text>
</svg>`;
  let img = sharp(Buffer.from(svg)).png();
  if (s.blurry) img = sharp(await img.toBuffer()).blur(4).png();
  return new Uint8Array(await img.toBuffer());
}

/**
 * Drafts go out as the system writes them, as they do in production: there the testers' allowlist turns on
 * auto-approval (AUTO_APPROVE_WHILE_TESTING), and at launch AUTO_SEND_RECOMMENDATIONS does (owner's decision, Oct 9).
 * The code default, an empty allowlist, holds every answer for a person no one is staffing, and the eval then scored
 * the "a person is checking this" note as a second email the customer never gets (#155). A scenario about review
 * sets AUTO_SEND_RECOMMENDATIONS to "false".
 */
/** Our public URL in the eval: https, as in production, so the email's images (served from it) are rendered. */
export const EVAL_APP_URL = 'https://ticketguy.now';
const env = (over: Record<string, string> = {}) => testEnv({ AI_GLOBAL_DAILY_BUDGET_USD: process.env.EVAL_BUDGET_USD ?? '10', AUTO_SEND_RECOMMENDATIONS: 'true', APP_URL: EVAL_APP_URL, ...over });

let threadNo = 0;
/** Swap in other AI parts (the rule-based fixtures) to replay a scenario without a model key. */
export type ThreadAi = { extractor: ConstructorParameters<typeof Concierge>[0]['extractor']; drafter: ConstructorParameters<typeof Concierge>[0]['drafter']; listingReader?: ConstructorParameters<typeof Concierge>[0]['listingReader'] };

export async function runThread(s: Scenario, openaiKey: string, ai?: ThreadAi): Promise<TurnOut[]> {
  const h = await openTestDb();
  try {
    if (s.world !== 'none') await seedWorld(h.db);
    await s.seed?.(h.db);
    const e = env(s.env);
    const client = ai ? null : new OpenAiClient(openaiKey);
    const model = e.OPENAI_BASE_MODEL;
    const effort = e.OPENAI_BASE_EFFORT;
    let now = s.now ? new Date(s.now) : FIXTURE_NOW;
    const offers = { ...(s.world === 'none' ? {} : worldOffers()), ...(s.offers ? Object.fromEntries(Object.entries(s.offers).map(([k, v]) => [k, v.map((x) => ({ ...x }))])) : {}) };
    const c = new Concierge({
      db: h.db, env: e, clock: () => now, emailProvider: null, fixtureOffers: offers,
      ...(ai ?? { extractor: new ModelExtractor(client!, model, effort), drafter: new ModelDrafter(client!, model, effort), listingReader: new ModelListingReader(client!, model, effort) }),
    });
    const from = `eval-${++threadNo}-${s.id}@customer.example`;
    let prev: ReturnType<typeof inbound> | null = null;
    const conversations = new Set<string>();
    const out: TurnOut[] = [];

    const drain = async () => {
      for (let i = 0; i < 8; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(now.getTime() + 10_000) });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, now);
        }
      }
    };
    // What production's dispatcher does seconds later, recorded here because the send gate never sends eval (fixture)
    // data: the email is accepted and an approved answer is marked sent. Without it the next message found the answer
    // still "approved", invalidated it as superseded, and every follow-up was read as a first reply (#160).
    const deliver = async () => {
      const queued = await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.recipient, from), eq(t.sendIntents.state, 'queued')));
      for (const x of queued) {
        await h.db.update(t.sendIntents).set({ state: 'provider_accepted', providerMessageId: `eval-${x.id}`, submittedAt: now }).where(eq(t.sendIntents.id, x.id));
        if (!x.approvalId) continue;
        await h.db.update(t.recommendations).set({ reviewStatus: 'sent' }).where(and(eq(t.recommendations.id, x.approvalId), eq(t.recommendations.reviewStatus, 'approved')));
        if (x.requestId) await h.db.update(t.requests).set({ state: 'recommendation_sent' }).where(and(eq(t.requests.id, x.requestId), eq(t.requests.state, 'awaiting_review')));
      }
    };
    const snapshot = async () => ({
      sends: new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((r) => r.id)),
      recs: new Set((await h.db.select({ id: t.recommendations.id }).from(t.recommendations)).map((r) => r.id)),
    });
    const collect = async (i: number, customer: string, before: Awaited<ReturnType<typeof snapshot>>, requestId: string | null, expect?: Expect): Promise<TurnOut> => {
      const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.recipient, from))).filter((x) => !before.sends.has(x.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const x of sends) if (x.conversationId) conversations.add(x.conversationId);
      const inThread = conversations.size ? (await h.db.select({ id: t.requests.id }).from(t.requests).where(inArray(t.requests.conversationId, [...conversations]))).map((q) => q.id) : [];
      const recs = inThread.length ? (await h.db.select().from(t.recommendations).where(inArray(t.recommendations.requestId, inThread))).filter((x) => !before.recs.has(x.id)) : [];
      const [req] = requestId ? await h.db.select().from(t.requests).where(eq(t.requests.id, requestId)) : [];
      const [v] = requestId ? await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId)).orderBy(desc(t.requestVersions.revision)).limit(1) : [];
      const [contact] = await h.db.select({ id: t.contacts.id }).from(t.contacts).where(eq(t.contacts.emailLookup, from.toLowerCase()));
      const ws = contact ? await h.db.select().from(t.watches).where(eq(t.watches.contactId, contact.id)) : [];
      const watches = ws.map((w) => ({ eventId: w.eventId, targetTotalCents: w.targetTotalCents, quantity: w.quantity, state: w.state, pauseReason: w.pauseReason }));
      const alertsNow = ws.length ? (await h.db.select({ id: t.watchAlerts.id }).from(t.watchAlerts).where(inArray(t.watchAlerts.watchId, ws.map((w) => w.id)))).length : 0;
      const alertsRaised = alertsNow - alertsSeen;
      alertsSeen = alertsNow;
      // An answer that went out (approved, or a price check sent on its own) is its send; counting its draft too
      // made one email two ("no_result, recommendation", #155). A draft still waiting is the answer to come.
      const sent = new Set(sends.flatMap((x) => [x.approvalId, /^rec:([^:]+):/.exec(x.dedupeKey ?? '')?.[1]]).filter(Boolean));
      const emails: Email[] = [...sends.map((x) => ({ cls: x.messageClass, subject: x.subject, text: x.bodyText, html: x.bodyHtml })), ...recs.filter((x) => !sent.has(x.id)).map((x) => ({ cls: 'recommendation', subject: x.subject, text: x.bodyText, html: x.bodyHtml }))];
      return { step: i + 1, customer, at: now.toISOString(), reply: emails.map((m) => m.text).filter(Boolean).join('\n----\n'), emails, state: req?.state ?? null, eventId: req?.eventId ?? null, brief: (v?.brief as RequestExtraction) ?? null, newRecommendations: recs.length, watches, alertsRaised, expect };
    };

    let lastRequest: string | null = null;
    let alertsSeen = 0;
    const queue = [...s.steps];
    for (let i = 0; i < (s.maxSteps ?? 40); i++) {
      const st = queue.shift() ?? (s.next ? await s.next(out) : null);
      if (!st) break;
      const before = await snapshot();
      if (st.kind === 'wait') {
        now = new Date(now.getTime() + st.hours * 3_600_000);
        st.market?.(offers);
        const alertRun = st.checkAlerts ? { watches: await c.evaluateDueWatches(50), events: await c.evaluateEventAlerts({ limit: 50 }) } : undefined;
        await drain();
      await deliver();
        out.push({ ...(await collect(i, `[${st.note ?? `${st.hours}h pass`}]`, before, lastRequest, st.expect)), alertRun });
        continue;
      }
      now = st.at ? new Date(st.at) : new Date(now.getTime() + 15 * 60_000); // a customer replies a little while after the last email
      const attachments = [
        ...(await Promise.all((st.screenshots ?? []).map(async (sc, k) => ({ providerAttachmentId: `img-${threadNo}-${i}-${k}`, filename: `IMG_${4810 + k}.png`, declaredMimeType: 'image/png', bytes: await screenshot(sc), inline: false })))),
        ...(st.images ?? []).map((im, k) => ({ providerAttachmentId: `real-${threadNo}-${i}-${k}`, filename: `image-${k + 1}.${im.mime.split('/')[1] ?? 'png'}`, declaredMimeType: im.mime, bytes: new Uint8Array(Buffer.from(im.base64, 'base64')), inline: false })),
      ];
      const m = inbound({ text: st.text, from, subject: st.subject ?? (prev ? 'Re: Tickets' : 'Tickets'), receivedAt: now, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, attachments });
      const r = (await c.ingestInbound(m)) as { requestId?: string; conversationId?: string };
      prev = m;
      if (r.conversationId) conversations.add(r.conversationId);
      if (r.requestId) lastRequest = r.requestId;
      await drain();
      await deliver();
      const shots = (st.screenshots?.length ?? 0) + (st.images?.length ?? 0);
      out.push(await collect(i, st.text + (shots ? `  [+${shots} screenshot]` : ''), before, lastRequest, st.expect));
    }
    return out;
  } finally {
    await h.close();
  }
}
