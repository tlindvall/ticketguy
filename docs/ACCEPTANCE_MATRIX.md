# Acceptance matrix — A01–A66

Status: **pass** (automated test in this repo), **pass-manual** (verified by hand locally, described), **partial** (engine/logic proven, dependency missing), **gated** (cannot be exercised without an external input), **not built**.

Test files: `tests/acceptance/comparison.test.ts` (C), `advice.test.ts` (A), `security-intake.test.ts` (S), `sources.test.ts` (R), `pipeline.test.ts` (P), `extraction.test.ts` (X), `tests/pg/outbox-concurrency.test.ts` (PG), `src/lib/config/env.test.ts` (E).

| ID | Status | Where |
|---|---|---|
| A01 | pass | C, X, P (whole-party 30000; bare "$300" → clarification) |
| A02 | pass | P (Dua Lipa: no verified event → clarification, no draft) |
| A03 | pass | C (venue tz + received time; near-midnight flagged ambiguous) |
| A04 | pass | S, X (quoted/forwarded content stripped; cannot override request) |
| A05 | pass | P (revision increments; prior draft invalidated; stale approval 409) |
| A06 | pass | C (adjacency unknown → review, never asserted) |
| A07 | pass | C, P (parking/other session/obstructed excluded) |
| A08 | pass | C (null charges never zero; no verified savings) |
| A09 | pass | C (ranking invariant to commission) |
| A10 | pass | C, P (duplicate hint suppresses unique-count claim) |
| A11 | pass | R (timeout/blocked/rate_limited keep status; "not sold out") |
| A12 | pass | R (Discovery yields no offers; price ranges dropped) |
| A13 | pass | P (fixture content blocked at gate even after approval) |
| A14 | pass | A (2 observations / changed basket → insufficient) |
| A15 | pass | S (tampered bytes, wrong secret, missing headers, old timestamp rejected) |
| A16 | pass | P, PG (dedupe key; exactly-once lease across 8 concurrent claims) |
| A17 | pass | P, PG (same key/payload on retry; single claim winner) |
| A18 | pass | P (uncertain >24h → manual reconciliation) |
| A19 | pass | P (delivery before response mapped; bounce not erased by later delivered) |
| A20 | pass | S, P (stranger with copied Message-ID gets a fresh conversation) |
| A21 | pass | S, P (OOO/DSN/list mail stored, never answered) |
| A22 | pass | S (SVG/HTML/PDF, MIME mismatch, oversize bytes, pixel bomb rejected without decoding) |
| A23 | pass | S (syntax, DNS and every redirect hop validated; metadata/private blocked) |
| A24 | pass | X (injected instructions/URLs never reach request or output; renderer rejects URLs) |
| A25 | pass | S (band dedupe, re-alert threshold, daily cap) |
| A26 | partial | Logic in `cancelWatch`/`approveWatchAlert` (queued blocked, accepted recorded); no automated race test yet |
| A27 | pass | C, P (5/15-minute windows; stale feed; approval blocked until revalidated) |
| A28 | pass | S, P (interest evidence stored; no marketing permission) |
| A29 | pass | S, X (gift → uncertain; negation → negative) |
| A30 | pass | S + route (GET never mutates; signed purpose token; POST unsubscribes) |
| A31 | pass | P (send-time gate honors suppression added after queueing) |
| A32 | pass | P (complaint/hard bounce → global suppression; dispatcher suppressed) |
| A33 | pass-manual | Anonymous `/admin/*` 307, `/api/admin/*` 401, foreign origin 403, media 401 (smoke-tested) |
| A34 | pass | P, PG (hard cap, call cap, concurrent reservations) |
| A35 | partial | Adapter status `budget_exhausted` carried without retry storm; per-adapter daily counters not yet enforced in code |
| A36 | pass-manual | Deletion route: redact/delete/suppress/ledger; verification email path in pipeline |
| A37 | partial | Deletion ledger + runbook §10 procedure; no automated restore drill |
| A38 | pass | P (kill switch flipped while queued → blocked at dispatch) |
| A39 | pass | P (non-US event and non-US statement → unsupported; US event never confirms residence) |
| A40 | partial | Outbox lag/dead letters/uncertain visible in operations; provider outage → `uncertain`, bounded retries; external alerting (Sentry) not wired |
| A41 | pass | E (missing DATABASE_URL in staging/production refuses startup; local → PGlite) |
| A42 | pass | PG (same history applied on PostgreSQL incl. auth + bytea media tables) |
| A43 | pass | PG (real-PostgreSQL concurrent lease exclusivity) |
| A44 | pass-manual + P | Media download requires staff session (401 anon); unknown id 404; list queries never select bytes |
| A45 | pass | P (budget exhaustion explicit; `pending_budget` attachment state preserves the message) |
| A46 | partial | Signup disabled; MFA enforced by `requireStaff` (dev relax flag only outside production); runtime role cannot migrate (PG) — Render roles not provisioned |
| A47 | gated | `render.yaml` dedicated DB + single migration step + pool cap; no deployment yet |
| A48 | pass | A (preseason cohort excludes regular season/playoffs with reasons) |
| A49 | pass | A, C (singles never priced ×5; adjacency verified) |
| A50 | pass | A (1,000 snapshots of one event → one comparator) |
| A51 | pass | A (sparse group/section data → abstention/disclosed fallback) |
| A52 | pass | A (singles down, five-seat up → group-specific direction) |
| A53 | pass | A (outage/fee/coverage changes invalidate observations) |
| A54 | pass | C (duplicate uncertainty suppresses counts; disappearance never inferred as sale) |
| A55 | pass | A (4 obs/6h passes; 2h history yields no 24h figure) |
| A56 | pass | A, P (different customers, identical prices → different decisions with reasons) |
| A57 | pass | A (deadline, checkpoint, stop conditions; no watch without consent/coverage) |
| A58 | pass | A, P (cold start → current comparison + honest missing-history claim) |
| A59 | pass | A (new seller lowered floor flagged; no "sellers cut prices") |
| A60 | pass | A (type-7 quantiles, one representative per event, target excluded) |
| A61 | pass | A, C (no affiliate input to policy or ranking) |
| A62 | pass | A (expired/revoked datasets excluded); draft invalidation on mapping correction is manual via re-run |
| A63 | pass | A (invented numbers, prohibited phrases, unknown claims, scope, decision conflicts blocked) |
| A64 | partial | Benchmark selects snapshots by lead time only (no future leakage by construction); a time-ordered backtest harness is not built |
| A65 | pass | A, P (fixture history inadmissible outside fixture runs; fixture offers unsendable) |
| A66 | pass | A (raw retention and derived/customer-display rights applied independently) |
