# Ticket Guy — MVP (fixture mode)

Email-first ticket concierge for US live events. A customer emails **my@ticketguy.live** with a link, screenshot or description; the service resolves the event, checks permitted sources, compares whole-party totals deterministically, computes group-aware advice (benchmark, trend, buy/wait policy), and a human approves every recommendation before it is sent. Customers buy from the seller; we never hold tickets or payments.

**Status: not live.** This repository runs end to end in `APP_MODE=fixture` with synthetic data and outbound email disabled. Live sending, provider accounts, ticket-data rights and DNS remain explicit launch gates — see [docs/READINESS_CHECKLIST.md](docs/READINESS_CHECKLIST.md) and [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md).

## Documents

| Doc | Purpose |
|---|---|
| [docs/handoff/START_HERE.md](docs/handoff/START_HERE.md) | Original build instruction (read in order: spec → advice engine → contracts → plan) |
| [docs/handoff/ENGINEERING_SPEC.md](docs/handoff/ENGINEERING_SPEC.md) | Product contract, architecture, vendors, data model, operations, gates |
| [docs/handoff/ADVICE_ENGINE.md](docs/handoff/ADVICE_ENGINE.md) | Benchmark/trend/policy/response-validation requirements |
| [docs/handoff/API_AND_DATA_CONTRACTS.md](docs/handoff/API_AND_DATA_CONTRACTS.md) | Interfaces and invariants |
| [docs/handoff/IMPLEMENTATION_PLAN.md](docs/handoff/IMPLEMENTATION_PLAN.md) | Milestones and acceptance matrix A01–A66 |
| [research/](research/) | 135-entry source registry (JSON) and research master |
| [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) | What is real, fixture-only, manual, or blocked |
| [docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md) | A01–A66 → test / evidence / status |
| [docs/DECISION_LOG.md](docs/DECISION_LOG.md) | Deviations and judgment calls |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operator runbook (DNS, webhooks, recovery, replay, deletion, kill switches…) |
| [docs/READINESS_CHECKLIST.md](docs/READINESS_CHECKLIST.md) | Production readiness with evidence and unresolved gates |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | 10-minute demo: request → clarification → comparison → approval → (blocked) send → watch → alert → unsubscribe → deletion |

## Stack

Next.js 16 (App Router, TypeScript strict) · Drizzle ORM with one `pg-core` schema and reviewed SQL migrations in `/drizzle` · postgres.js on Render PostgreSQL (production) / PGlite (local + fast tests) · Better Auth (staff only, TOTP) · Inngest (durable steps + cron) · Resend (inbound + outbound; disabled by default) · Anthropic Messages API (Claude Opus 5, structured outputs; fixture extractor/drafter by default) · Tailwind · Vitest · GitHub Actions with a real PostgreSQL 18 service.

## Local setup (fixture mode, no credentials)

Requirements: Node 22 LTS, pnpm 10 (`corepack enable`).

```bash
pnpm install
cp .env.example .env            # defaults: APP_MODE=fixture, all sends disabled, no DATABASE_URL → PGlite
pnpm db:migrate                 # applies /drizzle to .local/pglite (creates it)
pnpm db:seed                    # 135 sources as not_integrated + synthetic fixture world
STAFF_INITIAL_PASSWORD='<min 12 chars>' pnpm tsx scripts/create-staff.ts you@example.com admin
pnpm simulate:inbound --file tests/fixtures/emails/rangers-five.txt   # full pipeline in-process
DEV_ALLOW_STAFF_WITHOUT_MFA=true pnpm dev                              # http://localhost:3000/admin/login
```

`DEV_ALLOW_STAFF_WITHOUT_MFA` is honored only outside staging/production; otherwise every staff route requires TOTP enrollment at `/admin/setup-mfa`.

PGlite is single-process: run one app process against `.local/pglite` at a time (the CLI scripts run before/after the dev server, not concurrently). If PGlite aborts on open after an unclean shutdown, `pnpm db:reset-local` recreates it (then re-run `create-staff`).

### Commands

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm typecheck` · `pnpm lint` · `pnpm test` | Strict TS, ESLint, unit + PGlite acceptance tests |
| `TEST_DATABASE_URL=postgres://… pnpm vitest run --project pg` | Real-PostgreSQL concurrency/authorization tests (A42/A43/A17/A34) |
| `pnpm db:generate` | Generate a migration from `src/lib/db/schema.ts` (review it; never `push` to production) |
| `pnpm db:migrate` | Apply migrations (advisory-locked on PostgreSQL; uses `MIGRATION_DATABASE_URL` when set) |
| `pnpm db:seed` | Import registry; seed fixtures only in fixture mode |
| `pnpm simulate:inbound` | Feed the normalized inbound contract and drain the outbox locally |
| `pnpm registry:build` | Regenerate `research/ticket-guy-us-source-registry.json` from `scripts/registry-source.tsv` |

## How a request flows

```
Resend webhook (Svix-signed, raw bytes) ─▶ inbound_events + outbox (one tx) ─▶ outbox dispatcher (Inngest cron / recover endpoint)
  ─▶ ingestInbound: auto-reply detection, thread authorization, contact/conversation/message, bounded attachments (db media)
  ─▶ interpret: extraction (fixture rules or Claude structured output) → revision → event resolution (never invents) → clarification | research
  ─▶ research: source plan from 29 category routes → adapters (not_integrated / manual / fixture / TM discovery) → coverage ledger
       → deterministic comparison (cents, hard constraints, unknowns flagged) → benchmark + trend + policy → claim packet
       → drafter (fixture or model) → renderer/validator (claim IDs only) → recommendation awaiting review
  ─▶ staff approves exact draft hash + revision (freshness checked) ─▶ send intent (immutable, dedupe key)
  ─▶ dispatch: claim → gate (mode, switches, suppression, approval, revision, freshness, fixture content) → Resend idempotent send
```

Key modules: `src/lib/intake/pipeline.ts` (orchestration), `src/lib/domain/*` (money, comparison, freshness, dates, interests, watches), `src/lib/advice/*` (benchmark, trend, policy, packet, renderer), `src/lib/email/*` (webhook verify, send gate, send intents, Resend, templates), `src/lib/sources/*` (registry, routing, adapters), `src/lib/ai/*` (extraction, drafting, OpenAI, budget), `src/inngest/*`, `src/app/admin/*` (staff console), `src/app/api/*`.

## Fixture mode vs live

| | Fixture (default) | Live |
|---|---|---|
| Database | PGlite in `.local/pglite` | `DATABASE_URL` required; startup fails without it |
| Sources | `fixture-source`, `fixture-source-b` synthetic offers; all 135 real sources `not_integrated` | Only adapters with recorded access approval; manual evidence path always available |
| AI | Deterministic `FixtureExtractor` / `FixtureDrafter` | Anthropic Messages API (Claude Opus 5) with budget reservation |
| Email | Every send intent is created and then **blocked** by the gate (`app_mode_fixture`, `email_send_disabled`) | Requires `EMAIL_SEND_ENABLED=true`, `RESEND_API_KEY`, kill switches allowing, human approval, fresh evidence |
| History | Synthetic Rangers preseason cohort (flagged `isFixture`) | Only `approved` licensed datasets; fixture rows inadmissible |

Fixture content can never pass the send gate, even with sends enabled (`content_contains_fixture_data`).

## Deployment

`render.yaml` describes one paid Node web service and a dedicated PostgreSQL 18 database in the same US region, with `preDeployCommand: pnpm db:migrate` as the single migration step. Secrets are dashboard-only (`sync: false`). See [docs/RUNBOOK.md](docs/RUNBOOK.md) for DNS, webhook, Inngest and recovery setup, and [docs/READINESS_CHECKLIST.md](docs/READINESS_CHECKLIST.md) before enabling anything.
