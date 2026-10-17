/**
 * One eval run as a file (eval-results.json), so nothing about a run has to be read back from Braintrust.
 * evals/ticketguy.eval.ts writes it; evals/report-failures.ts reads it (summary, diff against the previous run,
 * history row, issues). Pass/fail is decided here, once, so the summary table and the issues can't disagree.
 *
 * The file is uploaded as a workflow artifact, and artifacts on a public repo can be downloaded by anyone: real
 * customer threads (prod/…) keep their thread id and failing steps only, never their words or our replies.
 */
import { readFileSync } from 'node:fs';
import type { TurnOut } from './harness';

export type CheckResult = {
  /** 1 = passed; below 1 = failed in some steps; null = didn't apply to this thread. */
  score: number | null;
  /** null when the check didn't apply or errored. */
  pass: boolean | null;
  reason: string | null;
  /** The check itself threw (a judge call failed, say): neither passed nor failed. */
  error?: string;
};
export type ThreadResult = {
  /** The scenario's id ("rangers-budget-other-games", "long/…", "sim/…", "prod/…"). */
  id: string;
  /** What the scenario tests (its capability, e.g. "budget", "production-replay"). */
  scenario: string;
  tags: string[];
  checks: Record<string, CheckResult>;
  /** The thread itself failed to run (no checks then). */
  error: string | null;
  /** Customer and reply per step, for issue examples. Never for real customer threads. */
  transcript?: Array<{ step: number; customer: string; reply: string }>;
};
export type ProviderCounts = { llmErrors: number; quotaOrRateLimit: number };
export type EvalResults = {
  version: 1;
  createdAt: string;
  commit: string;
  suite: string;
  model: string;
  /** Threads the run set out to score. */
  expected: number;
  sentToBraintrust: boolean;
  provider: ProviderCounts;
  threads: ThreadResult[];
};

/** Braintrust scores one run may record: it bills per score, and a run records one per thread. */
export const MAX_BRAINTRUST_SCORES = 2000;
export const SCORES_PER_THREAD = 1;
export const scoreCapRefusal = (threads: number) => (threads * SCORES_PER_THREAD > MAX_BRAINTRUST_SCORES ? `refusing to send ${threads} threads × ${SCORES_PER_THREAD} score to Braintrust (cap ${MAX_BRAINTRUST_SCORES}); narrow EVAL_SUITE or EVAL_ONLY, or run locally` : null);

export const isRealThread = (id: string) => id.startsWith('prod/');

type Meta = {
  failures?: Array<{ step?: number; why?: string } & Record<string, unknown>>;
  reasons?: Array<{ step: number; verdict: string; reason: string }>;
  summary?: string;
  broke_at_step?: number | null;
  reason?: string;
};

/**
 * Whether a check passed in a thread, and why not. answered_the_question fails only on an outright "no" for some
 * step ("partly" is noise at this sample size); every other check fails below a perfect score.
 */
export function judgeCheck(name: string, score: number | null, metadata: unknown): Omit<CheckResult, 'score'> {
  if (score == null) return { pass: null, reason: null };
  const m = (metadata ?? {}) as Meta;
  if (name === 'answered_the_question') {
    const no = (m.reasons ?? []).filter((r) => r.verdict === 'no');
    return no.length ? { pass: false, reason: no.map((r) => `step ${r.step}: ${r.reason}`).join(' · ').slice(0, 400) } : { pass: true, reason: null };
  }
  if (score >= 1) return { pass: true, reason: null };
  const detail = (f: NonNullable<Meta['failures']>[number]) => f.why ?? Object.entries(f).filter(([k]) => k !== 'step' && k !== 'ok').map(([k, v]) => `${k} ${String(v)}`).join(', ');
  const why = m.failures?.length ? m.failures.map((f) => `step ${f.step}: ${detail(f)}`).join(' · ') : m.summary ? `broke at step ${m.broke_at_step}: ${m.summary}` : (m.reason ?? `score ${score}`);
  return { pass: false, reason: why.slice(0, 400) };
}

/** A real customer thread as it may appear in public: which steps failed, never what anyone wrote. */
const redactReason = (why: string) => `${(why.match(/step \d+/g) ?? []).join(', ') || 'failed'} (real customer thread)`;

export function threadResult(args: { id: string; scenario: string; tags?: string[]; checks: Record<string, { score: number | null; metadata?: unknown; error?: string }>; error?: unknown; output?: TurnOut[] | null }): ThreadResult {
  const real = isRealThread(args.id);
  const checks: Record<string, CheckResult> = {};
  for (const [name, c] of Object.entries(args.checks)) {
    if (c.error) { checks[name] = { score: null, pass: null, reason: null, error: real ? 'check failed to run (real customer thread)' : c.error.slice(0, 300) }; continue; }
    const j = judgeCheck(name, c.score, c.metadata);
    checks[name] = { score: c.score, pass: j.pass, reason: j.reason && real ? redactReason(j.reason) : j.reason };
  }
  // An error message can quote what it choked on; a real thread keeps the error's kind only.
  const error = args.error == null ? null : real ? `${args.error instanceof Error ? args.error.name : 'Error'} (real customer thread)` : (args.error instanceof Error ? `${args.error.name}: ${args.error.message}` : String(args.error)).slice(0, 300);
  return {
    id: args.id,
    scenario: args.scenario,
    tags: args.tags ?? [],
    checks,
    error,
    ...(real || !args.output ? {} : { transcript: args.output.map((tu) => ({ step: tu.step, customer: tu.customer, reply: tu.reply.slice(0, 1500) })) }),
  };
}

/** Threads that were scored: they ran and at least one check reached a verdict or ran at all. */
export const scoredThreads = (r: EvalResults) => r.threads.filter((t) => !t.error && Object.keys(t.checks).length > 0);

export function readResults(path: string): EvalResults | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as EvalResults;
    return r && r.version === 1 && Array.isArray(r.threads) ? r : null;
  } catch {
    return null;
  }
}

/** A thread fails when any check failed in it; null when nothing was judged. */
export const threadPassed = (t: ThreadResult): boolean | null => {
  const judged = Object.values(t.checks).filter((c) => c.pass != null);
  return t.error ? false : judged.length ? judged.every((c) => c.pass) : null;
};
