# Operator runbook

Owner fields to complete before launch: **escalation owner** ______ · **backup owner** ______ · **staffed hours** ______ (default `STAFFED_HOURS_*` env) · **legal/privacy contact** ______ · **postal address** (`BUSINESS_POSTAL_ADDRESS`) ______.

Nothing in this runbook authorizes a live send. `EMAIL_SEND_ENABLED`, `MARKETING_SEND_ENABLED`, `WATCH_SEND_ENABLED` default to `false`; `APP_MODE=fixture` can never send.

## 1. Domain and DNS (do not overwrite existing mail)

1. Confirm registrar ownership of `ticketguy.now`. `dig MX ticketguy.now` and `dig TXT ticketguy.now` — record what exists. If the root already has MX serving a real mailbox, do **not** replace it; plan forwarding/coexistence first (e.g. receive on a subdomain and forward the public address, or migrate the mailbox).
2. In Resend, add the sending domain (`ticketguy.now`) and the marketing subdomain (`news.ticketguy.now`) and the receiving domain. Copy the exact DKIM/SPF/MX records Resend shows; never hand-type guessed values.
3. Publish DMARC at `p=none` with `rua=` pointing to a dedicated reporting mailbox. Tighten only after every legitimate sender is confirmed in reports.
4. Route `postmaster@`, `abuse@`, `privacy@`, `support@` to a staff mailbox (not to the concierge intake). The app ignores inbound mail whose `To` is not `CONCIERGE_INBOUND_ADDRESS` (recorded in `audit_log` as `inbound.unknown_recipient_ignored`).
5. Sending from more than one address needs no extra DNS: DKIM and SPF authorize the *domain*, so any local part on a verified domain can send. Receiving is the constrained side — root MX has exactly one owner. Every address you send from must therefore appear in `CONCIERGE_INBOUND_ADDRESSES` (or be the public `CONCIERGE_INBOUND_ADDRESS`), or be listed in `UNMONITORED_FROM_ADDRESSES` to record that replies to it are dropped on purpose. Startup fails otherwise, which is the point: an unreceivable From loses customer replies silently. Vary the display name before you vary the address, and use a separate subdomain (`news.`) where you want separate sending reputation.
6. Verify with a test send to Gmail, Outlook and Apple Mail: SPF/DKIM/DMARC pass, threading (`In-Reply-To`/`References`) intact, plain-text and HTML both readable.

## 2. Webhooks

- Endpoint: `POST /api/webhooks/resend`. Configure separate Resend webhooks (and secrets) for staging and production; subscribe only to `email.received`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`.
- Set `RESEND_WEBHOOK_SECRET` (starts `whsec_`). Without it the endpoint returns 503 and accepts nothing.
- Test: send a signed test event from the Resend dashboard; expect 200 `{ok:true,duplicate:false}` then 200 `{duplicate:true}` on redelivery. A tampered body → 401. Check `inbound_events` and `outbox_events` rows.
- Rotation: add the new secret to the environment, redeploy, then rotate in Resend. Events signed with the old secret after rotation fail closed (401) and Resend retries; watch `/admin/operations` for quarantined events.
- **Lost `email.received` events** (webhook down, secret rotated badly, or the subscription silently dropped the event type — it has happened): `pnpm tsx scripts/reconcile-resend.ts` in the Render shell lists what the provider received that never became an inbound event here; `--apply` queues each one through the normal retrieval path, exactly as a webhook would have, and the dispatcher ingests it within a minute. Idempotent: a message the webhook did deliver, or one reconciled earlier, is never queued twice. If the provider's list response is not a shape the parser recognises it stops and says so — run `scripts/probe-resend-receiving.ts` and match the parser to the real shape before trusting a zero. Check the webhook's event subscription in the Resend dashboard afterwards; reconciliation is the backstop, not the fix.

## 3. Background processing

- Inngest serves at `/api/inngest` (`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`). Functions: `dispatch-outbox` (every minute + kick on webhook), `evaluate-due-watches` (every 5 min), `retention-sweep` (03:17 UTC).
- Fallback if Inngest is unavailable: a Render cron (or any scheduler) can `POST /api/internal/recover-outbox` with `Authorization: Bearer $INTERNAL_CRON_SECRET` every minute. Safe to run concurrently; rows are leased with `FOR UPDATE SKIP LOCKED`.
- Health: `GET /api/health` (db round trip, mode, send flag). Monitor it externally; deployment success is not proof that mail or jobs work.

## 4. Inspect a stuck conversation

1. `/admin/inbox` → filter `manual_attention` / `needs_clarification`; open the request.
2. Read **State history** (each transition has actor + reason), **Source coverage** (per-source status; `not_integrated`, `timeout`, `blocked` are never "sold out"), **Outbound send intents** (state + gate reasons such as `app_mode_fixture`, `not_approved`, `evidence_stale`).
3. Common causes: `extraction_failed:BudgetExceededError` (raise `AI_REQUEST_HARD_BUDGET_USD` or handle manually), `clarification_limit_reached` (reply by hand), `event_unresolved` (add the event/venue rows — no canonical event, no offers).
4. Dead-lettered outbox rows appear in `/admin/operations`; **Replay (same key)** re-runs with the original idempotency key.

## 5. Reconcile an uncertain email

A send intent becomes `uncertain` when the provider call errored after possibly accepting. Within 24 h the next dispatcher run retries with the **same** idempotency key and byte-identical payload (Resend dedupes). After 24 h the dispatcher returns `manual_reconciliation`: look the `dedupe_key`/recipient/subject up in the Resend dashboard; if it was sent, set `provider_message_id` and state `provider_accepted` via SQL and note it in `audit_log`; if not, set state `queued` to allow one controlled retry. Never resend blindly.

## 6. Replay an event safely

- Inbound: `inbound_events.processing_state = 'pending'` + an outbox row `received:<svix-id>` will be picked up by the dispatcher. Duplicates are rejected by the unique `(provider, provider_event_id)` index.
- Outbox: only `dead` rows are replayable (`/admin/operations` or `POST /api/admin/outbox/:id/replay`). Attempts reset; the event key does not change, so downstream handlers remain idempotent (interpret keys on message id; research on request+revision; send on intent id).

## 7. Disable a source / stop sends / caps

- Source: `/admin/sources` → activation → `enabled=false` (admin). Running research records `not_integrated`/`access_not_approved` honestly rather than skipping the source silently.
- Stop all outbound: `/admin/operations` → kill switch `all_outbound` → **Stop** (admin). Takes effect at the next dispatch gate evaluation, even for already-queued work. Per-class switches: `recommendations`, `marketing`, `watches`, `escalation_model`.
- Environment-level stop: set `EMAIL_SEND_ENABLED=false` and redeploy; inbound intake continues.
- Caps: `AI_REQUEST_SOFT_BUDGET_USD` / `AI_REQUEST_HARD_BUDGET_USD` / `AI_GLOBAL_DAILY_BUDGET_USD` / `AI_MAX_CALLS_PER_REVISION`; `MEDIA_MAX_TOTAL_BYTES`; per-adapter `dailyCallLimit` in activation. Staffed hours: `STAFFED_HOURS_*`.

## 8. Approve a campaign

Not available: the campaign builder/sender is not implemented and `MARKETING_SEND_ENABLED` must stay `false` until Resend clears the use case in writing and the opt-in copy/notice version are reviewed. The send gate additionally requires a `granted` permission newer than any revocation, no `marketing`/`global` suppression, and the `marketing` kill switch allowing.

## 9. Process a deletion request

1. Customer emails "delete my data" → request goes to `manual_attention`, a `deletion_ledger` row is created and a verification email (`verification` class) is queued asking for a reply containing **CONFIRM**.
2. Staff confirms identity (the CONFIRM reply in the same thread, or an identity check) and runs `/admin/contacts/:id` → **Delete** (admin). This cancels watches, blocks queued sends, deletes media bytes, redacts message text/subjects/addresses and briefs, deletes interest rows, adds a `global` suppression keyed by the lowercase address, marks the contact `deleted`, and completes the ledger row.
3. Tell the customer what is retained (keyed suppression + ledger; provider/backups expire per schedule). Do not promise immediate erasure from Resend or database backups.

## 10. Restore a backup and re-apply deletions

1. Restore the Render PostgreSQL point-in-time backup to a **new** database; point a staging instance at it first.
2. Run `pnpm db:migrate` against it (idempotent).
3. Re-apply `deletion_ledger` rows completed after the backup point: for each `contact_id`, repeat the deletion steps (the admin endpoint is idempotent for already-deleted contacts) and ensure `suppressions` contain the `global` row. Restored data must never re-activate deleted contacts or paused/cancelled watches: run `update watches set state='cancelled' where contact_id in (select contact_id from deletion_ledger where completed_at is not null)`.
4. Verify media rows (`media_objects`) restored consistently with `attachments.media_id`; orphaned references are set to null by the retention sweep.
5. Only then switch `DATABASE_URL`. Record the restore in `audit_log` (actor = operator).

## 11. Rotate secrets

`BETTER_AUTH_SECRET` (invalidates staff sessions), `PREFERENCE_TOKEN_SIGNING_KEY` (invalidates outstanding preference/unsubscribe links; tokens carry `v` for future multi-key rotation), `INTERNAL_CRON_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (see §2), `ANTHROPIC_API_KEY`, Inngest keys. Rotate in the Render dashboard, redeploy, then revoke the old value at the provider. Never paste secrets into chat, tickets or commits.

## 12. Investigate a complaint without exposing bodies

Complaints/hard bounces arrive as provider events and immediately add a `global` suppression (`suppressions.reason = complaint|hard_bounce`). Investigate with `audit_log` (diffs are redacted of bodies/addresses), `send_intents` metadata (class, state, timestamps, provider id) and the request's state history — not message bodies. If a body must be read, do it in `/admin/requests/:id` (staff-authorized, no-store) and note the access in `audit_log`. Never copy bodies into logs, Sentry or tickets.

## 13. Retention

Defaults: raw text/attachments 30 days (`messages.purge_at`, `attachments.purge_at`, `media_objects.expires_at`); offer observations 90 days (`retention_until`) unless referenced by a pending/approved recommendation; consent/audit rows kept (policy target 24 months, to be enforced by an owner-approved policy). Licensed market data follows `market_datasets` retention fields; expired datasets are excluded from benchmarks automatically.

## 14. Incident checklist

1. Stop the blast radius: `all_outbound` switch → Stop.
2. Confirm intake still works (`/api/health`, new `inbound_events`).
3. Identify affected intents (`/admin/operations` → sends by state; `uncertain` list).
4. Fix, verify with the fixture suite and a staging send to the test allowlist (`EMAIL_TEST_RECIPIENT_ALLOWLIST`).
5. Resume switch; write the incident note in `audit_log` via a kill-switch reason.
