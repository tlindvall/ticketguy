# Launch runbook: staffed price-check pilot

For the final launch spec (Oct 2 2026). These are the owner and operator steps the code can't do. Run them on a build that includes every launch PR, in the order below. Nothing here changes keys, provider rights, email quotas or launch mode on its own: each of those is a deliberate owner action.

## 1. Isolated PostgreSQL checks (A19, the database part of A26)

PGlite runs the test suites, but it is a single process and can't show concurrent writers or leases. Use a disposable PostgreSQL database, never production or staging data:

```
createdb ticketguy_acceptance           # any name containing test, acceptance or scratch
PG_ACCEPTANCE_URL=postgres://…/ticketguy_acceptance pnpm tsx scripts/pg-acceptance.ts
dropdb ticketguy_acceptance
```

The script refuses to run if:
- the URL is missing
- the URL equals `DATABASE_URL` or `MIGRATION_DATABASE_URL`
- the database name doesn't say it is a test database
- the database already holds requests

It prints one JSON report and exits 1 on any failure. Its six checks:
- 0021's columns and the observation unique index exist after all migrations apply.
- Eight concurrent writes of one provider observation make one row.
- A later fetch of the same observation adds nothing.
- The same price at a new provider time adds a row.
- Six concurrent lease claims over 40 jobs hand out each job exactly once.

The developer ran it on a local PostgreSQL 16 (Oct 3): 6 of 6 passed. Record your own run's JSON with the release.

## 2. Production migration (A26)

- Back up the database before deploying.
- Deploy, then check that the migrator applied `0021_market_retrieved_at`. In the shell:

  ```
  select count(*) from drizzle.__drizzle_migrations
  ```

  The count must equal the number of entries in `drizzle/meta/_journal.json`.
- Confirm group rows are marked:

  ```
  select count(*) from market_snapshots where quantity >= 3 and provider_as_of is null
  ```

  This should match the group rows that existed before the deploy.

## 3. Capture-mode acceptance run (A01–A24)

With test mode capture on and the 100-email cap unchanged:

1. Run the finite acceptance suite in FINAL_FIX_SPEC.md. Use fresh future-event screenshots for live shopping cases.
2. For each case, read the authenticated test detail. Its `diagnostics` block shows:
   - per-link outcomes (`links`: parse status, event, listing matched/unmatched/skipped/unavailable with provider and fetch times)
   - destinations
   - per-turn model calls and fallbacks
   - SeatData reads and call count
   - the latest `market.trend_assessed` audit
3. After the first SeatData listings read in capture mode, check one `market_fetches` row's detail:
   - It should end in `provider as of <time>`.
   - If it says `unknown`, SeatData isn't sending `last_refresh_timestamp` on `event_id` reads. In that case group trends and market watches can never become actionable (safe, but useless), and that has to be raised with SeatData before watches are offered.
4. Reconcile every input against its reply and queued job (A26). There should be no pending interpret or research jobs, no dead-lettered rows without a staff disposition, and no uncertain sends.

### The open L03 request

The malformed-link request from the Oct 2 wave is in manual attention. With LAUNCH-05 deployed, a staff member:
- confirms no work is pending
- replies or closes it from the admin request page with a note

Don't delete it silently.

## 4. Watches (A21)

Market watches pass their freshness and lifecycle gates in tests:
- provider-time freshness, with undated, stale or future reads refused
- approval and send-time re-checks
- dedup, cancel and generation change

**Keep them off at launch** (`WATCH_SEND_ENABLED=false`, or no `alerts` use on the SeatData licence) until step 3 confirms provider times arrive on live reads. Turning them on is an owner decision. The reply already says nothing is being monitored whenever a watch can't run.

## 5. Staffed comparisons (A24): `approved_manual`

The pilot's fulfilment route for "can you beat it?". A named operator must complete one genuine request end to end before launch:

1. Open the request in admin. Check the alternative on the seller's own site: event, date, section/row, quantity sold together, all-in total for the party, delivery date, restrictions.
2. Record it on that request's page (manual offer form, `POST /api/admin/requests/<id>/manual-offers`), with:
   - the observed time
   - section and row
   - quantity
   - seats together or not
   - payable total, plus whether fees and tax are known
   - delivery method
   - restrictions
   - a short evidence note
3. Re-run research for the request within **6 hours** of the check. Manual offers older than that aren't used.
4. Review and approve the reply. It must carry the checked total and constraints, and its link must be the listing checked.
5. If nothing suitable exists, send the explicit no-fit answer instead. Don't promise a further check without queueing it.

Record the request id, operator, minutes spent and outcome as A24 evidence.

## 6. Real inbox checks (A25)

Only after steps 1–5 pass. Send **two** real emails, keeping the daily cap unchanged:

1. A real sender to the concierge address, with one screenshot attached.
2. A threaded follow-up in the same thread.

Verify all of the following:
- the inbound webhook is accepted
- the attachment is read (test detail `offers.listings`)
- the reply arrives in the real inbox, threaded under the original subject
- the follow-up's reply also lands in that thread

## 7. Operations before opening the pilot (A26)

- The deployed commit matches the release.
- Outbox recovery cadence is running.
- The kill switch has been tested on and back off.
- `EMAIL_TEST_RECIPIENT_ALLOWLIST` and `AUTO_APPROVE_WHILE_TESTING` are changed deliberately for real customers. Removing the allowlist changes approval behaviour.
- To answer anyone who emails: empty `EMAIL_TEST_RECIPIENT_ALLOWLIST` and set `AUTO_SEND_RECOMMENDATIONS=true`. Without the second, every recommendation waits in the review queue. Auto-sent emails say "AI-assisted", never "human-reviewed".
- Emptying the allowlist also ends the testing exemption for SeatData: resale prices appear in replies only if the licence in `/admin/sources` has `advice` and `customer_display`, and alerts only with `alerts`. Check before opening up, or replies lose their prices.
- A named operator covers manual attention within the posted hours.
- SeatData and AI budgets are set.
- Landing copy describes only what is available: a second opinion and a staffed check, not automated cheapest-ticket sourcing.
