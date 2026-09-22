# Production readiness checklist

Status as of 2026-09-22. **The service is not live and must not be marked live.** Items marked GATE require an owner input that does not exist in this repository.

## Verified here (evidence)

| Item | Evidence |
|---|---|
| Clean setup from README on a fresh checkout | `pnpm install && pnpm db:migrate && pnpm db:seed && pnpm simulate:inbound …` produced a reviewed draft (see DEMO_SCRIPT) |
| Reproducible migrations on both drivers | `drizzle/0000_init.sql`, `0001_two_factor_plugin_fields.sql` applied on PGlite (tests) and PostgreSQL 16 (local) / 18 (CI) |
| Seeded registry: 135 sources `not_integrated`, 29 routes validated at startup | `tests/acceptance/sources.test.ts` |
| Anonymous access denied server-side | `/admin/*` → 307 login, `/api/admin/*` → 401, `/api/admin/media/:id` → 401 (smoke-tested) |
| Staff role, MFA and origin checks | `requireStaff`, `assertSameOrigin` (403 on foreign origin smoke-tested) |
| All live sends disabled by default; fixture content unsendable | `env.test.ts`, pipeline tests (`app_mode_fixture`, `content_contains_fixture_data`) |
| Duplicate/reordered events and crash recovery without duplicate replies | A16/A17/A18/A19 tests; real-PG lease exclusivity (A43) |
| Auto-reply loops stop; strangers cannot inherit threads | A21/A20 tests |
| Deterministic money/eligibility; unknowns never verified | A01/A06–A10/A12/A27 tests |
| Advice engine gates and response validation | A48–A63 tests |
| Budgets atomic under concurrency | A34 real-PG test |
| No secrets or server modules in browser bundles | CI grep over `.next/static` |

## Unresolved gates (owner inputs)

| # | Gate | Needed from | Blocks |
|---|---|---|---|
| G1 | Domain ownership + DNS access for `ticketguy.live`; MX coexistence decision | Owner | Any inbound/outbound mail |
| G2 | Resend account, verified domains, webhook secret; written suitability confirmation for (a) service replies with affiliate links and (b) opt-in promotions | Owner + Resend | `EMAIL_SEND_ENABLED`, marketing |
| G3 | Staging test of real Resend payload shapes (received email retrieval, attachment URLs, event field names) | Staging account | Trusting the intake normalizer |
| G4 | OpenAI account, model availability (`gpt-5.4-mini-2026-03-17`, `gpt-5.4`), budget; bounded eval run | Owner | Live extraction/drafting; eval report |
| G5 | Render account, dedicated US-region app + PostgreSQL 18, migration/runtime roles, PITR enabled, restore drill | Owner | Deployment |
| G6 | Inngest account and keys (or Render cron hitting `/api/internal/recover-outbox`) | Owner | Unattended processing |
| G7 | Ticket-source access rights (per adapter: commercial use, caching, monitoring, retention, rate limits) recorded in activation evidence | Owner + vendors | Any non-fixture adapter; unattended watches |
| G8 | Licensed historical dataset (vendor terms, sample rows, retention/derived-data rights) + importer | Owner + vendor | Live benchmark claims |
| G9 | Legal business name, postal address, privacy/terms review; notice version | Owner + counsel | Public launch; preference page copy |
| G10 | Staff identities, allowlist, TOTP enrollment; escalation owner and staffed hours | Owner | Pilot operations |
| G11 | Sentry project + alert destinations | Owner | Error alerting |
| G12 | Affiliate agreements + disclosure text (ranking never uses commission — enforced) | Owner | Affiliate links |

## Before flipping `EMAIL_SEND_ENABLED=true`

- [ ] `APP_MODE=live`, `DATABASE_URL` set, PGlite impossible (startup check).
- [ ] `EMAIL_TEST_RECIPIENT_ALLOWLIST` set to staff test addresses for the first sends.
- [ ] One real staging conversation: inbound → brief → manual/verified evidence → approval → threaded reply landed with SPF/DKIM/DMARC pass (G1–G3).
- [ ] Cancellation/unsubscribe scenario exercised end-to-end on staging.
- [ ] Replayed and malformed webhook events produced no duplicate or unauthorized sends (staging).
- [ ] Kill switches tested live; `/admin/operations` reviewed; on-call owner named.
- [ ] Privacy/terms replaced (G9); postal address present in marketing templates (none sendable yet).
