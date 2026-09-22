# API and data contracts

These contracts complement ENGINEERING_SPEC.md. Type examples describe application interfaces, not unverified third-party endpoints. Monetary values are integer USD cents; timestamps are UTC ISO 8601 strings. Event presentation uses the venue's IANA timezone. All identifiers are opaque internal IDs unless explicitly named as provider IDs.

## 1. Request interpretation

Extraction returns a strict validated object. Unknown fields are rejected; unknown facts are null, never invented.

```ts
type RequestExtraction = {
  intent: 'new_search' | 'clarification' | 'watch_request' | 'cancel_watch' |
          'marketing_opt_out' | 'delete_data' | 'other';
  eventName: string | null;
  performerOrTeam: string | null;
  city: string | null;
  state: string | null;
  dateExpression: string | null;
  resolvedLocalDate: string | null; // YYYY-MM-DD only after timezone resolved
  quantity: number | null;
  budgetCents: number | null;
  budgetBasis: 'per_ticket' | 'whole_party' | null;
  seatingPreference: string | null;
  togetherRequired: boolean | null;
  accessibilityNeeds: string | null;
  alternativesAllowed: boolean | null;
  submittedUrls: string[];
  evidence: Array<{field: string; messageId: string; quote: string}>;
  ambiguities: string[];
};
```

Resolve “tomorrow” against the message's received timestamp and confirmed event location timezone. Preserve the original phrase. A forwarded email's historical Date header must not reset the reference time. Never silently turn “under 300” into a per-ticket budget. Mandatory search fields are event identity/date, quantity and relevant hard constraints. Budget is optional for general comparison but required for target-price watches. Ask at most three clear questions in one email; do not ask again for information already established in the current request revision.

A request version is immutable. A correction increments revision and invalidates conflicting offers, recommendations, approvals and watch assumptions. Explicitly resolve multiple events or multiple requests within one conversation; an email thread is not necessarily one request.

## 2. Source adapters

```ts
type SourceStatus = 'success' | 'no_matching_inventory' | 'not_supported' |
  'not_integrated' | 'access_not_approved' | 'blocked' | 'rate_limited' |
  'timeout' | 'provider_error' | 'ambiguous_event';

type SearchInput = {
  requestId: string; revision: number; eventId: string;
  providerEventId: string | null; quantity: number;
  hardConstraints: Record<string, unknown>;
};

type Offer = {
  id: string; sourceId: string; providerListingId: string | null;
  eventId: string; observedAt: string; providerUpdatedAt: string | null;
  expiresAt: string | null;
  quantity: number; currency: 'USD';
  baseTotalCents: number | null;
  mandatoryFeeTotalCents: number | null;
  taxTotalCents: number | null;
  deliveryTotalCents: number | null;
  payableTotalCents: number | null;
  priceCompleteness: 'verified_total' | 'estimated_total' | 'incomplete';
  section: string | null; row: string | null; seatNumbers: string[] | null;
  seatsTogether: boolean | null;
  admissionType: 'reserved' | 'general_admission' | 'standing' | 'other';
  restrictions: string[]; deliveryMethod: string | null;
  expectedDeliveryAt: string | null;
  directPurchaseUrl: string;
  evidenceId: string;
  collectionMode: 'approved_api' | 'approved_manual' | 'fixture';
};

type SourceResult = {
  sourceId: string; status: SourceStatus; checkedAt: string;
  offers: Offer[]; reasonCode: string | null;
  retryAfterSeconds: number | null; coverageNotes: string[];
};

interface TicketSourceAdapter {
  resolveEvent(eventId: string): Promise<{providerEventId: string | null}>;
  search(input: SearchInput): Promise<SourceResult>;
  revalidate(offerId: string): Promise<SourceResult>;
}
```

Each adapter has configured source IDs, access approval evidence, capability flags, permitted markets, rate and daily-call limits, cache TTL, licensed retention, fee semantics, allowed link hosts and enabled status. Validate responses at the boundary. Never merge sources by display name. Map aliases through the research registry. An infrastructure or discovery entry is not a seller.

A manual research entry requires staff identity, source URL, event match, observation time, fee completeness, supporting evidence and restriction fields. No label suggesting API verification. Fixtures cannot pass the production send gate.

Routing: load the 29 category routes from the research master into versioned application configuration, referencing registry IDs. Validate every reference at startup. Every request first resolves the event's actual official seller from official event/team/venue evidence. Then attempt applicable enabled core sources and category-specific specialists. Extended sources are enabled by reviewed rules and budgets. Always record required-but-unavailable checks with their actual status. Source checks and cost budgets exist even when a source returns no offers.

## 3. Deterministic comparison

1. Require exact event identity, local date/time, venue and required ticket quantity. Exclude parking-only, wrong game/session, resale deposits and unrelated VIP packages.
2. Apply hard restrictions, contiguous-seat rules, delivery feasibility and accessibility requirements. Unknown required properties need review; they do not pass automatically.
3. Compare whole-party payable totals with mandatory charges known. No optimistic treatment of null charges as zero. Taxes or charges dependent on unprovided customer facts make the result estimated.
4. Group materially comparable seating/admission classes. Sort cheapest qualifying offers by verified whole-party total, then freshness and delivery certainty. Staff can select a better-seat alternative with a written reason. Preserve the computed cheapest result and any override in audit logs.
5. Savings against a submitted listing require a verified comparable baseline. Otherwise say “lowest among the offers we could verify,” with coverage and time. Better seats or another date are separately labeled alternatives.
6. Do not claim an exact cross-market duplicate without reliable identity evidence. Section/row similarity alone is insufficient. Shared broker supply does not imply independent inventory.

Trend observations belong to a stable comparison basket: event, quantity, admission/seat quality and mandatory-fee completeness. Record basket composition changes. Require at least four valid observations spanning six hours and the coverage/direction gates in ADVICE_ENGINE.md for a directional trend; otherwise describe limited observations without implying a reliable trend. Never imply observed asking prices are completed sale prices. Price direction does not guarantee the next price movement. A budget-threshold alert is deterministic and does not need an LLM prediction.

## 4. Application routes

| Method/path | Authority and contract |
|---|---|
| POST /api/webhooks/resend | Provider-signature verification on raw bytes, timestamp tolerance using supported verifier; insert unique provider event plus transactional outbox before 2xx. No browser auth. |
| GET/POST/PUT /api/inngest | Supported Inngest handler and signature verification; expose only SDK-required methods. |
| POST /api/internal/recover-outbox | Server-only authenticated scheduler. Lease due rows, bounded batch, safe repeat. |
| GET /api/admin/requests | Staff session + server authorization; cursor pagination and filtered summaries. |
| POST /api/admin/requests/:id/research | Staff session, CSRF protection, expected revision and request idempotency key. Enqueue once. |
| POST /api/admin/requests/:id/manual-offers | Reviewer role, validated evidence and source permission. Never an arbitrary URL fetch proxy. |
| POST /api/admin/recommendations/:id/approve | Reviewer role; expected revision, immutable content hash and offer evidence IDs. Reject stale or changed content. |
| POST /api/admin/watches/:id/pause | Authorized staff, audit reason, increment watch version. |
| POST /api/admin/campaigns/:id/approve | Marketing approver role, immutable content and segment snapshot hash. Recheck permissions at send time. |
| GET /preferences/:token | Limited signed/hashed expiring capability; masked address and settings only. No mutation. |
| POST /api/preferences | Valid scoped token + explicit choices + CSRF protection; update preferences and record consent evidence. |
| POST /api/unsubscribe/one-click/:token | RFC 8058 scoped capability, idempotent suppression, no login and no unrelated data access. |
| POST /api/admin/contacts/:id/delete | Authorized staff, verified identity workflow, audit and queued deletion; no raw arbitrary email lookup endpoint. |

Admin APIs return 401 unauthenticated, 403 unauthorized, 409 revision/idempotency conflict, 422 validation failure, 429 explicit limits. Public endpoints never reveal whether a particular email is a customer. Use correlation IDs rather than raw email addresses in diagnostics. Mutation bodies are size-limited. GET links must never opt users into marketing, delete data or cancel service because email scanners follow links.

## 5. Workflow events and send safety

Internal event envelopes contain `{eventId, entityId, revision, occurredAt, correlationId}` only, plus necessary nonpersonal routing identifiers. Use transactional outbox dispatch, with consumer idempotency stored in Postgres. Inngest steps receive references and return small summaries; large email/attachment bodies are not persisted in workflow checkpoints.

Events: `email.received`, `request.interpret`, `research.requested`, `recommendation.review_ready`, `email.send_requested`, `watch.due`, `watch.evaluate`, `contact.delete_requested`, `retention.due`. Version event schemas.

Source transient errors: bounded retry with jitter and provider Retry-After. Permanent access/validation errors: no retry loop; record and route to staff. Email fetch retries are distinct from email send retries. A poison webhook is quarantined and visible. Recovery must not re-run all model calls or repeat a customer email.

Outbound preparation stores an immutable send intent: recipient, sender, subject, text/HTML, headers, purpose, request/watch revision, approval ID, content hash and unique logical send key. Provider retry reuses the same payload and key. Resend's 24-hour idempotency window is not permanent; uncertain outcomes beyond that window require reconciliation/manual review, not automatic re-send.

Immediately before submission, recheck send switches, environment recipient allowlist, suppression, consent appropriate to purpose, current request/watch revision, fresh offer evidence and approval hash. Acquire an atomic claim. Provider call occurs outside a long database transaction. Record provider message ID and reconcile webhook deliveries idempotently. A send accepted before a cancellation cannot be recalled; reflect this race honestly.

Do not infer delivery from API acceptance. Statuses distinguish queued, claimed, provider_accepted, delivered, delayed, bounced, complained, suppressed and uncertain. A delivery webhook arriving before the API response is supported by upserts keyed to provider ID and send intent metadata.

## 6. Email content contract

All templates have text and HTML versions, accessible formatting and escaped user/source text.

- Acknowledgment: understood request, missing details or review expectations, no invented availability.
- Clarification: known details plus at most three necessary questions; reply in the same thread.
- Recommendation: exact event/date/venue, quantity, best verified suitable offer, whole-party total, per-ticket breakdown, comparison baseline if valid, two optional alternatives, restrictions/delivery, observation time, coverage gaps and direct seller links. Affiliate disclosure next to relevant links. No “best on the internet.”
- No result: what was checked and why suitable inventory could not be verified; distinction between no matches and unavailable sources.
- Watch confirmation: target whole-party total, quantity/constraints, end time and how to stop.
- Watch alert: newly qualified verified offer, observation time, price and direct link, price-change caveat, watch controls.
- Marketing: only opted-in recipients; relevance explanation, clear unsubscribe/preferences, sender identity and postal address. No fake scarcity.

Service requests are permission to respond to that request, not general promotional permission. Do not mix unsolicited upsells into service emails. Promotional sends use the correct provider product/plan and a separate sending identity. Bounce/complaint suppression is stronger than marketing preference alone.

## 7. Interest segmentation

Store positive, negative and uncertain observations separately. Tag provenance includes request/message, entity, taxonomy version, observation timestamp and confidence. A gift request is not necessarily the sender's own interest. Do not derive sensitive traits. Accessibility needs remain restricted request data and are not marketing segment tags.

Segments use a validated allowlisted filter tree, never arbitrary SQL supplied by a model. Example: active marketing permission AND positive performer tag for a specific entity AND opted-in geography within configured radius AND campaign frequency cap not exceeded. Evaluate exclusions and suppressions again at send time, regardless of a previously generated recipient snapshot. A permission record includes exact disclosure version, affirmative action, timestamp, channel, source and revocation state.

## 8. Migration and security invariants

Use foreign keys, explicit enum/check constraints and partial unique indexes where appropriate. Unique inbound provider event ID; unique logical send key; unique source/provider-event mapping; unique watch-version/offer-condition alert key. Enforce one live claim through leases or compare-and-swap. Money cannot be negative, quantity must be positive, expiry must follow creation. Enforce revisions in SQL rather than only in UI code.

Deny anonymous access to customer tables and storage. Browser admin sessions use staff authorization and MFA. Database credentials and auth secrets never appear in browser bundles. Staff/customer ownership and campaign roles are tested server-side. Sensitive bodies do not enter analytics, error telemetry or URLs. Store bounded pilot attachment bytes in private database media records, served through an authorized staff download endpoint; validate content types and decode sizes. A future object-store adapter may use short-lived signed links after authorization.

URL safety is enforced before requests and on every redirect: allowlisted HTTPS seller hosts, public IP destinations, no private/link-local/metadata addresses, credentials, unsupported ports or uncontrolled redirects. Prefer provider APIs; never allow an LLM to open unrestricted network destinations. Third-party pages and customer attachments are untrusted data, including instructions embedded in them.

## 9. Database driver parity

Use one `pg-core` schema and `/drizzle` migration history with postgres.js in production and PGlite for local defaults. Repository/service interfaces must not leak driver-specific transaction types into business code. Test transaction rollback, JSON fields, timestamps, binary media, unique constraints and auth schema on both drivers. Multi-connection races and locking require real PostgreSQL 18 CI. Missing production DATABASE_URL is a configuration failure, never a fallback. Media table fields and runtime/migration role separation are specified in ENGINEERING_SPEC.md.

## 10. Advice evidence contract

Application-owned immutable advice packet fields: requestId/revision; verifiedOfferIds; basketId/version; benchmarkRunId or null; trendRunId or null; historicalAdequacy; trendAdequacy; customerPriorities; policyVersion; decision; reasonCodes; claimRecords; evidenceExpiry; nextCheckpoint or null; stopConditions; watchConsentReference or null. Each claimRecord includes ID, kind, server-rendered value/text, quantity/seat/fee/time scope, source evidence IDs, method version, limitations and allowed wording. Missing data stays null and records an abstention reason.

The model returns structured blocks containing allowed claim IDs, decision label and bounded connective prose. The server renders facts and seller links from the packet. It rejects unrecognized claims, conflicting decisions, fabricated amounts or scope changes. Approval binds packet hash and all evidence revisions. Changes to data licensing, cohort mapping or source corrections invalidate affected unsubmitted drafts. See ADVICE_ENGINE.md for benchmark formulas, observation gates, group constraints and timing policy.
