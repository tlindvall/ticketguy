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
import { runThread, type Scenario } from './harness';
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

const sha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; } })();

Eval('My Project', {
  experimentName: process.env.EVAL_EXPERIMENT_NAME ?? `conversations-${suite}-${sha}`,
  metadata: { gitSha: sha, suite, model, effort: env.OPENAI_BASE_EFFORT, scenarios: scenarios.length },
  data: () => scenarios.map((s) => ({ input: s, metadata: { id: s.id, capability: s.capability, tags: s.tags ?? [], steps: s.steps.length, ...(originals.has(s.id) ? { originalReplies: originals.get(s.id) } : {}) } })),
  task: async (input: Scenario) => runThread(input, openaiKey),
  scores: [...perEmail, ...acrossThread, ...modelGraded(openaiKey, model), simGoal],
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY ?? 6),
  trialCount: 1,
});
