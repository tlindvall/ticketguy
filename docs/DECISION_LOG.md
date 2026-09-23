# Decision log

Dated 2026-09-22 unless noted. Categories: **implemented**, **fixture-only**, **manual**, **approved-live** (none yet), **deviation**.

1. **Handoff persisted into the repo (implemented).** The handoff arrived as pasted text; `docs/handoff/*.md`, `research/*`, and `.env.example` reproduce it. The research master's per-source tables were replaced by a pointer to the canonical JSON registry (identical data; avoids two divergent copies). The JSON is generated from `scripts/registry-source.tsv` by `pnpm registry:build`; CI fails if the committed JSON drifts.
2. **Webhook verification implemented in-house (deviation, low risk).** Resend webhooks are Svix-signed; `verifySvixSignature` implements the documented HMAC-SHA256 over `id.timestamp.body` with a 5-minute tolerance and constant-time compare, tested on tampered bytes/wrong secret/old timestamp. Swap to the SDK verifier once a staging account exists if it exposes one; the contract is the same.
3. **Provider payload field names are assumptions (blocked).** `fetchReceivedEmail`/`normalizeReceived` follow the receiving docs as of the research date. They must be validated against a live staging payload before the intake path is trusted.
4. **Country confirmation is asked, never inferred (implemented).** If a clarification goes out, the US question rides along (within the 3-question cap). For complete first requests the acknowledgment carries a one-line US check. Research proceeds; the recommendation review note flags "customer country unconfirmed" so staff decide. Explicit non-US statements → `unsupported`.
5. **Ticketmaster Discovery drops price ranges (implemented).** The adapter returns events/URLs/dates only and reports `not_supported` for quotes; A12 is enforced at the adapter boundary.
6. **Benchmark per-person display rounds to whole dollars (implemented).** Whole-party cents stay the source of truth; only the rendered per-person P25/P75/median are rounded to the dollar.
7. **Trend "new seller lowered the floor" is inferred from the cheapest-source marker in snapshots (implemented).** Fixture snapshots carry `cheapest_source:<id>` in `qualityFlags`; live snapshot writers must set it the same way.
8. **Manual evidence joins the comparison for 6 hours (implemented).** Staff observations for the same event/quantity within 6h of a research run are included; freshness at approval/send still applies (5/15-minute windows), so a stale manual observation blocks approval until revalidated.
9. **Watch creation only from an explicit watch intent with a stated budget (implemented).** No budget basis → no watch; the clarification path asks. Watches attach to fixture sources only today; `monitoringAllowed` on a real adapter requires recorded polling rights.
10. **Marketing campaigns not built (blocked).** Tables and permission/suppression logic exist; there is no segment builder, campaign UI or sender. Provider use-case clearance is a prerequisite anyway.
11. **Historical import CLI not built (partial).** Datasets are quarantined by default and the benchmark refuses unapproved/expired/fixture data; an importer with lineage is the next piece when a vendor sample exists.
12. **Sharp installed but not wired (partial).** Decoder-free header inspection enforces A22 limits; re-encode/strip-metadata/resize via sharp before any model call is a follow-up.
13. **Sentry not wired (not built).** `SENTRY_DSN` is accepted; alerting destinations require the owner's account.
14. **ESLint pinned to 9.x (deviation).** ESLint 10 is incompatible with `eslint-plugin-react` as pulled by `eslint-config-next@16.3.5`.
15. **TypeScript 5.9 rather than 7.x (deviation).** TypeScript 7 is the Go-based compiler preview line; 5.9 is the stable toolchain Next.js/Drizzle are built against.
16. **PGlite singletons via `globalThis` (implemented).** Next dev instantiates module graphs per route; PGlite refuses a second open of the same data dir. A stale `postmaster.pid` from an unclean kill is removed on open (dev only, single-process assumption documented).
17. **Raw SQL timestamps as ISO strings with casts (implemented).** postgres.js and PGlite serialize untyped `Date` parameters differently; `leaseDueOutbox` and `recordProviderAccepted` pass ISO strings with `::timestamptz`.
18. **No OpenAI eval report (blocked).** The handoff asks for a bounded eval; without an API key none was run. The fixture suite covers extraction/injection rules deterministically instead.
19. **Real-Postgres tests ran on PostgreSQL 16 locally; CI uses 18 (implemented).** Only PG16 server binaries exist in this environment; the workflow's service container is `postgres:18`, matching the target.
20. **Local demo staff account (implemented, not committed).** `scripts/create-staff.ts` requires `STAFF_INITIAL_PASSWORD` and honors `STAFF_EMAIL_ALLOWLIST`; no credentials are in the repo.
21. **`APP_URL` resolves from `RENDER_EXTERNAL_URL`, and must be https in staging/production (implemented).** The first `render.yaml` omitted `APP_URL`, so a deployed instance would have kept the `http://localhost:3000` default — silently breaking Better Auth trusted origins, the admin CSRF origin check (every staff mutation 403) and every signed preference/unsubscribe link in outbound mail. Resolution order is now `APP_URL` → `RENDER_EXTERNAL_URL` → localhost, and a production-like environment refuses to start on a non-https value.
22. **`EXTRACTION_PROVIDER` makes the rules extractor a deliberate choice (implemented).** `APP_MODE=live` without `OPENAI_API_KEY` previously fell back to the regex `FixtureExtractor` with no signal. A production-like environment with `EXTRACTION_PROVIDER=openai` (the default) now refuses to start without a key; `EXTRACTION_PROVIDER=rules` runs the deterministic path deliberately and logs it at startup. Nothing customer-facing could have escaped review either way, but a silent model-to-regex swap is exactly the substitution the spec forbids.
23. **`MEDIA_MAX_TOTAL_BYTES` pinned to 256 MiB in the blueprint (implemented).** The 1 GiB default is larger than the storage of the smallest Render PostgreSQL plans, and database-backed media would have competed with business data. Raise it with the plan.
24. **Anthropic Messages API replaces the OpenAI Responses API (deviation from the handoff, owner-directed).** The handoff specified OpenAI with `gpt-5.4-mini` plus a gated `gpt-5.4` escalation. The owner directed a switch to Anthropic. Implementation notes:
    - **`claude-opus-5` for both extraction and drafting.** Extraction errors are the least-caught failure in the system — a reviewer sees the extracted brief, not a diff against the original email, so a misread budget basis or quantity can pass review. At pilot volume the model bill is a few percent of the human-review cost the spec's own model predicts, so the accuracy is cheap. Drafting could run on `claude-sonnet-5` (~60% cheaper) once measured; it is deliberately not split yet, because one model means one cache namespace, one price row and one thing to evaluate.
    - **Escalation is effort, not a second model.** `ANTHROPIC_BASE_EFFORT=low` / `ANTHROPIC_ESCALATION_EFFORT=high` replace the base/escalation model pair. Both tasks are well-specified rather than hard reasoning, and a cheaper-model cascade would forfeit cache reuse across models.
    - **Output ceilings raised** (extraction 2,000 → 8,000; drafting 1,200 → 4,000 tokens). Thinking tokens count against `max_tokens`; the handoff's caps were sized for a non-thinking model and would have truncated mid-object. Truncation is a typed `incomplete` failure, not a salvage attempt.
    - **Server-side refusal fallbacks enabled** (`fallbacks: 'default'`). If a safety classifier declines a request the API re-runs it on a fallback model in the same call; our own refusal path (route the request to staff) remains the last resort.
    - **Price table replaced** and longest-prefix matched, so a future `claude-opus-5-5` cannot silently bill at the `claude-opus-5` rate; unknown models price conservatively at $15/$75 per MTok.
    - **Privacy copy corrected.** The draft page claimed OpenAI storage was disabled via `store:false`. That parameter has no Anthropic equivalent; the page now says retention is governed by Anthropic's terms and our account configuration, and still requires legal review.

## 25. Service domain is `ticketguy.now`, and it lives in one place

The handoff specified `ticketguy.live` as the service domain. That domain was never registered (it does not
resolve); the owner purchased `ticketguy.now` instead.

The domain had been hard-coded in five places — two env defaults, the marketing subdomain, the root layout's
meta description, the how-it-works page, and the crawler user-agent — so a change like this could silently
half-apply. `src/lib/config/brand.ts` now holds `SERVICE_DOMAIN` and the values derived from it; the public
pages read `CONCIERGE_INBOUND_ADDRESS` from the environment so an operator override is honoured without a
deploy, and `tests/harness.ts` derives its fixture recipient from the same constant rather than repeating a
literal. Repeating the literal was what turned this into six failing tests: the pipeline ignores inbound mail
whose `To` is not `CONCIERGE_INBOUND_ADDRESS`, so a hard-coded fixture address becomes an unknown recipient
the moment the domain moves.

Deliverability note for the owner, not a code concern: `.now` has no established sending reputation and is
unusual enough that some filters weight it against a new sender. It matters little for inbound (customers
email us) and more for the marketing subdomain. Warm up `news.ticketguy.now` separately from the service
address, and keep DMARC at `p=none` until reports confirm every legitimate sender.

## 26. Many send addresses, one receivable set, enforced at startup

The owner needs to send from more than `my@`. Sending is the easy half: DKIM and SPF authorize a domain, not
a local part, so a verified sending domain can send from any address on it with no extra DNS.

Receiving is the constrained half, and it is where the product breaks. Root MX has exactly one owner, the
intake accepts only addresses it is configured for, and everything else is dropped as
`inbound.unknown_recipient_ignored`. A `From` nobody receives on therefore loses customer replies in silence
— Reply-To covers most clients, but not a customer who types the address or forwards the thread.

So: `CONCIERGE_INBOUND_ADDRESSES` extends the accepted set beyond the public address, and
`MESSAGE_CLASS_FROM_ADDRESSES` maps any of the eight message classes to its own `From`. `parseEnv` refuses to
start when a configured `From` is neither accepted inbound nor listed in `UNMONITORED_FROM_ADDRESSES`. The
escape hatch exists because a marketing subdomain legitimately is not receivable; requiring it to be named
turns a silent drop into a recorded decision.

Both settings default to empty, so behaviour is unchanged until an operator configures them. Loop detection
now treats every accepted and every sending address as our own, so a bounce from any of them is still caught.

Advice to the owner, unchanged from the discussion: prefer varying the display name over the local part, and
use a separate subdomain where separate sending reputation is actually wanted. Extra local parts on one
domain buy no deliverability — reputation is domain-and-IP level — and each one adds an address that must be
received on.

## 27. Two model providers behind one interface, and no guessed prices

The owner has OpenAI credits and no Anthropic account. Rather than migrate a second time, the model layer
is now provider-neutral: `src/lib/ai/model-client.ts` owns the prompts, the untrusted-input framing and the
schema validation, and each provider supplies only a `StructuredClient` that turns one request into typed
output or a typed `ModelOutputError`. `EXTRACTION_PROVIDER` (`anthropic` | `openai` | `rules`) decides;
the provider is never inferred from whichever key happens to be set, so a stale key cannot quietly take
over a run.

The OpenAI client was written against the installed SDK's own type definitions (`openai@7.23.0`), not from
memory: `responses.parse` with `text.format: zodTextFormat(...)`, `reasoning.effort`, and failure mapping
from the real response shape — a refusal is an output item rather than a status, so it is checked before
the incomplete and malformed paths, which would otherwise report a refusal as a schema failure and hide
the reason. `gpt-5.5` is the default because it is the model the shipped SDK's own documentation uses and
the newest general-purpose entry in its model enum.

**No OpenAI prices are hard-coded.** `platform.openai.com` and `openai.com` are blocked by this
environment's network policy, so published rates could not be verified, and a guessed rate would
under-reserve against the budget caps — worse than no rate, because the conservative default at least
fails safe by exhausting the cap early. `MODEL_PRICES_USD_PER_MTOKEN` lets the owner supply real rates
without a deploy; a malformed entry fails at startup rather than at spend time.

One bug this surfaced: the pipeline estimated cost against `ANTHROPIC_BASE_MODEL` at four call sites, which
would have priced every OpenAI call at Anthropic rates. Cost is now estimated against `env.modelName`, the
model the selected provider actually calls.
