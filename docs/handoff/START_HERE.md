# Ticket Guy — Claude Code handoff

Prepared September 22, 2026. This is a specification, not an implemented service.

## Build instruction

Build the email-first MVP described in this package. The customer writes to **my@ticketguy.live** with a ticket link, screenshot, or description. Ticket Guy finds suitable alternatives, explains the comparison, and links to the seller. US customers and US events only. No purchases or ticket custody. Use the engineering specification as the product contract; document material deviations before implementing them.

Read in order:
1. `ENGINEERING_SPEC.md` — product, architecture, vendors, data, operational controls, costs and launch gates.
2. `ADVICE_ENGINE.md` — required historical benchmarks, group-aware trends, buy/wait policy and trusted response generation.
3. `API_AND_DATA_CONTRACTS.md` — implementation boundaries and invariants.
4. `IMPLEMENTATION_PLAN.md` — build sequence and acceptance checks.
5. `research/ticket-guy-us-ticket-source-master.md` and the adjacent source registry — research candidates and category routes, not granted API access.
6. `.env.example` — safe configuration defaults.

Implement one deployable TypeScript application, durable background workflows, migrations, a staff console, tests and a practical README. Start with synthetic fixtures and outbound email disabled. Work through each phase independently of missing production credentials. Do not silently replace missing ticket inventory with invented results, event-level price ranges, or unrestricted scraping. Build the manual research/review path alongside adapter interfaces so a staffed pilot can operate using sources whose access and use have been cleared.

Use current stable package versions verified against their official documentation at implementation time, pin a lockfile, and use SDK-supported calls. Models and vendor prices in this document were checked on the research date and must be rechecked before launch. Keep model IDs configurable. Do not infer anything about the coding agent's model from the user's informal model name.

## Fixed decisions

- Brand: Ticket Guy. Entry point: my@ticketguy.live. No SMS, browser extension or URL-prefix product in v1.
- Resend for inbound/outbound email; OpenAI Responses API; Render PostgreSQL with postgres.js/Drizzle, PGlite locally, database-backed private media and Better Auth staff MFA; Inngest workflows; Next.js on Render.
- gpt-5.4-mini for normal extraction/drafting; gated gpt-5.4 escalation. Deterministic code computes affordability, savings, eligibility, freshness and ranking.
- Human approval for recommendations and price alerts during the pilot.
- Interests derived from requests are separate from marketing permission. No automatic promotional enrollment from sending a concierge request.
- Direct checkout links only. Affiliate compensation never influences ranking.
- Full source coverage is an ambition, not an MVP promise. Record sources checked, failures and omissions honestly.

## Proposed pilot defaults

The spec proposes NYC concerts and NHL/NBA/MLB events as an operational launch wedge; the architecture supports US-wide routing. This is a recommendation, not a claim that the founder already selected these categories. Make geography/category coverage and staffing hours configurable. Outside supported coverage, acknowledge the limitation and route to staff; never fabricate a result.

## Credentials and decisions needed for a live pilot

Build local/demo behavior first. Then obtain: domain/DNS access, Resend account and webhook secret, written suitability confirmation for the intended affiliate/promotional use, OpenAI account with available selected models and budget, dedicated Render app/database in a matching US region and an Inngest account, staff accounts, approved inventory/data access, business postal address, privacy/terms content, operating hours and an owner for customer escalations. Do not send emails to vendors or customers, buy subscriptions, change live DNS, or deploy publicly merely because this handoff exists.

If a production gate is missing, finish all unaffected work and report the exact missing dependency. Do not mark the service live. Keep a decision log distinguishing implemented, fixture-only, manually operated and approved live integrations.

## Required delivery

- Source repository, migrations and synthetic fixtures; no real personal data committed.
- Working local email simulation and staff review flow.
- Automated acceptance checks mapped to `IMPLEMENTATION_PLAN.md`.
- Deployment/runbook instructions covering webhook verification, recovery, replay, backups, retention, suppression, model/source budgets and kill switches.
- Production readiness checklist with evidence and explicit unresolved gates.
- Short demo script showing request → clarification → verified comparison → approval → email → watch → alert → unsubscribe/deletion.

## Stack revision — September 22, 2026

Updated to the founder’s existing Render PostgreSQL / Drizzle / PGlite pattern. One schema and migration set, environment-selected drivers, database-backed pilot media. Better Auth supplies staff sessions and MFA. The other project’s database remains separate. Local PGlite fallback is never allowed in production. See the engineering spec for deployment, media limits and real-Postgres CI requirements.

## Required advice-engine addition

Read and implement ADVICE_ENGINE.md as core MVP scope. Historical-data acquisition is a separate production gate: build the import/benchmark/trend paths now, but never manufacture live history. Advice must consider the exact group size and seating constraints, distinguish asking prices from sales, explain evidence limits, and issue bounded buy/wait guidance. The advice-engine four-observation trend gate replaces the older three-observation rule.
