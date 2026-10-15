<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Conversation evals

`pnpm eval` runs `evals/ticketguy.eval.ts`: email threads through the real pipeline with the real model
(`gpt-6.1-sol`), the eval world (`evals/world.ts`: ~40 NY/LA events, listings, price histories, seat zones, links),
an in-memory database and no email sent. Needs `OPENAI_API_KEY` in `.env.local` (gitignored). Spend is capped per
thread by `EVAL_BUDGET_USD` (default 10).

- Local by default: nothing is sent to Braintrust (it bills per score). Results go to `eval-results.json` (per thread:
  each check's pass/fail and reason; real customer threads keep only their id and failing steps). In CI the run's
  summary compares every check's pass rate with the previous run and lists newly failing and newly passing threads;
  the `eval-results` artifact (90 days) carries the file and `evals/history.csv`, one row per run, for trends.
  `EVAL_SEND_TO_BRAINTRUST=1` (with `BRAINTRUST_API_KEY` in `.env.braintrust`) also records the run there, as one score
  per thread, and refuses above 2,000.

- Suites (`EVAL_SUITE`): `pr` (default, core + families, ~55 threads, runs in CI on PRs touching `src/` or `evals/`),
  `nightly` (+ long threads + simulated customers + the latest `EVAL_PROD_LIMIT` real threads, default 10, from the
  encrypted `production-threads` artifact), or any of `core`, `families`, `long`, `sim`, `prod`.
- `EVAL_ONLY=rangers-this-thursday,long/ pnpm eval` runs ids containing any of those strings.
- Scenarios live in `evals/scenarios/`: `core.ts`, `families.ts` (one job phrased clean / messy / ambiguous: typos,
  nicknames, text-speak), `long.ts` (10-12 email threads with the market moving mid-thread), `simulated.ts` (an AI
  customer with a persona and hidden preferences). A scenario step is an email (text, optional generated screenshots)
  or time passing (`kind: 'wait'`, optional market change, optional price-alert check).
- Scores (`evals/scorers.ts`): per email (event, party, budget, grounded prices and links, "seats together" claims
  true, one question max, one email per message, design), across the thread (memory, repeated replies, re-asked
  questions), and model-graded (answered the question; only what was asked, i.e. no unrequested content; whole-thread coherence naming the step where it broke).
- Production flags: the eval runs with the app's defaults, which match `render.yaml` (price alerts and event alerts
  off), and sends drafts as written (`AUTO_SEND_RECOMMENDATIONS`), as production does with its testers' allowlist. Scenarios that test a feature that is off in production set `env` and carry the tag `flag-off-in-prod`.

Rules:

- Every behaviour fix to extraction, resolution, conversation state or drafting: run `pnpm eval` before and after and
  put the score table (the run's summary, with its comparison against the previous run) in the PR. A fix that regresses another
  scenario is not done.
- A live failure becomes a scenario first (customer's exact words, expected event/party/budget), then gets fixed.
  Unit tests stay; the eval is what proves it against the real model.
- Single runs vary; re-run a scenario before calling a one-off drop a regression.
- Never relax a scorer or an expectation to make a fix pass. If a scorer is wrong, fix it in its own commit and say so.
