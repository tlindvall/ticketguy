<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Conversation evals (Braintrust)

`pnpm eval` runs `evals/ticketguy.eval.ts`: email threads through the real pipeline with the real model
(`gpt-6.1-sol`), the eval world (`evals/world.ts`: ~40 NY/LA events, listings, price histories, seat zones, links),
an in-memory database and no email sent. Needs `OPENAI_API_KEY` in `.env.local` and `BRAINTRUST_API_KEY` in
`.env.braintrust` (both gitignored). Spend is capped per thread by `EVAL_BUDGET_USD` (default 10).

- Suites (`EVAL_SUITE`): `pr` (default, core + families, ~55 threads, runs in CI on AI/pipeline PRs), `nightly`
  (+ long threads + simulated customers), or any of `core`, `families`, `long`, `sim`.
- `EVAL_ONLY=rangers-this-thursday,long/ pnpm eval` runs ids containing any of those strings.
- Scenarios live in `evals/scenarios/`: `core.ts`, `families.ts` (one job phrased clean / messy / ambiguous: typos,
  nicknames, text-speak), `long.ts` (10-12 email threads with the market moving mid-thread), `simulated.ts` (an AI
  customer with a persona and hidden preferences). A scenario step is an email (text, optional generated screenshots)
  or time passing (`kind: 'wait'`, optional market change, optional price-alert check).
- Scores (`evals/scorers.ts`): per email (event, party, budget, grounded prices and links, "seats together" claims
  true, one question max, one email per message, design), across the thread (memory, repeated replies, re-asked
  questions), and model-graded (answered the question; whole-thread coherence naming the step where it broke).
- Production flags: the eval runs with the app's defaults, which match `render.yaml` (price alerts and event alerts
  off), and sends drafts as written (`AUTO_SEND_RECOMMENDATIONS`), as production does with its testers' allowlist. Scenarios that test a feature that is off in production set `env` and carry the tag `flag-off-in-prod`.

Rules:

- Every behaviour fix to extraction, resolution, conversation state or drafting: run `pnpm eval` before and after and
  put the score table (and the Braintrust experiment link it prints) in the PR. A fix that regresses another
  scenario is not done.
- A live failure becomes a scenario first (customer's exact words, expected event/party/budget), then gets fixed.
  Unit tests stay; the eval is what proves it against the real model.
- Single runs vary; re-run a scenario before calling a one-off drop a regression.
- Never relax a scorer or an expectation to make a fix pass. If a scorer is wrong, fix it in its own commit and say so.
