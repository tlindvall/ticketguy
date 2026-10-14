/**
 * Ticket Guy conversation evals (Braintrust). Real pipeline, real model, fixture inventory, no email sent.
 *
 *   pnpm eval            # needs OPENAI_API_KEY in .env.local and BRAINTRUST_API_KEY in .env.braintrust
 *
 * Each scenario is one email thread run in-process on its own in-memory database (the same driver the
 * acceptance tests use), so inventory is fixed and runs are comparable across versions. Spend is capped by
 * the app's own budget ledger: AI_GLOBAL_DAILY_BUDGET_USD (default 10) applies per run because every run
 * starts from an empty database. Scores are deterministic invariants plus one model-graded check.
 */
import { execSync } from 'node:child_process';
import { desc, eq, inArray } from 'drizzle-orm';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { Eval, wrapOpenAI } from 'braintrust';
import { openTestDb, inbound, testEnv } from '../tests/harness';
import * as t from '@/lib/db/schema';
import { Concierge } from '@/lib/intake/pipeline';
import { ModelDrafter, ModelExtractor } from '@/lib/ai/model-client';
import { OpenAiClient } from '@/lib/ai/openai';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW, FIXTURE_OFFERS, FIXTURE_HISTORICAL_EVENTS, FX } from '@/lib/fixtures';
import { SERVICE_DOMAIN } from '@/lib/config/brand';
import type { RequestExtraction } from '@/lib/domain/types';

const E = FX.events;
const NOW = FIXTURE_NOW;

type Expect = {
  eventId?: string | null;
  quantity?: number;
  budgetCents?: number;
  budgetBasis?: 'per_ticket' | 'whole_party';
  /** At least one of these must appear in the reply. */
  mustMentionAny?: string[];
  /** None of these may appear in the reply (e.g. a game the customer didn't pick). */
  forbid?: string[];
  /** A closing message ("thanks, all set") must not produce a new recommendation. */
  noNewRecommendation?: boolean;
};
type Turn = { text: string; expect?: Expect };
type Scenario = { id: string; capability: string; turns: Turn[] };

const SCENARIOS: Scenario[] = [
  { id: 'single-total-budget', capability: 'budget', turns: [{ text: 'Hi Ticket Guy, can you find me 5 tickets together for the Rangers preseason game against the Islanders on Oct 3? Budget is $500 total.', expect: { eventId: E.rangersPreseason, quantity: 5, budgetCents: 50000, budgetBasis: 'whole_party' } }] },
  { id: 'per-ticket-budget', capability: 'budget', turns: [{ text: 'Need 2 seats for the Rangers vs Islanders preseason game, no more than $130 a ticket.', expect: { eventId: E.rangersPreseason, quantity: 2, budgetCents: 13000, budgetBasis: 'per_ticket' } }] },
  { id: 'party-grows', capability: 'changing-instructions', turns: [{ text: 'Looking for 2 tickets to the Rangers preseason game Oct 3, under $300 total.', expect: { eventId: E.rangersPreseason, quantity: 2 } }, { text: 'Actually there are five of us now.', expect: { eventId: E.rangersPreseason, quantity: 5 } }] },
  { id: 'budget-raised', capability: 'changing-instructions', turns: [{ text: '2 tickets for the Knicks game on Oct 24, max $250 total please.', expect: { eventId: E.knicks, quantity: 2, budgetCents: 25000 } }, { text: 'Ok, we can stretch to $320 total.', expect: { eventId: E.knicks, quantity: 2, budgetCents: 32000, mustMentionAny: ['310'] } }] },
  { id: 'pick-by-opponent', capability: 'memory', turns: [{ text: 'Two tickets for a Rangers game at MSG in October?' }, { text: 'The Islanders game.', expect: { eventId: E.rangersPreseason, quantity: 2 } }] },
  { id: 'pick-earlier-one', capability: 'memory', turns: [{ text: 'Two tickets for a Rangers game at MSG in October?' }, { text: 'The earlier one works.', expect: { eventId: E.rangersPreseason, quantity: 2 } }] },
  { id: 'pick-by-date', capability: 'memory', turns: [{ text: 'Two tickets for a Rangers game at MSG in October?' }, { text: 'Let’s do the one on the 15th.', expect: { eventId: E.rangersRegular, quantity: 2 } }] },
  { id: 'same-game-new-quantity', capability: 'memory', turns: [{ text: '2 tickets for the Rangers preseason game on Oct 3 please.', expect: { eventId: E.rangersPreseason, quantity: 2 } }, { text: 'Can you also check what 5 together would cost for the same game?', expect: { eventId: E.rangersPreseason, quantity: 5 } }] },
  { id: 'switch-team', capability: 'changing-instructions', turns: [{ text: '2 tickets for the Rangers preseason game on Oct 3.', expect: { eventId: E.rangersPreseason, quantity: 2 } }, { text: 'Actually, let’s do the Knicks game on the 24th instead.', expect: { eventId: E.knicks, quantity: 2 } }] },
  { id: 'side-question', capability: 'memory', turns: [{ text: '5 tickets for the Rangers preseason game, $500 total.', expect: { eventId: E.rangersPreseason, quantity: 5, budgetCents: 50000 } }, { text: 'Quick question — is MSG easy to get to from Penn Station?' }, { text: 'Great. So which seats would you go for?', expect: { eventId: E.rangersPreseason, quantity: 5, budgetCents: 50000 } }] },
  { id: 'which-is-cheapest', capability: 'recommendation', turns: [{ text: 'Looking at 2 tickets for the Rangers vs Islanders preseason game.', expect: { eventId: E.rangersPreseason, quantity: 2 } }, { text: 'Which option is cheapest?', expect: { eventId: E.rangersPreseason, quantity: 2, mustMentionAny: ['150', '240'] } }] },
  { id: 'no-inventory-artist', capability: 'unavailable-inventory', turns: [{ text: 'Can you get me 4 tickets to see Dua Lipa in New York?' }] },
  { id: 'vague-browse', capability: 'ambiguous', turns: [{ text: 'Anything good happening at Madison Square Garden in the next few weeks?' }] },
  { id: 'thanks-close', capability: 'conversation', turns: [{ text: '4 tickets for the Yankees game on Sep 30.', expect: { eventId: E.yankees, quantity: 4 } }, { text: 'Perfect, thanks — all set!', expect: { noNewRecommendation: true } }] },
  { id: 'lower-bowl', capability: 'seating', turns: [{ text: '5 tickets for the Rangers preseason game, lower bowl please, up to $1,000 total.', expect: { eventId: E.rangersPreseason, quantity: 5, budgetCents: 100000, mustMentionAny: ['110'] } }] },
  // Live email, Oct 13: got "couldn't finish automatically" (that run was hit by the tracing outage).
  { id: 'next-game-question', capability: 'event-discovery', turns: [{ text: 'when is the next rangers game in new york?', expect: { eventId: E.rangersPreseason, mustMentionAny: ['Oct 3', 'October 3', '10/3'] } }] },
  { id: 'nickname-typo', capability: 'event-resolution', turns: [{ text: '2 NYR tix for the preseason game vs the isles pls', expect: { eventId: E.rangersPreseason, quantity: 2 } }] },
];

type TurnOut = { customer: string; reply: string; state: string; eventId: string | null; brief: RequestExtraction | null; newRecommendations: number; expect?: Expect };

const env = testEnv({ AI_GLOBAL_DAILY_BUDGET_USD: process.env.EVAL_BUDGET_USD ?? '10' });
const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) throw new Error('OPENAI_API_KEY is not set (put it in .env.local)');
const model = env.OPENAI_BASE_MODEL;
const effort = env.OPENAI_BASE_EFFORT;

let threadNo = 0;
async function runThread(s: Scenario): Promise<TurnOut[]> {
  const h = await openTestDb();
  try {
    const client = new OpenAiClient(openaiKey!);
    const c = new Concierge({ db: h.db, env, extractor: new ModelExtractor(client, model, effort), drafter: new ModelDrafter(client, model, effort), clock: () => NOW, emailProvider: null, fixtureOffers: FIXTURE_OFFERS });
    const from = `eval-${++threadNo}@customer.example`;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: TurnOut[] = [];
    for (const tu of s.turns) {
      const seenSends = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((r) => r.id));
      const seenRecs = new Set((await h.db.select({ id: t.recommendations.id }).from(t.recommendations)).map((r) => r.id));
      const m = inbound({ text: tu.text, from, subject: prev ? 'Re: Tickets' : 'Tickets', receivedAt: NOW, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string; conversationId: string };
      prev = m;
      for (let i = 0; i < 6; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
      const [v] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId)).orderBy(desc(t.requestVersions.revision)).limit(1);
      const inThread = (await h.db.select({ id: t.requests.id }).from(t.requests).where(eq(t.requests.conversationId, r.conversationId))).map((q) => q.id);
      const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.conversationId, r.conversationId))).filter((x) => !seenSends.has(x.id));
      const recs = (await h.db.select().from(t.recommendations).where(inArray(t.recommendations.requestId, inThread))).filter((x) => !seenRecs.has(x.id));
      out.push({ customer: tu.text, reply: [...sends.map((x) => x.bodyText), ...recs.map((x) => x.bodyText)].filter(Boolean).join('\n----\n'), state: req!.state, eventId: req!.eventId, brief: (v?.brief as RequestExtraction) ?? null, newRecommendations: recs.length, expect: tu.expect });
    }
    return out;
  } finally {
    await h.close();
  }
}

// ---------- deterministic scorers ----------
const cents = (s: string) => Math.round(Number(s.replace(/[$,\s]/g, '')) * 100);
const moneyIn = (text: string) => [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => cents(m[1]!));
const urlsIn = (text: string) => [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''));

/** Every dollar figure the fixture world can justify: listing totals, base, fees, per-ticket, trend and history, and their differences. */
const GROUNDED = (() => {
  const base = new Set<number>();
  for (const offers of Object.values(FIXTURE_OFFERS)) for (const o of offers) for (const v of [o.payableTotalCents, o.baseTotalCents, o.mandatoryFeeTotalCents]) if (v != null) { base.add(v); base.add(Math.round(v / o.quantity)); }
  for (const v of [47500, 46000, 44000, 42500, ...FIXTURE_HISTORICAL_EVENTS.map((x) => x.fiveSeatBestCents)]) { base.add(v); base.add(Math.round(v / 5)); }
  const all = new Set(base);
  const arr = [...base];
  for (const a of arr) for (const b of arr) if (a > b) all.add(a - b);
  return all;
})();
const nearGrounded = (v: number, allowed: Set<number>) => { for (const a of allowed) if (Math.abs(a - v) <= 100) return true; return false; }; // whole-dollar rounding
const OFFER_URLS = new Set(Object.values(FIXTURE_OFFERS).flat().flatMap((o) => [o.directPurchaseUrl, o.affiliateUrl].filter(Boolean) as string[]));

type Args = { input: Scenario; output: TurnOut[] };
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function perTurn(name: string, f: (tu: TurnOut, i: number, all: TurnOut[]) => { ok: number; why?: string } | null) {
  const fn = ({ output }: Args) => {
    const rs = output.map((tu, i) => ({ i, r: f(tu, i, output) })).filter((x) => x.r);
    return { name, score: avg(rs.map((x) => x.r!.ok)), metadata: { failures: rs.filter((x) => x.r!.ok < 1).map((x) => ({ turn: x.i + 1, why: x.r!.why })) } };
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

const scorers = [
  perTurn('event_correct', (tu) => (tu.expect && 'eventId' in tu.expect ? { ok: tu.eventId === tu.expect.eventId ? 1 : 0, why: `got ${tu.eventId}, want ${tu.expect.eventId}` } : null)),
  perTurn('party_size_kept', (tu) => (tu.expect?.quantity != null ? { ok: tu.brief?.quantity === tu.expect.quantity ? 1 : 0, why: `brief quantity ${tu.brief?.quantity}, want ${tu.expect.quantity}` } : null)),
  perTurn('budget_kept', (tu) => {
    if (tu.expect?.budgetCents == null) return null;
    const okAmt = tu.brief?.budgetCents === tu.expect.budgetCents;
    const okBasis = !tu.expect.budgetBasis || tu.brief?.budgetBasis === tu.expect.budgetBasis;
    return { ok: okAmt && okBasis ? 1 : 0, why: `brief ${tu.brief?.budgetCents} ${tu.brief?.budgetBasis}, want ${tu.expect.budgetCents} ${tu.expect.budgetBasis ?? ''}` };
  }),
  perTurn('mentions_required', (tu) => (tu.expect?.mustMentionAny ? { ok: tu.expect.mustMentionAny.some((s) => tu.reply.includes(s)) ? 1 : 0, why: `none of ${tu.expect.mustMentionAny.join('/')} in reply` } : null)),
  perTurn('forbidden_absent', (tu) => (tu.expect?.forbid ? { ok: tu.expect.forbid.some((s) => tu.reply.includes(s)) ? 0 : 1, why: `reply contains ${tu.expect.forbid.filter((s) => tu.reply.includes(s)).join('/')}` } : null)),
  perTurn('no_new_recommendation', (tu) => (tu.expect?.noNewRecommendation ? { ok: tu.newRecommendations === 0 ? 1 : 0, why: `${tu.newRecommendations} new recommendation(s)` } : null)),
  perTurn('got_a_reply', (tu) => (tu.expect?.noNewRecommendation ? null : { ok: tu.reply.trim() ? 1 : 0, why: `no email produced (state ${tu.state})` })),
  perTurn('not_parked_for_staff', (tu) => ({ ok: tu.state === 'manual_attention' ? 0 : 1, why: `state ${tu.state}` })),
  perTurn('prices_grounded', (tu, i, all) => {
    const amounts = moneyIn(tu.reply);
    if (!amounts.length) return null;
    const allowed = new Set(GROUNDED);
    for (const prior of all.slice(0, i + 1)) for (const v of moneyIn(prior.customer)) { allowed.add(v); for (const q of [2, 3, 4, 5, 6]) { allowed.add(v * q); allowed.add(Math.round(v / q)); } }
    const bad = amounts.filter((v) => !nearGrounded(v, allowed));
    return { ok: bad.length ? 0 : 1, why: `ungrounded: ${bad.map((v) => '$' + (v / 100).toFixed(2)).join(', ')}` };
  }),
  perTurn('links_grounded', (tu) => {
    const urls = urlsIn(tu.reply);
    if (!urls.length) return null;
    const bad = urls.filter((u) => { if (OFFER_URLS.has(u)) return false; try { const host = new URL(u).hostname; return !(host === SERVICE_DOMAIN || host.endsWith('.' + SERVICE_DOMAIN)); } catch { return true; } });
    return { ok: bad.length ? 0 : 1, why: `unknown links: ${bad.join(' ')}` };
  }),
  perTurn('at_most_one_question', (tu) => {
    if (!tu.reply.trim()) return null;
    const q = tu.reply.split('\n----\n').reduce((n, body) => n + (body.match(/[^.!?\n]*\?(?=\s|$)/g)?.filter((s) => !/https?:/.test(s)).length ?? 0), 0);
    return { ok: q <= 1 ? 1 : 0, why: `${q} questions` };
  }),
];

// ---------- model-graded: does the reply answer what was asked? ----------
const judge = wrapOpenAI(new OpenAI({ apiKey: openaiKey }));
const Verdict = z.object({ verdict: z.enum(['yes', 'partly', 'no']), reason: z.string() });
async function answeredTheQuestion({ output }: Args) {
  const scores: number[] = [];
  const reasons: Array<{ turn: number; verdict: string; reason: string }> = [];
  for (let i = 0; i < output.length; i++) {
    const tu = output[i]!;
    if (!tu.reply.trim()) continue;
    const history = output.slice(0, i).map((p, k) => `Customer (${k + 1}): ${p.customer}\nTicket Guy (${k + 1}): ${p.reply.slice(0, 1500)}`).join('\n\n');
    const res = await judge.responses.parse({
      model,
      reasoning: { effort: 'low' },
      store: false,
      instructions:
        'You grade replies from Ticket Guy, an email ticket-buying assistant. Judge ONLY whether the latest reply directly addresses what the customer asked in their latest message, while keeping constraints they stated earlier in the thread (event, party size, budget, seating). Do not judge style. "yes" = directly answers and keeps constraints; "partly" = answers but drifts, re-asks something already answered, or buries the answer; "no" = answers a different question, ignores the message, or restarts the conversation.',
      input: `${history ? history + '\n\n' : ''}Customer (latest): ${tu.customer}\n\nTicket Guy (latest reply):\n${tu.reply.slice(0, 4000)}`,
      text: { format: zodTextFormat(Verdict, 'verdict') },
    });
    const v = res.output_parsed!;
    scores.push(v.verdict === 'yes' ? 1 : v.verdict === 'partly' ? 0.5 : 0);
    reasons.push({ turn: i + 1, verdict: v.verdict, reason: v.reason });
  }
  return { name: 'answered_the_question', score: avg(scores), metadata: { reasons } };
}

const sha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; } })();
const only = process.env.EVAL_ONLY?.split(',');

Eval('My Project', {
  experimentName: process.env.EVAL_EXPERIMENT_NAME ?? `conversations-${sha}`,
  metadata: { gitSha: sha, model, effort, budgetUsd: env.aiGlobalDailyBudgetUsd ?? null },
  data: () => SCENARIOS.filter((s) => !only || only.includes(s.id)).map((s) => ({ input: s, metadata: { id: s.id, capability: s.capability, turns: s.turns.length } })),
  task: async (input: Scenario) => runThread(input),
  scores: [...scorers, answeredTheQuestion],
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY ?? 4),
  trialCount: 1,
});
