/**
 * Scorers. Deterministic invariants first (per email, then across the thread), then two model-graded checks:
 * did each reply answer what was asked, and is the whole thread coherent (with the email where it broke).
 * A scorer returns null when it doesn't apply to a thread, so it doesn't dilute the average.
 */
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { wrapOpenAI } from 'braintrust';
import { FIXTURE_HISTORICAL_EVENTS } from '@/lib/fixtures';
import { SERVICE_DOMAIN } from '@/lib/config/brand';
import { EVAL_APP_URL, type Expect, type Scenario, type TurnOut } from './harness';
import { LINKS, worldOffers } from './world';

type Args = { input: Scenario; output: TurnOut[] };
type R = { ok: number; why?: string } | null;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const isEmailStep = (tu: TurnOut) => !tu.customer.startsWith('[');
const mentions = (text: string, needle: string) => (needle.startsWith('re:') ? new RegExp(needle.slice(3), 'i').test(text) : text.includes(needle));

function perTurn(name: string, f: (tu: TurnOut, i: number, all: TurnOut[], input: Scenario) => R) {
  const fn = ({ input, output }: Args) => {
    const rs = output.map((tu, i) => ({ i, r: f(tu, i, output, input) })).filter((x) => x.r);
    return { name, score: avg(rs.map((x) => x.r!.ok)), metadata: { failures: rs.filter((x) => x.r!.ok < 1).map((x) => ({ step: x.i + 1, why: x.r!.why })) } };
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

// ---------- grounding ----------
const cents = (s: string) => Math.round(Number(s.replace(/[$,\s]/g, '')) * 100);
export const moneyIn = (text: string) => [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => cents(m[1]!));
const urlsIn = (text: string) => [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''));
const WORLD = worldOffers();
const GROUNDED = (() => {
  const base = new Set<number>();
  for (const offers of Object.values(WORLD)) for (const o of offers) for (const v of [o.payableTotalCents, o.baseTotalCents, o.mandatoryFeeTotalCents]) if (v != null) { base.add(v); base.add(Math.round(v / o.quantity)); }
  for (const v of [47500, 46000, 44000, 42500, 34000, 31500, 29000, 26000, 82000, 76000, 70000, 64000, 32000, 35000, 38500, 42000, 18200, 17800, 18100, 18000, ...FIXTURE_HISTORICAL_EVENTS.map((x) => x.fiveSeatBestCents)]) for (const q of [1, 2, 4, 5]) base.add(Math.round(v / q));
  const all = new Set(base);
  const arr = [...base];
  for (const a of arr) for (const b of arr) if (a > b) all.add(a - b);
  return all;
})();
const near = (v: number, allowed: Set<number>) => { for (const a of allowed) if (Math.abs(a - v) <= 100) return true; return false; };
const OFFER_URLS = new Set([...Object.values(WORLD).flat().flatMap((o) => [o.directPurchaseUrl, o.affiliateUrl].filter(Boolean) as string[]), ...Object.values(LINKS)]);

/** Marketplace search and city pages the product builds on purpose (never a specific listing). */
const SEARCH_LINK = /^https:\/\/(www\.stubhub\.com\/search\?q=|www\.vividseats\.com\/search\?searchTerm=|ra\.co\/events\/[a-z]{2}\/[a-z-]+$)/;

// ---------- per email ----------
const PLAIN = new Set(['acknowledgment', 'clarification', 'holding', 'watch_alert', 'watch_confirmation', 'verification', 'manual_attention', 'no_result']);

const MONTH_OR_DAY = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b|\b(?:Tonight|Today|Tomorrow)\b/;
const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/**
 * The event preview card (#179) on a recommendation for a known event: an image served from our own domain with alt
 * text, and the title, the date and the venue in the plain text, so it reads the same with images off.
 */
export function previewCardProblems(e: { html: string; text: string }): string[] {
  const why: string[] = [];
  const img = /<img src="([^"]+)" alt="([^"]*)"/.exec(e.html);
  if (!img) return ['recommendation: no event image'];
  let host = '';
  try {
    host = new URL(unescape(img[1]!)).hostname;
  } catch {
    host = '';
  }
  if (host !== new URL(EVAL_APP_URL).hostname) why.push(`recommendation: image not on our domain (${host || 'unparseable'})`);
  if (!img[2]!.trim()) why.push('recommendation: image without alt text');
  const title = /<h2[^>]*>([^<]+)<\/h2>/.exec(e.html)?.[1];
  const details = /<h2[^>]*>[^<]+<\/h2>\s*<p[^>]*>([^<]+)<\/p>/.exec(e.html)?.[1];
  if (!title || !e.text.includes(unescape(title).trim())) why.push('recommendation: event title not in the text');
  if (!MONTH_OR_DAY.test(e.text)) why.push('recommendation: date not in the text');
  const venue = details ? unescape(details).split(' · ')[0]!.split(',')[0]!.trim() : '';
  if (!venue || !e.text.includes(venue)) why.push('recommendation: venue not in the text');
  return why;
}
const questionsIn = (reply: string) => reply.split('\n----\n').flatMap((body) => body.match(/[^.!?\n]*\?(?=\s|$)/g)?.filter((s) => !/https?:/.test(s)) ?? []);

export const perEmail = [
  perTurn('event_correct', (tu) => {
    const ex = tu.expect;
    if (!ex || (!('eventId' in ex) && !ex.eventIdIn)) return null;
    const ok = ex.eventIdIn ? ex.eventIdIn.includes(tu.eventId ?? '') : tu.eventId === ex.eventId;
    return { ok: ok ? 1 : 0, why: `got ${tu.eventId}, want ${ex.eventIdIn ? ex.eventIdIn.join('|') : ex.eventId}` };
  }),
  perTurn('party_size_kept', (tu) => (tu.expect?.quantity != null ? { ok: tu.brief?.quantity === tu.expect.quantity ? 1 : 0, why: `brief quantity ${tu.brief?.quantity}, want ${tu.expect.quantity}` } : null)),
  perTurn('budget_kept', (tu) => {
    if (tu.expect?.budgetCents == null) return null;
    const ok = tu.brief?.budgetCents === tu.expect.budgetCents && (!tu.expect.budgetBasis || tu.brief?.budgetBasis === tu.expect.budgetBasis);
    return { ok: ok ? 1 : 0, why: `brief ${tu.brief?.budgetCents} ${tu.brief?.budgetBasis}, want ${tu.expect.budgetCents} ${tu.expect.budgetBasis ?? ''}` };
  }),
  perTurn('mentions_required', (tu) => {
    const ex = tu.expect;
    if (!ex?.mustMentionAny && !ex?.mustMentionAll) return null;
    const anyOk = !ex.mustMentionAny || ex.mustMentionAny.some((s) => mentions(tu.reply, s));
    const missing = (ex.mustMentionAll ?? []).filter((s) => !mentions(tu.reply, s));
    return { ok: anyOk && !missing.length ? 1 : 0, why: [!anyOk ? `none of ${ex.mustMentionAny!.join(' / ')}` : '', missing.length ? `missing ${missing.join(', ')}` : ''].filter(Boolean).join('; ') };
  }),
  perTurn('forbidden_absent', (tu) => (tu.expect?.forbid ? { ok: tu.expect.forbid.some((s) => mentions(tu.reply, s)) ? 0 : 1, why: `reply contains ${tu.expect.forbid.filter((s) => mentions(tu.reply, s)).join(' / ')}` } : null)),
  perTurn('no_new_recommendation', (tu) => (tu.expect?.noNewRecommendation ? { ok: tu.newRecommendations === 0 ? 1 : 0, why: `${tu.newRecommendations} new recommendation(s)` } : null)),
  perTurn('asks_one_question', (tu) => (tu.expect?.asksOneQuestion ? { ok: questionsIn(tu.reply).length === 1 ? 1 : 0, why: `${questionsIn(tu.reply).length} questions` } : null)),
  perTurn('price_alert_set', (tu) => {
    const w = tu.expect?.watch;
    if (!w) return null;
    const hit = tu.watches.find((x) => x.eventId === w.eventId && (w.targetTotalCents == null || x.targetTotalCents === w.targetTotalCents));
    return { ok: hit ? 1 : 0, why: `watches on file: ${JSON.stringify(tu.watches)}` };
  }),
  perTurn('price_alert_raised', (tu) => (tu.expect?.alertsRaised != null ? { ok: tu.alertsRaised === tu.expect.alertsRaised ? 1 : 0, why: `${tu.alertsRaised} alerts raised, want ${tu.expect.alertsRaised}; watches ${JSON.stringify(tu.watches)}; run ${JSON.stringify(tu.alertRun)}` } : null)),
  perTurn('got_a_reply', (tu) => (!isEmailStep(tu) || tu.expect?.noNewRecommendation ? null : { ok: tu.reply.trim() ? 1 : 0, why: `no email produced (state ${tu.state})` })),
  perTurn('not_parked_for_staff', (tu) => (isEmailStep(tu) ? { ok: tu.state === 'manual_attention' ? 0 : 1, why: `state ${tu.state}` } : null)),
  perTurn('prices_grounded', (tu, i, all, input) => {
    const amounts = moneyIn(tu.reply);
    if (!amounts.length) return null;
    const allowed = new Set(GROUNDED);
    for (const v of input?.groundedCents ?? []) allowed.add(v);
    for (const prior of all.slice(0, i + 1)) for (const v of moneyIn(prior.customer)) for (const q of [1, 2, 3, 4, 5, 6]) { allowed.add(v * q); allowed.add(Math.round(v / q)); }
    const bad = amounts.filter((v) => !near(v, allowed));
    return { ok: bad.length ? 0 : 1, why: `ungrounded: ${bad.map((v) => '$' + (v / 100).toFixed(2)).join(', ')}` };
  }),
  perTurn('links_grounded', (tu, _i, _all, input) => {
    const urls = urlsIn(tu.reply);
    if (!urls.length) return null;
    const extra = new Set((input?.groundedLinks ?? []).map((u) => u.replace(/\/+$/, '')));
    // Every listing link in the eval world is https://example.invalid/fixture/<listing>, including listings a test adds mid-thread.
    const bad = urls.filter((u) => { if (OFFER_URLS.has(u) || extra.has(u.replace(/\/+$/, '')) || SEARCH_LINK.test(u) || u.startsWith('https://example.invalid/fixture/')) return false; try { const host = new URL(u).hostname; return !(host === SERVICE_DOMAIN || host.endsWith('.' + SERVICE_DOMAIN)); } catch { return true; } });
    return { ok: bad.length ? 0 : 1, why: `unknown links: ${bad.join(' ')}` };
  }),
  /** "5 seats together in section 310" must match a listing that is actually together (not seatsTogether false). */
  perTurn('together_claims_true', (tu) => {
    const claims = [...tu.reply.matchAll(/(\d+) seats together in section ([\w ]+?)[:,.]/gi)].map((m) => ({ q: Number(m[1]), section: m[2]!.trim() }));
    if (!claims.length) return null;
    const bad = claims.filter((c) => { const ls = Object.values(WORLD).flat().filter((o) => o.section === c.section && o.quantity === c.q); return ls.length > 0 && ls.every((o) => o.seatsTogether === false); });
    return { ok: bad.length ? 0 : 1, why: `claims together but listing is not: ${bad.map((b) => `${b.q} in ${b.section}`).join(', ')}` };
  }),
  perTurn('at_most_one_question', (tu) => (tu.reply.trim() ? { ok: questionsIn(tu.reply).length <= 1 ? 1 : 0, why: `${questionsIn(tu.reply).length} questions` } : null)),
  perTurn('one_email_per_message', (tu) => (isEmailStep(tu) && tu.emails.length ? { ok: tu.emails.length <= 1 ? 1 : 0, why: `${tu.emails.length} emails: ${tu.emails.map((e) => e.cls).join(', ')}` } : null)),
  // Design (DECISION_LOG #76, #82): every sent email is signed (full on the first reply, short after); every answer
  // carries the ticket-brief card. Recommendations are stored unsigned while awaiting review.
  perTurn('email_design', (tu) => {
    if (!tu.emails.length) return null;
    const bad = tu.emails.flatMap((e) => {
      const why: string[] = [];
      if (e.cls !== 'recommendation' && !/second opinion before you buy|>\s*Ticket Guy\s*<\/p>/i.test(e.html)) why.push(`${e.cls}: no signature`);
      if (!PLAIN.has(e.cls) && !/border-radius:12px;border-collapse:separate/.test(e.html)) why.push(`${e.cls}: answer without the ticket-brief card`);
      if (e.cls === 'recommendation' && tu.eventId) why.push(...previewCardProblems(e));
      return why;
    });
    return { ok: bad.length ? 0 : 1, why: bad.join('; ') };
  }),
];

// ---------- across the thread ----------
/** What the customer has established so far (event, party, budget), carried forward from each step's expectation. */
function carried(output: TurnOut[]): Array<Partial<Pick<Expect, 'eventId' | 'quantity' | 'budgetCents'>>> {
  const state: Partial<Pick<Expect, 'eventId' | 'quantity' | 'budgetCents'>> = {};
  return output.map((tu) => {
    const before = { ...state };
    if (tu.expect) for (const k of ['eventId', 'quantity', 'budgetCents'] as const) if (tu.expect[k] !== undefined) (state as Record<string, unknown>)[k] = tu.expect[k];
    return tu.expect ? { ...state } : before;
  });
}
const shingles = (s: string) => { const w = s.toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').split(/\s+/).filter(Boolean); const out = new Set<string>(); for (let i = 0; i + 2 < w.length; i++) out.add(w.slice(i, i + 3).join(' ')); return out; };
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const answerOf = (tu: TurnOut) => tu.emails.filter((e) => e.cls !== 'acknowledgment').map((e) => e.text).join('\n');

export const acrossThread = [
  /** Every later email keeps what the customer established unless they changed it (side questions, thanks, picks). */
  ({ output }: Args) => {
    const exp = carried(output);
    const checks: Array<{ step: number; why: string; ok: number }> = [];
    output.forEach((tu, i) => {
      if (!isEmailStep(tu) || i === 0 || !tu.brief) return;
      const want = exp[i]!;
      for (const k of ['quantity', 'budgetCents'] as const) if (want[k] != null && tu.expect?.[k] === undefined) checks.push({ step: i + 1, ok: tu.brief[k] === want[k] ? 1 : 0, why: `${k}: brief ${tu.brief[k]}, established ${want[k]}` });
      if (want.eventId && tu.expect?.eventId === undefined && !tu.expect?.eventIdIn) checks.push({ step: i + 1, ok: tu.eventId === want.eventId ? 1 : 0, why: `event: ${tu.eventId}, established ${want.eventId}` });
    });
    return { name: 'memory_across_thread', score: avg(checks.map((c) => c.ok)), metadata: { failures: checks.filter((c) => !c.ok) } };
  },
  /** A reply that is nearly the same as the previous one, when the customer said something new, is a repeat. */
  ({ output }: Args) => {
    const steps = output.filter((tu) => isEmailStep(tu) && answerOf(tu).trim());
    if (steps.length < 2) return { name: 'no_repeated_reply', score: null };
    const bad: Array<{ step: number; similarity: number }> = [];
    for (let i = 1; i < steps.length; i++) {
      const sim = jaccard(shingles(answerOf(steps[i - 1]!)), shingles(answerOf(steps[i]!)));
      if (sim >= 0.8) bad.push({ step: steps[i]!.step, similarity: Math.round(sim * 100) / 100 });
    }
    return { name: 'no_repeated_reply', score: 1 - bad.length / (steps.length - 1), metadata: { failures: bad } };
  },
  /** Asking for something the customer already gave (party size, budget, which game) is a re-ask. */
  ({ output }: Args) => {
    const exp = carried(output);
    const bad: Array<{ step: number; question: string }> = [];
    let asked = 0;
    output.forEach((tu, i) => {
      if (!isEmailStep(tu) || i === 0) return;
      const known = exp[i - 1]!;
      for (const q of questionsIn(tu.reply)) {
        asked++;
        if ((known.quantity && /how many (tickets|seats|people)|for how many|party size/i.test(q)) || (known.budgetCents && /(budget|most you.?d (pay|spend)|price range|how much (are you|would you|do you want))/i.test(q)) || (known.eventId && /which (game|date|show|night|one)\b/i.test(q) && !/(instead|other|another)/i.test(q))) bad.push({ step: i + 1, question: q.trim() });
      }
    });
    return { name: 'no_reasked_question', score: asked ? 1 - bad.length / Math.max(asked, 1) : null, metadata: { failures: bad } };
  },
];

// ---------- model-graded ----------
let judgeClient: OpenAI | null = null;
const judge = (key: string) => (judgeClient ??= wrapOpenAI(new OpenAI({ apiKey: key })));
const Verdict = z.object({ verdict: z.enum(['yes', 'partly', 'no']), reason: z.string() });
const Coherence = z.object({
  score: z.number().int().min(1).max(5),
  broke_at_step: z.number().int().nullable(),
  issues: z.array(z.object({ step: z.number().int(), kind: z.enum(['forgot', 'contradicted', 'repeated', 'ignored_new_info', 'did_not_progress', 'invented', 'other']), detail: z.string() })),
  summary: z.string(),
});
const OnPoint = z.object({
  verdict: z.enum(['clean', 'some_extra', 'mostly_extra']),
  extra: z.array(z.object({ quote: z.string(), why: z.string() })),
  reason: z.string(),
});
const transcript = (output: TurnOut[], maxReply = 1800) => output.map((tu) => `[Step ${tu.step} · ${tu.at.slice(0, 16)}] Customer: ${tu.customer}\n[Step ${tu.step}] Ticket Guy:\n${tu.reply.slice(0, maxReply) || '(no email)'}`).join('\n\n');

export function modelGraded(key: string, model: string) {
  const answered = async ({ output }: Args) => {
    const scores: number[] = [];
    const reasons: Array<{ step: number; verdict: string; reason: string }> = [];
    for (let i = 0; i < output.length; i++) {
      const tu = output[i]!;
      if (!isEmailStep(tu) || !tu.reply.trim()) continue;
      const res = await judge(key).responses.parse({
        model, reasoning: { effort: 'low' }, store: false,
        instructions: 'You grade replies from Ticket Guy, an email ticket-buying assistant. Judge ONLY whether the latest reply directly addresses what the customer asked in their latest message, while keeping constraints they stated earlier in the thread (event, party size, budget, seating). Do not judge style. "yes" = directly answers and keeps constraints; "partly" = answers but drifts, re-asks something already answered, or buries the answer; "no" = answers a different question, ignores the message, or restarts the conversation.',
        input: `${transcript(output.slice(0, i), 1200)}\n\nCustomer (latest): ${tu.customer}\n\nTicket Guy (latest reply):\n${tu.reply.slice(0, 4000)}`,
        text: { format: zodTextFormat(Verdict, 'verdict') },
      });
      const v = res.output_parsed!;
      scores.push(v.verdict === 'yes' ? 1 : v.verdict === 'partly' ? 0.5 : 0);
      reasons.push({ step: i + 1, verdict: v.verdict, reason: v.reason });
    }
    return { name: 'answered_the_question', score: avg(scores), metadata: { reasons } };
  };
  /** Whole-thread coherence for threads of 4+ steps: names the step where it broke and what went wrong. */
  const coherent = async ({ output }: Args) => {
    if (output.length < 4) return { name: 'thread_coherence', score: null };
    const res = await judge(key).responses.parse({
      model, reasoning: { effort: 'medium' }, store: false,
      instructions: `You review a whole email thread between a customer and Ticket Guy, an email ticket-buying assistant. Steps in [brackets] like "[48h pass]" are time passing; the ticket market may have changed then. This is a test environment: listing links on example.invalid are stand-ins for real checkout links; treat them as working. Score 1-5:
5 = coherent throughout: remembers everything the customer established, never contradicts itself (a changed price is fine only if it says the market moved), uses new information (screenshots, links, changed prices, feedback) in the next reply, narrows toward a clear choice when asked, never repeats or restarts.
3 = mostly coherent with one or two lapses.
1 = loses the thread: forgets constraints, restarts, repeats itself, contradicts earlier replies, or invents facts.
The first reply counts like any other: if it misses or buries what the customer asked, broke_at_step is 1. broke_at_step = the first step where it went wrong (null if it never did). List every issue with its step. Be strict and specific; quote the reply when useful.`,
      input: transcript(output),
      text: { format: zodTextFormat(Coherence, 'coherence') },
    });
    const v = res.output_parsed!;
    return { name: 'thread_coherence', score: (v.score - 1) / 4, metadata: v };
  };
  /** Every reply carries only what the customer asked for or needs to act on. Calibrated on Tobias's review of the
   *  Rangers thread (Oct 14): left-out listings, missing-history notes, source names and check timestamps are noise;
   *  a needed question and one short "prices can change" line are fine. */
  const onPoint = async ({ output }: Args) => {
    const scores: number[] = [];
    const failures: Array<{ step: number; why: string }> = [];
    for (let i = 0; i < output.length; i++) {
      const tu = output[i]!;
      if (!isEmailStep(tu) || !tu.reply.trim()) continue;
      const res = await judge(key).responses.parse({
        model, reasoning: { effort: 'low' }, store: false,
        instructions: `You review one email from Ticket Guy, an email ticket-buying assistant, for content the customer did not ask for. Ignore the greeting, the sign-off and a one-line offer to help further.
First rule: anything that answers the customer's latest message is never extra, even if it fits a category below (asked whether prices will rise, what it knows or lacks about price history IS the answer; asked whether tickets still exist, saying it looks sold out IS the answer).
Allowed: the direct answer; the header line with event, venue, date, ticket count and budget; a one-line buy-or-wait recommendation; the pick (seats, quantity, all-in price, link); a real problem with THAT pick (seats not together, obstructed view, over budget); stating an assumption it made (e.g. two tickets) so the customer can correct it; one question that is needed to go further; one short line that prices can change before checkout.
Extra (count each one): listings it left out and why; notes about data it lacks or could not check; source or marketplace names it checked; when it checked prices; market context or trend talk the customer did not ask for; caveats about a screenshot or listing beyond the one that matters most; alternatives the customer did not ask for; anything repeated from its previous email that the customer did not ask about again; general disclaimers (e.g. who the service is for); invitations to send other listings.
verdict: "clean" = no extra; "some_extra" = one or two short extras; "mostly_extra" = the answer is buried, or extra is a large share of the email. Quote each extra exactly (short) with why it is extra.`,
        input: `${transcript(output.slice(Math.max(0, i - 2), i), 900)}\n\nCustomer (latest): ${tu.customer}\n\nTicket Guy (email to review):\n${tu.reply.split(/\nTicket Guy\n/)[0]!.slice(0, 4000)}`,
        text: { format: zodTextFormat(OnPoint, 'on_point') },
      });
      const v = res.output_parsed!;
      scores.push(v.verdict === 'clean' ? 1 : v.verdict === 'some_extra' ? 0.5 : 0);
      if (v.verdict !== 'clean') failures.push({ step: i + 1, why: `${v.verdict}: ${v.extra.map((x) => `"${x.quote}"`).join('; ') || v.reason}` });
    }
    return { name: 'only_what_was_asked', score: avg(scores), metadata: { failures } };
  };
  return [answered, coherent, onPoint];
}
