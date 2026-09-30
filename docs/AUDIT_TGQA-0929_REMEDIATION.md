# TGQA-0929 audit: remediation report

**For:** the agent that ran the Sep 29, 2026 live-email audit.
**Repo:** `tlindvall/ticketguy`
**Status on Sep 30, 2026, ~01:00 UTC:**
- PRs #51 and #52 are merged.
- PR #53 is open, pending CI, and not merged or deployed.
- Render does not deploy automatically (`autoDeploy: false`). Nothing is live until someone deploys it by hand.

## Files received
Received:
- `CLAUDE_START_HERE.md`
- `GAP_ANALYSIS_AND_BUGS.md`

Not received:
- `TEST_RESULTS.csv`, `test-cases.json`, `send-receipts.json`, `findings.json`
- The transcripts and `evidence/`

The regression tests below therefore rebuild each case from the gap analysis, not from the exact email text. To pin them to the real wording, send `test-cases.json`.

## Summary
The fixes stop the service endorsing seats it hasn't checked, calling a venue-wide floor "fair", ignoring the question actually asked, and claiming messages were sent that weren't.

They do **not** create verified, purchasable offers. That still needs a listing partner. Until then, the honest limit is "here is where the market is and what to check".

## Per ticket

### TG-B01 (P1): purchase recommendation bypasses hard requirements (A05, Hamilton)
**Status:** fixed in PR #53.

**Cause (confirmed in code):**
- The official-sale shortcut in `src/lib/intake/pipeline.ts` (the `official_sale` template in `src/lib/email/templates.ts`) always said "that's where I'd buy your N tickets".
- It never checked the budget, seats-together, access or seat-preference requirements.
- The same endorsement appeared in the `C_OFFICIAL` claim in `src/lib/advice/packet.ts`.

**Fix:**
- New helper `unverifiedRequirements()`. When the request has any of those needs, the email says:
  - "is on general sale on Ticketmaster. I haven't seen its seats or prices, so I can't tell you yet whether any fit what you need."
  - Then it lists each need as still to check: "3 seats together", "$450 in total for all 3, once fees are added", "Step-free access".
  - The link is labelled "Event page on Ticketmaster", not "Buy tickets".
- For any quantity other than 2, the email adds that the seller's page may start at 2 tickets. The audit found the /go link opened at quantity 2.
- `C_OFFICIAL` gets the same gate.

**Tests:**
- `tests/acceptance/official-sale.test.ts`: "an open sale never stands in for their seats, budget or access".
- `tests/unit/audit-0929.test.ts`: TG-B01 block.

**Not done:** carrying the quantity into the Ticketmaster URL. I didn't want to rely on a URL parameter I haven't verified, so the email tells the customer to set it instead.

### TG-B02 (P1): delivery-risk and comparison questions become price checks (A08, A03)
**Status:** fixed in PR #53.

**Cause:** the advice path never read the question itself. Every request went through the same market-price claims.

**Fix:**
- `questionsAsked()` in `pipeline.ts` reads the inbound text across the thread. It needs both a delivery word and a stakes word (travel, flight, leave, refund…), or a wheelchair/accessible-spaces phrase. A passing "mobile transfer is fine" doesn't trigger it.
- New claims in `packet.ts`, placed first in the email:
  - `C_DELIVERY`: if tickets may only arrive after you've set off, you could be travelling with nothing in hand. A seller's guarantee refunds the money but doesn't get you into the game, so pick a listing that delivers before you leave. No delivery or entry guarantee is made.
  - `C_ACCESS`: wheelchair spaces are for people who use a wheelchair and their companions, not a cheaper version of ordinary seats. If the customer said they need access, it tells them to check suitability with the seller or venue instead.
- The renderer (`src/lib/advice/renderer.ts`) now opens with the customer's own question, in this order: delivery, access, the verdict on their listing, watch status, the price they quoted.

**Tests:** `audit-0929.test.ts`: A08 (delivery opens the email; no guarantee wording), A03, and a no-false-positive case.

### TG-B03 (P1): advice ignores the all-in group budget (A01, A07), and TG-B04 (P1): broad floor becomes a fair-price verdict
**Status:** fixed in PR #53.

**Cause (your hypothesis, confirmed):**
- `marketRead()` in `packet.ts` computed `fairUpTo = floor × 1.15`, where floor is the cheapest venue-wide price before fees.
- It then wrote "up to about $X a ticket before fees is a fair price; much more… a better section, not a better deal".
- It never compared anything to the budget.

**Fix:**
- The "fair price" sentence and the ×1.15 are removed from `C_READ`.
- With a budget, the email compares the whole-party floor (before fees, with its age) to the whole-party budget:
  - Over budget, for A01: "Your budget is $600 for five ($120 a ticket). The cheapest listings with 5 or more tickets were $121.75 a ticket before fees (as of about 6 hours ago), $608.75 for five, so they were already over it before fees. Unless cheaper seats have been listed since, that budget won't cover it." It doesn't claim no cheaper seats exist.
  - Under budget, for A07: "$169.78 for two before fees, under your $180 budget. Fees come on top and those seats could be anywhere in the venue, so check the all-in total at checkout…"
- Without a budget, it says that figure is where the market starts, not what particular seats are worth.
- The group wording stays "listings with 5 or more tickets… may not split into exactly 5". It never treats ≥5 as exactly five seats together.

**Tests:** `audit-0929.test.ts` TG-B03/B04 block (A01, A07, no budget). The market-tracking acceptance test now asserts no "fair price" and no "better deal".

**Still open:** `priceAgainstFloor` and `C_QUOTE_MARKET` still use a floor × 1.15 (or × 1.30) band. It only describes whether the price the customer quoted is "close to the cheapest listing"; it doesn't call it fair. It's still a constant markup, so review it if you want it gone too.

### TG-B05 (P1): follow-ups lose or fail to update context (H01, H02, H03)
**Status:** partly fixed. Needs a retest after deploy.

**H01 (Metallica, Connecticut):** fixed in PR #51 (merged). There were two causes:
1. `mergeExtraction` merged city and state as separate fields, which produced city "NY" with state "CT". A new place now replaces the old place as a whole.
2. Discovery freshness (`recentlySynced` in `src/lib/catalog/sync.ts`) treated a search with no place as matching *any* recent search. The New York search had just come back empty, so the national fallback was skipped as fresh. Freshness is now keyed by keyword, place (city / geo point / `state:XX` / national) and date window.

A state on its own is now searched with `stateCode` and filters venues by state. Tests: `tests/acceptance/geography-discovery.test.ts`; both tests fail on the old code.

**H02 (Rangers, quantity change reopening the date) and H03 (Bushwick narrowing resetting the window and category):** not changed. The keep-settled-event logic (PR #45) and place merging (PR #51) both changed after those threads. Retest before changing code.

### TG-B06 (P1): rate-limited requests lack a verifiable handoff
**Status:** fixed in PR #53, with a related change already in PR #52.

**Cause (confirmed in code):**
- In `alertStaff()` in `pipeline.ts`, the staff alert text "The customer has been told a person is picking it up." was hard-coded.
- The rate-limit path never sent the customer anything.
- The limit is 10 inbound emails an hour and 30 a day per sender (`src/lib/intake/boundaries.ts`). It's counted before extraction, so cancellations were held too.

**Fix:**
- The first rate-limited email in 24 hours now gets one holding reply ("This one needs a person…"), with dedupe key `holding:<requestId>`.
- The staff alert reads that send's actual state and says one of:
  - told
  - on its way
  - not sent (with the state)
  - "has not been told anything yet"
- Cancel, stop and opt-out emails skip the limit, at most 3 times per sender per day (audit action `intake.limit_skipped_for_stop`), so "cancel" can't become a way around the limit.
- PR #52: addresses on `EMAIL_TEST_RECIPIENT_ALLOWLIST` are exempt from the limit, so QA isn't blocked. Everyone else keeps the flood guard.

**Tests:** `tests/acceptance/boundaries.test.ts`:
- one holding reply over the limit
- cancellation not held
- allowlisted tester not limited

**Not verified:** request `656490c2-29c5-4d0c-b1f9-f83f4dfd789c` itself. That's production data. It won't reprocess on its own, so resend it after deploy.

### TG-B07 (P2): discovery ignores exclusions and value filters (A04, H03)
**Status:** not started. Next in line.

### TG-B08 (P1): missing user-provided info is described as a seller fact (A03)
**Status:** fixed in PR #53.

**Cause:** `listingCatches()` in `packet.ts` wrote missing fields as facts about the listing. For example: "It doesn't show seat numbers, so you won't know exactly where you're sitting until after you buy."

**Fix:** the wording now depends on where the listing came from:
- Pasted text or a written summary: "You haven't included seat numbers. Check the listing if you want to know exactly where you'll sit."
- Screenshot: "The screenshot doesn't show…"
- The same applies to seats-together, fees and delivery date. "Until after you buy" is gone.

**Tests:** `audit-0929.test.ts` TG-B08, and `tests/acceptance/listing-evidence.test.ts` (screenshot wording).

### TG-B09 (P2): US-only shown as a search failure abroad (A09)
**Status:** fixed in PR #52 (merged).

**Fix:** a non-US place ("London, UK") is answered before any search: "We only cover events in the US for now, so I can't help with Hamilton in London, UK." A US state next to the city ("London, KY") or "New London" stays in scope.

**Test:** regression case `event.outside_us_unknown_show`.

### TG-B10 (P1): watch request gets no active/inactive status (A07)
**Status:** fixed in PR #53.

**Cause:** nothing reported the stored watch state. `cancel_watch` stopped all of the contact's watches and alerts, sent no confirmation, and then carried on into price advice.

**Fix:**
- `C_WATCH` opens a watch-request reply, built from stored state.
  - It says "running" only if an active watch row exists for the request **and** `WATCH_SEND_ENABLED` is on. Then it gives quantity, together, the all-in target, the expiry, and "reply stop".
  - Otherwise: "I can't watch prices for you yet, so nothing is being monitored for this request and no alert will come."
  - `WATCH_SEND_ENABLED` is currently off in `render.yaml`, so every watch request will get the "not monitored" answer. That is the truthful state.
- Cancellation:
  - It is scoped to the requests in the thread. Other requests and email preferences are untouched.
  - It is always answered from what was actually stopped: "Done: I've stopped the price watch on this request…" or "There was no active price watch or alert on this request, so nothing was being monitored…".
  - It is stored as a revision plus a `stop_watching` outcome (and `user_reported_purchase` if they say they bought).
  - It doesn't run price advice afterwards.

**Tests:** `audit-0929.test.ts` TG-B10 (running and not running), and regression `stop.watch`.

**Not verified:** whether the A07 watch exists in production. Check `/admin`, then Price watches. With `WATCH_SEND_ENABLED` off, it couldn't alert anyway.

### TG-B11 (P2): no-subject requests split across Gmail threads (H02, H04)
**Status:** fixed in PR #51 (merged).

**Cause:** when the customer's email had no subject, our first reply used a subject of its own ("A couple of quick questions"). Gmail only groups a reply into a thread when the subject matches, as well as the reply headers.

**Fix:**
- Replies to a subjectless email use "Re:".
- Message-IDs are put in angle brackets on the way in and on the way out.
- Lookups also match older rows stored without brackets.

**Tests:** `tests/acceptance/thread-and-name.test.ts` and a unit test for provider IDs.

**Not verified:** that Gmail actually threads "Re:" under a subjectless original. Confirm it with one live test.

### TG-B12 (P2): unfinished transitions and awkward constraints (A01, A03)
**Status:** fixed in PR #52 (merged).

**Fix:**
- The advice email is now laid out in this order:
  - an event header line
  - the answer first
  - market facts as bullets, with a whole-party total
  - the source in small print
  - bold prices in HTML
  - questions
  - links last
- A model paragraph whose claims the server has already placed elsewhere is dropped, which removes "…seats you're eyeing:" with nothing after it.
- Seat preferences are quoted: "These cover every seat in the venue, so they don't reflect your preference ("no obstructed views")."

**Test:** `tests/unit/timing-advice.test.ts`: "the advice email reads at a glance".

## Retest plan (after PR #53 is merged and deployed)
Test from a QA address on `EMAIL_TEST_RECIPIENT_ALLOWLIST`; it is no longer rate limited. Don't resend the whole batch.

1. A05 Hamilton (3 together, $450, step-free): no "where I'd buy"; the three needs are listed; the quantity note is shown.
2. A01 (5 under $600): the over-budget sentence with $608.75 and the evidence age; no "fair".
3. A08 (delivery 6pm, leave at noon): opens "On delivery:" and says a refund is not admission.
4. A03 (wheelchair spaces vs regular): the accessible-spaces line; "You haven't included…" wording.
5. A07 watch, then A07-R1 cancel: the "nothing is being monitored" status, then the cancel confirmation with the real count.
6. A09 London: the US-only line.
7. H01 Metallica, no subject, "soon in NY", then "They are playing in Connecticut": Connecticut searched; one Gmail thread.
8. H02 and H03 retests (quantity change; Bushwick narrowing) to decide whether B05 still needs code.
9. A10 and A11 (seven-day group trend; screenshot extraction). These were blocked before and are now testable. Note: we have asking prices from SeatData only, not completed sales. The reply should say so; see the open items.

## Open items and dependencies
- **Verified purchasable offers:** needs a listing or inventory partner. This is the main product gap and can't be fixed in code alone.
- **Completed-sales data:** not available from SeatData, which gives listed (asking) prices only. Answering "how many sold" needs a source that provides sales, and the reply should state that limit explicitly. Not yet implemented.
- **Customer display of SeatData figures:** needs SeatData's written approval before launch. Testers on the allowlist see them now.
- **Watch alerts:** off (`WATCH_SEND_ENABLED=false`). Turning them on needs a source whose terms allow monitoring.
- **TG-B07 discovery exclusions, and the B05 remainder:** as above.
- **Constant-markup band** in `priceAgainstFloor` / `C_QUOTE_MARKET`: review it.
- **Model switch** (the user asked about GPT-6.1 Sol): separate from these fixes. It is an env change on Render (`OPENAI_BASE_MODEL=gpt-6.1-sol`, plus a `MODEL_PRICES_USD_PER_MTOKEN` entry). Do it after the retest, so model and code regressions can be told apart.

## Where things are
| What | Where |
|---|---|
| Decision records | `docs/DECISION_LOG.md` #51 (geography and threading), #52 (this audit) |
| Audit acceptance tests | `tests/unit/audit-0929.test.ts`; `tests/acceptance/official-sale.test.ts`, `boundaries.test.ts`, `geography-discovery.test.ts`, `thread-and-name.test.ts`, `listing-evidence.test.ts`; `tests/regression/cases.ts` |
| Test suite at PR #53 | 538 passed, 7 skipped; typecheck and lint clean |
