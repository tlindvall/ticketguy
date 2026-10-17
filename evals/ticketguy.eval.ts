/**
 * Ticket Guy conversation evals. Real pipeline, real model, eval world (evals/world.ts), no email sent.
 *
 *   pnpm eval                                   # EVAL_SUITE=pr: core + families (~50 threads)
 *   EVAL_SUITE=nightly pnpm eval                # + long threads + simulated customers
 *   EVAL_SUITE=long|sim|families|core pnpm eval
 *   EVAL_ONLY=rangers-this-thursday,long/ pnpm eval   # ids containing any of these
 *
 * Needs OPENAI_API_KEY (.env.local). Spend is capped by the app's own budget ledger per thread (EVAL_BUDGET_USD,
 * default 10) since every thread starts from an empty database.
 *
 * Local by default: Braintrust's Eval() runs with noSendLogs and nothing leaves the machine (Braintrust bills per
 * score; ~25 checks per thread on every run cost $206 in overages). Results go to eval-results.json (evals/results.ts),
 * which evals/report-failures.ts reads. EVAL_SEND_TO_BRAINTRUST=1 also records the run as a Braintrust experiment, as
 * one score per thread (its pass rate, failing checks in metadata), and refuses to start above 2,000 scores.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Eval } from 'braintrust';
import { testEnv } from '../tests/harness';
import { runThread, type Scenario, type TurnOut } from './harness';
import { acrossThread, modelGraded, perEmail } from './scorers';
import { CORE } from './scenarios/core';
import { FAMILIES } from './scenarios/families';
import { LONG } from './scenarios/long';
import { simGoal, simulatedCustomers } from './scenarios/simulated';
import { loadProductionThreads, originalReplies, productionScenario } from './production';
import { installProviderWatch } from './provider-watch';
import { judgeCheck, scoreCapRefusal, threadResult, type EvalResults } from './results';
import { isProviderError } from './run-health';

const send = process.env.EVAL_SEND_TO_BRAINTRUST === '1';
// Local runs must not reach Braintrust at all: without the key the app's and the judges' clients aren't traced.
if (!send) delete process.env.BRAINTRUST_API_KEY;
else if (!process.env.BRAINTRUST_API_KEY) throw new Error('EVAL_SEND_TO_BRAINTRUST=1 needs BRAINTRUST_API_KEY (.env.braintrust)');
// Before any OpenAI client exists: the SDK picks up the global fetch when a client is constructed.
const providerWatch = installProviderWatch();

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) throw new Error('OPENAI_API_KEY is not set (put it in .env.local)');
const env = testEnv();
const model = env.OPENAI_BASE_MODEL;

const suite = process.env.EVAL_SUITE ?? 'pr';
const originals = new Map<string, unknown>();
/** Real customer threads (encrypted artifact), most recent EVAL_PROD_LIMIT of them (default 10). */
function production(): Scenario[] {
  const threads = loadProductionThreads().slice(-Number(process.env.EVAL_PROD_LIMIT ?? 10));
  return threads.map((r) => { const s = productionScenario(r); originals.set(s.id, originalReplies(r)); return s; });
}
const groups: Record<string, () => Scenario[] | Promise<Scenario[]>> = {
  core: () => CORE,
  families: () => FAMILIES,
  long: () => LONG,
  sim: () => simulatedCustomers(openaiKey, model),
  prod: production,
};
const pick: Record<string, string[]> = { pr: ['core', 'families'], nightly: ['core', 'families', 'long', 'sim', 'prod'] };
const chosen = (await Promise.all((pick[suite] ?? suite.split(',')).map(async (g) => (await groups[g]?.()) ?? []))).flat();
const only = process.env.EVAL_ONLY?.split(',').filter(Boolean);
const scenarios = only ? chosen.filter((s) => only.some((o) => s.id.includes(o))) : chosen;

const byId = new Map(scenarios.map((s) => [s.id, s]));
const capRefusal = send ? scoreCapRefusal(scenarios.length) : null;
if (capRefusal) throw new Error(capRefusal);

/**
 * What Braintrust stores per row (send mode only): the scenario without functions, real screenshots or catalog rows.
 * Every check used to log its own copy of the whole scenario and transcript; with real threads (images, catalog slices)
 * one run reached ~190 MB against a 1 GB monthly plan. The task and checks look the full scenario up by id.
 */
const light = (s: Scenario) => ({
  id: s.id, capability: s.capability, tags: s.tags ?? [], now: s.now ?? null,
  steps: s.steps.map((st) => ('text' in st ? { text: st.text, ...(st.screenshots?.length ? { screenshots: st.screenshots } : {}), ...(st.images?.length ? { images: st.images.length } : {}), ...(st.expect ? { expect: st.expect } : {}) } : { kind: 'wait', hours: st.hours, note: st.note ?? null, ...(st.expect ? { expect: st.expect } : {}) })),
});
type Light = ReturnType<typeof light>;
type Check = ((a: { input: Scenario; output: TurnOut[] }) => unknown) & { name: string };
type CheckOut = { name: string; score: number | null; metadata?: Record<string, unknown> };
const checks = [...perEmail, ...acrossThread, simGoal, ...modelGraded(openaiKey, model)] as Check[];

/** Every check's outcome per thread, for eval-results.json; Braintrust (send mode) only gets the pass rate. */
const outcomes = new Map<string, { checks: Record<string, { score: number | null; metadata?: unknown; error?: string }>; output: TurnOut[]; errors: unknown[] }>();

/** All checks as one scorer: one score per thread, the share of applicable checks that passed. */
async function passRate({ input, output }: { input: Light; output: TurnOut[] }) {
  const full = byId.get(input.id)!;
  const got: Record<string, { score: number | null; metadata?: unknown; error?: string }> = {};
  const errors: unknown[] = [];
  await Promise.all(checks.map(async (c, i) => {
    try {
      const r = (await c({ input: full, output })) as CheckOut | null;
      if (r && typeof r.name === 'string') got[r.name] = { score: r.score ?? null, metadata: r.metadata ?? {} };
    } catch (e) {
      errors.push(e);
      got[c.name || `check_${i}`] = { score: null, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
  }));
  outcomes.set(input.id, { checks: got, output, errors });
  const judged = Object.entries(got).filter(([, c]) => !c.error).map(([name, c]) => ({ check: name, ...judgeCheck(name, c.score, c.metadata) })).filter((c) => c.pass != null);
  const failing = judged.filter((c) => !c.pass).map((c) => ({ check: c.check, reason: c.reason }));
  return { name: 'pass_rate', score: judged.length ? (judged.length - failing.length) / judged.length : null, metadata: { failing } };
}

const sha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; } })();

const run = await Eval('My Project', {
  experimentName: process.env.EVAL_EXPERIMENT_NAME ?? `conversations-${suite}-${sha}`,
  metadata: { gitSha: sha, suite, model, effort: env.OPENAI_BASE_EFFORT, scenarios: scenarios.length },
  data: () => scenarios.map((s) => ({ input: light(s), metadata: { id: s.id, capability: s.capability, tags: s.tags ?? [], steps: s.steps.length, ...(originals.has(s.id) ? { originalReplies: originals.get(s.id) } : {}) } })),
  task: async (input: Light) => runThread(byId.get(input.id)!, openaiKey),
  scores: [passRate],
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY ?? 6),
  trialCount: 1,
}, { noSendLogs: !send });

const taskErrors = new Map(run.results.filter((r) => r.error != null).map((r) => [(r.input as Light).id, r.error]));
const watched = providerWatch.counts();
// A failed call the SDK surfaced as a thread's or a judge's error, beyond what the HTTP watch saw (a quota message in a
// non-429 response, say), still counts.
const providerThrown = [...taskErrors.values(), ...[...outcomes.values()].flatMap((o) => o.errors)].filter(isProviderError).length;
const results: EvalResults = {
  version: 1,
  createdAt: new Date().toISOString(),
  commit: sha,
  suite,
  model,
  expected: scenarios.length,
  sentToBraintrust: send,
  provider: { llmErrors: watched.llmErrors, quotaOrRateLimit: Math.max(watched.quotaOrRateLimit, providerThrown) },
  threads: scenarios.map((s) => {
    const o = outcomes.get(s.id);
    return threadResult({ id: s.id, scenario: s.capability, tags: s.tags, checks: o?.checks ?? {}, error: taskErrors.get(s.id) ?? (o ? null : 'not scored'), output: o?.output ?? null });
  }),
};
const file = process.env.EVAL_RESULTS_FILE ?? 'eval-results.json';
writeFileSync(file, `${JSON.stringify(results, null, 1)}\n`);
console.log(`wrote ${file}: ${results.threads.length} threads, ${results.provider.llmErrors} failed model call(s)${send ? '; sent to Braintrust as one score per thread' : '; nothing sent to Braintrust'}`);
