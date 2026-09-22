# Implementation plan and acceptance checks

Work sequentially through milestones. Missing production credentials must not prevent fixture-based development. These are required future implementation checks, not claims that the application or tests already exist.

## Milestone 1 — Foundation

Create Next.js TypeScript app, pnpm lockfile, formatting/type checks, environment validation, CI, a shared Drizzle pg-core schema and migrations, postgres.js/PGlite driver selection, Better Auth staff authentication/TOTP MFA, authorization, private database-backed media and audit logging. Import research registry as disabled candidates; create versioned category routing configuration. Add source activation controls with evidence of access rights. Implement synthetic fixtures clearly marked as fixtures.

Acceptance: clean setup from README, reproducible migrations, seeded staff access, denied anonymous access, no secret in browser bundle, all source references validate, all live sends disabled by default. Provide local commands for development, typecheck, tests and migrations in the actual generated repository.

## Milestone 2 — Email intake and recovery

Implement signed Resend metadata webhook, unique inbox receipt, transactional outbox, durable dispatch/recovery, private email/attachment fetch, message threading, auto-response suppression and outbound send intents. Add a local simulator of the application-normalized inbound contract; do not pretend simulated payloads verify real provider signatures.

Acceptance: duplicate/reordered events and worker crashes recover without duplicate logical replies. Looping auto-replies stop. Unrelated senders cannot inherit a thread's private context. The staging provider test separately proves real signature handling, receiving and delivery.

## Milestone 3 — Staffed concierge

Implement extraction schemas and OpenAI wrapper, usage budgets, request versions, clarification, event resolution, source checks, manual evidence entry, offer comparison, draft preview and approval. Add source coverage display and queue ages. Every recommendation shows evidence and freshness. Build landing page, privacy/terms placeholders clearly marked for review, and preference page.

Acceptance: synthetic end-to-end request produces accurate reviewed recommendation; missing event/inventory yields an honest no-result path. No live inventory dependency needed to demonstrate the flow. No public launch with placeholder legal/contact content.

## Milestone 4 — Approved data integration

Enable Ticketmaster Discovery only after applicable access/terms review. Implement one specifically approved inventory adapter using its actual SDK/API contract. Verify fees, quantities, restrictions, link semantics, timestamps, pagination, rate limits, data retention and error mapping. Retain manual fallback. Add other adapters only after explicit access approval and contract tests.

Acceptance: compare representative real offers against provider checkout-visible totals without buying or holding tickets. Document variation and unresolved tax/fee cases. Never relabel an estimated price as a verified total. Validate US event filtering and exact event mappings.

## Milestone 5 — Watches

Implement explicit watch consent and target, expiry, bounded shared source polling, deterministic evaluation, deduplicated alert intents, human approval, pause/cancel, revision invalidation and provider budgets. Scheduled jobs do not invoke models for unchanged data.

Acceptance: virtual-clock tests cover deadlines, timezones, simultaneous workers, price oscillation, repeated listings, cancellation and outages. Stale evidence cannot trigger a “price available now” claim. No future-price certainty implied.

## Milestone 6 — Interests and opt-in marketing

Implement provenance-based tags, confidence/decay, explicit preference management, consent version records, allowlisted segment builder, reviewed campaign preview, per-user frequency caps, proper provider campaign channel, unsubscribe and bounce/complaint suppression. Leave campaign sending off until account/use-case and copy are cleared.

Acceptance: request-only users cannot receive promotional sends. Unsubscribe works without login and takes effect before queued sends. Mailing list scale is supported through indexes, cursor paging and bounded batches; no need to build million-recipient operations for the pilot.

## Milestone 7 — Staging and live pilot gates

Run all automated checks plus real test-account inbound/reply/attachment/watch/unsubscribe flow. Exercise backup restoration and queue recovery. Verify domain authentication, staff MFA, budgets, retention tasks and kill switches. Document operating hours, fallback ownership and incident response. Enable a controlled pilot only after ENGINEERING_SPEC.md launch gates are satisfied. Report unresolved integrations honestly.

## Acceptance matrix

| ID | Scenario | Required result |
|---|---|---|
| A01 | Email says “two tickets, $300 total” | Whole-party budget 30000 cents; never 60000. |
| A02 | “Dua Lipa tomorrow in New York,” no matching official event | Clarify or report no verified match; never invent a show. |
| A03 | “Tomorrow” near midnight / daylight-saving change | Use confirmed venue timezone and received timestamp. |
| A04 | Forward includes old dates and quoted instructions | Quoted material cannot override current request or system rules. |
| A05 | Customer corrects quantity after a draft | Revision increments; old approval and incompatible watch evaluation invalidated. |
| A06 | Unknown contiguous seating for a required adjacent pair | Exclude or flag for review, never assert adjacency. |
| A07 | Cheaper listing is parking, different session or obstructed-view contrary to requirements | Excluded from equivalent comparison. |
| A08 | Price excludes unknown fees/taxes | Estimated/incomplete; never counted as verified savings or threshold success. |
| A09 | Affiliate offer pays more commission | Ranking unchanged when commission changes. |
| A10 | Shared broker listing appears on two sources | No unsupported claim of unique or independently available inventory. |
| A11 | Source API times out/blocks/rate-limits | Correct coverage status; never “sold out.” |
| A12 | Event discovery returns a broad price range | Not converted into an actionable purchasable offer. |
| A13 | Zero approved live sources | Staff queue/no verified result; fixture data cannot be emailed as real. |
| A14 | Two comparable observations / changed seat basket | Insufficient-history or changed-basket notice, no misleading trend. |
| A15 | Resend webhook bad signature or tampered bytes | Rejected before accepting work. |
| A16 | Duplicate webhook / database write then crash before dispatch | Recovery dispatches logical work once using dedupe, no lost receipt. |
| A17 | Duplicate send worker / timeout after provider accepts | Same immutable key and payload; reconcile uncertain send. |
| A18 | Uncertain send older than provider idempotency window | Manual reconciliation, no blind replay. |
| A19 | Delivery webhook arrives before send response | Consistent provider/send mapping without duplicate state. |
| A20 | Attacker guesses request ID or copies a reference header | No customer context disclosure; participant authorization applies. |
| A21 | Out-of-office, bounce, mailing-list loop | No repeated concierge auto-response. |
| A22 | Huge image, wrong MIME, decompression bomb, SVG | Bounded rejection/quarantine without unsafe decoding. |
| A23 | URL redirects to metadata/private address | Network request blocked at every hop. |
| A24 | Ticket page tells model to reveal secrets/send to attacker | Ignored as untrusted data; tools and output destination remain constrained. |
| A25 | Watch threshold met repeatedly or price oscillates | Stable dedupe and frequency limit; no repeated identical alerts. |
| A26 | Watch canceled while approval queued | No new submission after cancellation is observed; already accepted sends recorded honestly. |
| A27 | Offer ages beyond freshness window before approval/send | Revalidation or return to review, no stale availability claim. |
| A28 | User emails once with favorite artist | Interest evidence stored; marketing remains off. |
| A29 | Gift request / negative artist preference | No automatic positive self-interest tag. |
| A30 | Email security scanner visits preferences link | GET causes no subscription or destructive mutation. |
| A31 | Marketing unsubscribe after recipient snapshot created | Send-time suppression prevents promotion. |
| A32 | Complaint/hard bounce | Global delivery suppression according to policy; visible remediation. |
| A33 | Unauthorized staff role / anonymous API or storage request | Denied server-side even if UI controls are bypassed. |
| A34 | AI cost limit/concurrency race | Atomic budget reservation prevents further spend; route to staff. |
| A35 | Source daily allowance exhausted | Defer/mark coverage gap without retry storm. |
| A36 | Raw message retention deadline / verified deletion | Private bodies/objects removed, derived records handled per documented policy, minimal suppression retained where appropriate. |
| A37 | Backup restored after deletion | Deletion ledger reapplied; restored data not silently reactivated. |
| A38 | Kill switch changes while queue has work | Submission gate respects current switch, not cached scheduling state. |
| A39 | Non-US event or unclear customer geography | Out-of-scope or clarification path; never infer customer jurisdiction solely from event. |
| A40 | Receiving/send provider outage | Queue visible with age, bounded retries, recovery and operator alert; no false sent status. |

Use unit/property tests for cents arithmetic and eligibility; real PostgreSQL 18 integration tests for concurrency, authorization and outbox invariants (PGlite tests are additional fast checks); contract tests for each approved provider; browser tests for staff approval/preferences; a small redacted or synthetic model evaluation set for extraction and prompt injection. Keep live paid-provider tests separate and explicitly enabled. Most acceptance tests should use deterministic fixtures and a virtual clock.

## Operator runbook required in implementation

Document how to: verify DNS without overwriting existing mail; configure and test webhook secrets; inspect a stuck conversation; reconcile an uncertain email; replay an event safely; disable a source; stop sends; adjust staffing/caps; approve a reviewed campaign; process deletion; restore backups and reapply deletions; rotate secrets; investigate a complaint without exposing customer bodies in logs. Include escalation owner fields to be completed before launch.

## Stack-specific acceptance additions

- A41: No DATABASE_URL locally selects isolated PGlite and applies committed migrations; missing DATABASE_URL in staging/production refuses startup.
- A42: The same reviewed migration history applies to PGlite and PostgreSQL 18, including auth and binary-media tables.
- A43: Concurrent outbox claims run against real PostgreSQL; single-connection PGlite results alone cannot satisfy the check.
- A44: Redeployment preserves database media; media downloads require staff authorization and never expose another request by guessing an ID.
- A45: Media budget exhaustion surfaces an explicit pending attachment task without losing the inbound message. Expiry removes bytes; backup restoration follows deletion policy.
- A46: Staff signup is closed, MFA is enforced on protected routes, and runtime database credentials cannot execute schema migrations.
- A47: Render deployment uses a dedicated Ticket Guy database, a single migration step and bounded connection pools; no other project data is accessed.

## Milestone 3B — Required advice engine

Before completing the concierge milestone, implement ADVICE_ENGINE.md: typed evidence/claim packets, benchmark and trend services, group-aware policy, safe response renderer, staff evidence inspection and synthetic evaluation. Build historical import and snapshot paths even if vendor access is pending. Following Milestone 4 access approval, validate real cohorts and licensed retention before enabling historical claims. Extend Milestone 5 watches with bounded checkpoints and reversal triggers. Numerical forecasting remains a later separately evaluated capability.

### Advice acceptance additions

- A48: Rangers preseason request cannot use regular-season/playoff examples as an undisclosed benchmark.
- A49: Five together is not priced as five times the cheapest single; split/adjacency rules are verified.
- A50: 1,000 observations from one past event count as one independent comparator, not a large historical sample.
- A51: Missing exact group/section data produces a disclosed approved fallback or abstention.
- A52: Singles fall while five-seat options rise; the customer receives the group-specific trend and appropriately different advice.
- A53: Source outage or changed fees/seat quality cannot produce an apparent market price movement.
- A54: A listing disappears; no sale, demand surge or arena-wide scarcity is inferred.
- A55: Four consistent observations across six hours pass initial gates; a two-hour history cannot manufacture a 24-hour change.
- A56: Risk-averse must-attend customer and risk-tolerant flexible customer can receive different recommendations from identical prices, with explicit reasons.
- A57: Wait recommendation has safe deadline, next checkpoint, stop conditions and accurate watch-consent state; no automatic enrollment.
- A58: Cold-start event gets current comparison plus honest missing-history statement, never fabricated normal range.
- A59: New seller lowers the floor; describe cheaper observed options without claiming existing sellers reduced prices.
- A60: Benchmark P25/P75 and median match known fixture calculations, with one matched-lead-time representative per event and target event excluded.
- A61: Changing affiliate commission cannot change buy/wait advice, confidence or urgency.
- A62: Licensed history expires or a venue mapping is corrected; affected claims/drafts are invalidated and retained derivatives follow their own license rules.
- A63: Model invents a number, changes cohort scope or says “guaranteed”; block draft even when other claim IDs are valid.
- A64: Backtest excludes future observations and holds out full events; future minimum asking price is never reported as proven savings.
- A65: Synthetic Rangers example values cannot enter production benchmark data or be sent as actual offers.
- A66: Historical raw-data retention and derived-data permission disagree; apply the actual rights independently and block unauthorized claims.
