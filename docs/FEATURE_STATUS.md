# Feature status

Legend — **Real**: implemented and exercised against the real dependency. **Fixture-only**: implemented and tested, but only against synthetic data/adapters in this repo. **Manual**: implemented as a staffed path. **Blocked**: implemented up to the gate; cannot proceed without an external input.

| Capability | Status | Notes / evidence |
|---|---|---|
| Config validation, explicit booleans, production refuses PGlite/fixture/non-https APP_URL/keyless OpenAI | Real | `src/lib/config/env.ts`, `env.test.ts` |
| Drizzle schema + reviewed migrations, PGlite/postgres.js driver selection | Real | 50 tables; `drizzle/0000_init.sql`, `0001_two_factor_plugin_fields.sql`; applied on PGlite and PostgreSQL 16 locally, PostgreSQL 18 in CI |
| Advisory-locked single migration step | Real (local PG16) | `src/lib/db/migrate.ts`, `render.yaml preDeployCommand` |
| Staff auth (Better Auth, invite-only, TOTP), role + MFA + origin checks on every admin route | Real | Signed in and exercised console locally; MFA enrollment page; `DEV_ALLOW_STAFF_WITHOUT_MFA` dev-only |
| Runtime vs migration DB role separation | Real (test) | `tests/pg` proves a least-privilege role cannot alter schema; Render roles still to be provisioned |
| Source registry import (135, `not_integrated`) + 29 validated category routes | Real | `tests/acceptance/sources.test.ts` |
| Adapter contract: not_integrated / manual / fixture / Ticketmaster Discovery (events only) | Fixture-only + Blocked | Discovery adapter coded against documented v2 endpoint, disabled without key + terms clearance; no live payload validated |
| Any live listing/quote adapter (StubHub, Ticket Evolution, TicketNetwork, SeatGeek…) | Blocked | No access rights; manual evidence path covers the pilot |
| Manual evidence entry with completeness flags | Manual | `/admin/requests/:id` form → `approved_manual` observations join the comparison |
| Resend webhook (Svix signature on raw bytes, dedupe, transactional outbox) | Real (unit) / Blocked (staging) | Signature math tested; real provider payload/field names unverified until a staging account exists |
| Resend retrieval + bounded attachment download + normalizer | Blocked | Coded to documented API; not exercised against a live account |
| Local inbound simulator (normalized contract) | Real | CLI + admin form (fixture mode only) |
| Auto-response suppression, thread authorization, quoted-content stripping | Real | A20/A21/A04 tests |
| Attachment validation (magic bytes, dimensions, pixel bomb, SVG/HTML/PDF rejection), db media with budget | Real | A22/A44/A45 tests; sharp installed but re-encode/resize not yet wired (validation is decoder-free) |
| Extraction schema (strict) | Real | Zod schema shared by fixture and OpenAI extractors |
| Fixture extractor (rules) | Fixture-only | Handles budget basis, quantities, dates, negation, gifts, opt-outs, preferences |
| OpenAI extractor/drafter (Responses API, structured outputs, store:false) | Blocked | Coded; no API key; no eval run. Bounded eval report is therefore **not delivered** |
| AI budget reservation (per-request soft/hard, global daily, call cap; advisory lock) | Real | A34 unit + real-PG concurrency test |
| Event resolution (canonical events only; ambiguity → clarification; no invention) | Real | A02 test |
| Clarification (≤3 questions, no re-asking, country check) | Real | Pipeline tests |
| Deterministic comparison, ranking, savings, freshness | Real | A06–A10, A27 tests |
| Benchmark (cohort matching, one representative per event, type-7 quantiles, licensing) | Real (engine) / Fixture-only (data) | A48/A50/A51/A60/A62/A66 tests; live history requires licensed dataset import |
| Historical import tool with schema validation/quarantine/lineage | Partial | `market_datasets` quarantined-by-default model exists; a CLI importer is **not** written yet |
| Trend engine (4 obs / 6h gate, coverage/fee/basket invalidation, windows) | Real (engine) | A14/A52/A53/A55/A59 tests |
| Decision policy (buy/wait/alternative/insufficient, checkpoints, consent-aware watch) | Real | A56/A57/A58/A61 tests |
| Claim packet + response validator (claim IDs only, prohibited phrases, scope, decision consistency) | Real | A63 tests |
| Evidence-only fallback when drafting fails | Real | `renderEvidenceOnly` |
| Recommendation review: approve by revision + draft hash, freshness re-check, revalidate | Real | Pipeline tests + console |
| Immutable send intents, claim, uncertain handling, 24h reconciliation rule, status ordering | Real (unit) | A17/A18/A19 tests |
| Send gate (mode, kill switches, suppression, approval hash, revision, freshness, fixture content, allowlist) | Real | A13/A38 tests |
| Resend outbound provider | Blocked | Coded with idempotency key; never invoked live |
| Watches: consent-gated creation, cadence, expiry, dedupe, daily cap, alert approval, cancellation race | Fixture-only | Unit tests; scheduled evaluation via Inngest cron; only fixture sources can be monitored today |
| Interest evidence (polarity, gift, negation, decay) separate from marketing permission | Real | A28/A29 tests |
| Preferences page (signed token, GET never mutates, unchecked opt-in) + one-click POST unsubscribe | Real (unit) | A30 tests; route smoke-tested |
| Natural-language unsubscribe / stop-all; bounce/complaint global suppression | Real | Pipeline tests |
| Segments, campaigns, campaign recipients, paced marketing send | Blocked / Not built | Tables exist; no builder/UI/sender. Marketing send disabled and provider clearance absent |
| Verified deletion workflow (redact/delete, suppress, ledger for restore re-apply) | Real (admin route) | Customer-side CONFIRM flow issues a verification email; admin completes |
| Retention sweep (raw 30d, observations 90d, media expiry) | Real (cron function) | `runRetentionSweep`; not yet run against production data |
| Kill switches (all_outbound, recommendations, marketing, watches, escalation_model, adapter:*) | Real | Admin-only; evaluated at dispatch |
| Operations view (outbox lag, dead letters + replay, spend, media, uncertain sends, source failures) | Real | `/admin/operations` |
| Sentry error reporting | Not built | `SENTRY_DSN` accepted by config only |
| Inngest functions (outbox dispatcher per minute, watch eval per 5 min, retention nightly) | Real (code) / Blocked (cloud) | Served at `/api/inngest`; no Inngest account or keys |
| CI (typecheck, lint, unit, real PG18 tests, build, bundle secret scan) | Real (workflow) | `.github/workflows/ci.yml`; runs on push |
| Render deployment | Blocked | `render.yaml` present; no account/authorization to deploy |
| Domain, DNS, MX, SPF/DKIM/DMARC | Blocked | Owner action; runbook written |
| Privacy / terms | Draft placeholders | Marked for owner/legal review; not launch-ready |
