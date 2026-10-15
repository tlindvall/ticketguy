/**
 * Ticket Guy conversation evals (Braintrust). Real pipeline, real model, eval world (evals/world.ts), no email sent.
 *
 *   pnpm eval                                   # EVAL_SUITE=pr: core + families (~50 threads)
 *   EVAL_SUITE=nightly pnpm eval                # + long threads + simulated customers
 *   EVAL_SUITE=long|sim|families|core pnpm eval
 *   EVAL_ONLY=rangers-this-thursday,long/ pnpm eval   # ids containing any of these
 *
 * Needs OPENAI_API_KEY (.env.local) and BRAINTRUST_API_KEY (.env.braintrust). Spend is capped by the app's own budget
 * ledger per thread (EVAL_BUDGET_USD, default 10) since every thread starts from an empty database.
 */
import { execSync } from 'node:child_process';
import { Eval } from 'braintrust';
import { testEnv } from '../tests/harness';
import { runThread, type Scenario, type TurnOut } from './harness';
import { acrossThread, modelGraded, perEmail } from './scorers';
import { CORE } from './scenarios/core';
import { FAMILIES } from './scenarios/families';
import { LONG } from './scenarios/long';
import { simGoal, simulatedCustomers } from './scenarios/simulated';
import { loadProductionThreads, originalReplies, productionScenario } from './production';

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) throw new Error('OPENAI_API_KEY is not set (put it in .env.local)');
const env = testEnv();
const model = env.OPENAI_BASE_MODEL;

const suite = process.env.EVAL_SUITE ?? 'pr';
const originals = new Map<string, unknown>();
/** Real customer threads (private dataset), most recent EVAL_PROD_LIMIT of them (default 30). */
async function production(): Promise<Scenario[]> {
  const threads = (await loadProductionThreads()).slice(-Number(process.env.EVAL_PROD_LIMIT ?? 30));
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
/**
 * What Braintrust stores per row: the scenario without functions, real screenshots or catalog rows. Every check used to
 * log its own copy of the whole scenario and transcript; with real threads (images, catalog slices) one run reached
 * ~190 MB against a 1 GB monthly plan. The task and checks look the full scenario up by id.
 */
const light = (s: Scenario) => ({
  id: s.id, capability: s.capability, tags: s.tags ?? [], now: s.now ?? null,
  steps: s.steps.map((st) => ('text' in st ? { text: st.text, ...(st.screenshots?.length ? { screenshots: st.screenshots } : {}), ...(st.images?.length ? { images: st.images.length } : {}), ...(st.expect ? { expect: st.expect } : {}) } : { kind: 'wait', hours: st.hours, note: st.note ?? null, ...(st.expect ? { expect: st.expect } : {}) })),
});
type Light = ReturnType<typeof light>;
type Check = (a: { input: Scenario; output: TurnOut[] }) => unknown;
/** Several checks as one Braintrust scorer (one span, one copy of the transcript); each check's details stay under its name. */
function combined(name: string, checks: Check[]) {
  const fn = async ({ input, output }: { input: Light; output: TurnOut[] }) => {
    const full = byId.get(input.id)!;
    const rs = (await Promise.all(checks.map((c) => c({ input: full, output })))) as Array<{ name: string; score: number | null; metadata?: Record<string, unknown> } | null>;
    return rs.filter((r): r is NonNullable<typeof r> => !!r && typeof r.name === 'string').map((r) => ({ name: r.name, score: r.score ?? null, metadata: r.metadata ?? {} })); // Braintrust files each under its score name
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

const sha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; } })();

Eval('My Project', {
  experimentName: process.env.EVAL_EXPERIMENT_NAME ?? `conversations-${suite}-${sha}`,
  metadata: { gitSha: sha, suite, model, effort: env.OPENAI_BASE_EFFORT, scenarios: scenarios.length },
  data: () => scenarios.map((s) => ({ input: light(s), metadata: { id: s.id, capability: s.capability, tags: s.tags ?? [], steps: s.steps.length, ...(originals.has(s.id) ? { originalReplies: originals.get(s.id) } : {}) } })),
  task: async (input: Light) => runThread(byId.get(input.id)!, openaiKey),
  scores: [combined('checks', [...perEmail, ...acrossThread, simGoal] as Check[]), combined('graded', modelGraded(openaiKey, model) as Check[])],
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY ?? 6),
  trialCount: 1,
});
