<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Conversation evals (Braintrust)

`pnpm eval` runs `evals/ticketguy.eval.ts`: multi-turn email threads through the real pipeline with the real model
(`gpt-6.1-sol`), fixture inventory, in-memory database, no email sent. Needs `OPENAI_API_KEY` in `.env.local` and
`BRAINTRUST_API_KEY` in `.env.braintrust` (both gitignored). Spend is capped per run by `EVAL_BUDGET_USD` (default 10).
`EVAL_ONLY=pick-by-opponent,which-is-cheapest pnpm eval` runs only those scenarios.

- Every behaviour fix to extraction, resolution, conversation state or drafting: run `pnpm eval` before and after and
  put the score table (and the Braintrust experiment link it prints) in the PR. A fix that regresses another
  scenario is not done.
- A live failure becomes a scenario in `SCENARIOS` first (customer's exact words, expected event/party/budget), then
  gets fixed. Unit tests stay; the eval is what proves it against the real model.
- Scores are invariants (event, party size, budget, grounded prices and links, one question max, no relist after a
  close) plus one model-graded "answered the question". Single runs vary; re-run a scenario before calling a
  one-off drop a regression.
