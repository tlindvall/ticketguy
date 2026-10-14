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

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) throw new Error('OPENAI_API_KEY is not set (put it in .env.local)');
const env = testEnv();
const model = env.OPENAI_BASE_MODEL;

const suite = process.env.EVAL_SUITE ?? 'pr';
const groups: Record<string, () => Scenario[]> = {
  core: () => CORE,
  families: () => FAMILIES,
  long: () => LONG,
  sim: () => simulatedCustomers(openaiKey, model),
};
const pick: Record<string, string[]> = { pr: ['core', 'families'], nightly: ['core', 'families', 'long', 'sim'] };
const chosen = (pick[suite] ?? suite.split(',')).flatMap((g) => groups[g]?.() ?? []);
const only = process.env.EVAL_ONLY?.split(',').filter(Boolean);
const scenarios = only ? chosen.filter((s) => only.some((o) => s.id.includes(o))) : chosen;

const sha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; } })();

Eval('My Project', {
  experimentName: process.env.EVAL_EXPERIMENT_NAME ?? `conversations-${suite}-${sha}`,
  metadata: { gitSha: sha, suite, model, effort: env.OPENAI_BASE_EFFORT, scenarios: scenarios.length },
  data: () => scenarios.map((s) => ({ input: s, metadata: { id: s.id, capability: s.capability, tags: s.tags ?? [], steps: s.steps.length } })),
  task: async (input: Scenario) => runThread(input, openaiKey),
  scores: [...perEmail, ...acrossThread, ...modelGraded(openaiKey, model), simGoal],
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY ?? 6),
  trialCount: 1,
});
