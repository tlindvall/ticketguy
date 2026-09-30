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

---

# Round 2: after the remediation review and the live retest (Sep 30, 01:14 UTC)

**Inputs:**
- `remediation-review/CLAUDE_REVIEW_AND_ACCEPTANCE.md`
- `remediation-review/audit-replay-cases.json`, with the exact 16 audit sends
- `retest-2026-09-30-0114/`: 7 live sends after PR #53 was deployed

The reviewer's copy of the round-1 report was cut off during TG-B06 (104 of 220 lines). The full round-1 text is above.

**Status:** PR #54, not merged or deployed. Nothing in this round has been observed live.

## How this round was verified
- New `tests/acceptance/audit-replay.test.ts` replays every audit email and every retest email word for word. The source is `tests/fixtures/audit-0929-cases.json`, with addresses and message ids removed.
- It runs at the audit clock, against seeded events: Rangers vs Lightning on Oct 1, and Hamilton on Oct 3 with its real Ticketmaster mapping.
- Follow-ups go into their original threads.
- It uses the deterministic extractor. It checks what the pipeline does with each request, not what the production model reads into it. Model extraction can differ; the guards below cover the cases where it mattered.
- It also found failures the reconstructed tests missed: A09, A07, A07-R1, A05-R1 and A10. These are listed below.

## Per finding

| Finding | Cause (confirmed in code) | Fix in PR #54 | Regression |
|---|---|---|---|
| **R2-B01**: "It's a fair price for these seats" (R05); "in line with the market" (R03) | `verdictClaim` and `C_QUOTE_MARKET` still used a floor × 1.15 / × 1.30 band (`priceAgainstFloor`, `nearCap`). The market alternatives filter used a 1/1.3 fee allowance. | Removed all three. Now the email states the observed gap, its basis ("your price includes fees and that one doesn't, so the real gap is smaller") and "that cheapest listing could be any seat in the venue". No "fair", "reasonable" or "in line". Alternatives count as cheaper only as listed, with a fee-basis caveat. | Replay test "no reply anywhere calls a price fair…" across all 23 sends; market-tracking; alternatives unit |
| **R2-B02**: R05 two offers with "neither of us needs wheelchair seating" | The model set `accessibilityNeeds` despite the negation. Nothing kept more than one offer. | `NO_ACCESS_NEED` guard clears it after any extractor. New `offersInText()` keeps each offer separate. `C_OFFERS` opens the email with the choice and why: "Offer A is wheelchair-accessible spaces, which no one in your group needs, so it isn't one to buy even though it's cheaper". Whole-party totals ($160, $210) and what to check on B follow. The acknowledgment now reads "which of the two offers to choose". | Replay A03, R05 |
| **R2-B06**: "section Offer B: 211" | The listing reader put the offer label into the seat fields. | `cleanSeatField()` on section and row. | Replay A03, R05 |
| **R2-B04**: R03 acknowledgment said "whether $220 is a good price"; deadline asked again | The acknowledgment read only price and quote. Timing questions ran regardless of what was asked. | The acknowledgment names the delivery or two-offer question. There is no deadline or "lock in" question when they asked about delivery, access or offers. Refund wording is now "a refund guarantee, if the seller offers one…". | Replay A08, A08-R1, R03 |
| **R2-B05**: "$547.65, under your $600" | The under-budget branch said "under your budget". | "five at that price would be $547.65, which leaves $52.35 of your $600 for fees. I can't see those fees, so whether it fits is unconfirmed." Over budget (A01): "…over your budget before any fees. That doesn't prove nothing cheaper exists now". | `audit-0929` unit A01, A07 |
| **R2-B03**: "compare" did not lead to a comparison | The invitation implied a capability we don't have. | With hard requirements, the invitation says what a comparison can't do: "That shows price levels only: I can't check particular seats, their access or whether they sit together". The follow-up opens with each requirement said as not yet checked (`C_REQS`). A real comparison still needs inventory; see Dependencies. | Replay A05, R01, A05-R1, R01-F1 |
| **Review §3/§5 core case**: their offer vs B, C and D | Already handled by `compareOffers` (wrong quantity, obstructed, over budget), but the email didn't point to B or say why C and D were dropped. | The verdict now reads "…over your $600 budget. The verified option below meets what you asked for: $585 for all five, within your $600 and $65 less than this one." New `C_LEFT_OUT` names the rejected cheaper listings and why, without offering them. The no-suitable world states the limit. | `tests/acceptance/useful-comparison.test.ts` (both of the reviewer's fixtures) |
| **A09** London (replay): endorsed Hamilton in New York | The rules extractor took "not New York" as the city. | `NAMED_ABROAD`: a city with a non-US country ("London, UK") is out of scope whatever the city field says. | Replay A09 |
| **A07 / A07-R1 / R04** (replay) | The watch request wasn't recognised. The cancel wasn't recognised. A watch row was stored while alerts were off, so "stopped the price watch" contradicted "nothing is being monitored". After A07-R1 closed the request, R04's cancel widened to all of the customer's watches. | `asksToCancelWatch()` guard; "stop this watch on Sep 30 at 6pm" is read as an expiry, not a cancel. No watch is stored while `WATCH_SEND_ENABLED` is off. Cancel is scoped to the thread whenever it has an earlier request. A cancel closes the request. | Replay A07, A07-R1, R04; watches acceptance |
| **A05-R1** (replay): silent | The official-sale reply was deduplicated per request, so a follow-up got nothing. Its budget basis was also asked again. | Official-sale replies are deduplicated per revision. A recheck opens "No, I haven't checked any of these…". "the total is under $450" reads as a total. | Replay A05-R1 |
| **A10** (replay): the game wasn't found, and "how many sold" went unanswered | The matchup was read as "For New York Rangers vs …". Sales were never addressed. | Leading function words are stripped. `C_SALES`: "I can't tell you how many tickets have sold… asking prices… not completed sales, and a listing that disappears may have been sold, moved or withdrawn." | Replay A10 |
| **B05** (A01-R1 / R02-F1): budget not visible in the reply | — | Reply headline shows the brief: "· 6 tickets · up to $720 in total". Persisted brief asserted: quantity 6, $720, whole party, same event. | Replay A01-R1, R02-F1 |

## Completion table (the fields the reviewer asked for)

| Item | Code status | Deployment | Regression | End-to-end | Manual work | External dependency |
|---|---|---|---|---|---|---|
| B01 endorsement gate | #53 merged, CI green; extended in #54 | #53 deployed per the user (commit not verified by me); #54 not deployed | Replay A05, R01, A05-R1, R01-F1 | Live R01 passed on #53; #54 not observed | None | None |
| B02 intent / two offers / delivery | #53 partial; #54 | #54 not deployed | Replay A03, R05, A08, A08-R1, R03 | Live R03 partial, R05 failed on #53; #54 not observed | None | None |
| B03/B04 budget and value | #53 partial; #54 removes every band | #54 not deployed | Replay "no fair" across 23 sends; audit unit | Live R02/R03/R05 showed remaining bands on #53 | None | SeatData: customer display needs written approval before launch |
| B05 context | #51, #53, #54 | #51 and #53 deployed per the user | Replay A01-R1, R02-F1 | Live R02-F1 passed quantity and date on #53 | None | None |
| B06 degraded service | #53 | #53 deployed per the user | `boundaries` acceptance | Not exercised live (no rate limit hit) | Staff own the "a person is picking this up" requests; the alert says what the customer was actually sent | None |
| B07 discovery exclusions | Not started | — | — | A04 replay still shows "Live music" for house/techno | — | — |
| B08 provenance | #53 | #53 deployed per the user | listing-evidence, audit unit | Live R05 wording passed on #53 | None | None |
| B09 US-only | #52, #54 guard | #52 deployed | Replay A09 | Not re-tested live | None | None |
| B10 watch state | #53, #54 | #54 not deployed | Replay A07, A07-R1, R04; watches | Live R04 acknowledgment passed on #53; database state not verified | Staff can check `/admin` → Price watches | Watch alerts need a source whose terms allow monitoring (`WATCH_SEND_ENABLED` is off) |
| B11 threading | #51 | #51 deployed | thread-and-name | Not re-tested live | None | None |
| B12 template prose | #52 | #52 deployed | timing-advice | Not re-tested live | None | None |
| Useful comparison (review) | #54 | #54 not deployed | useful-comparison (both fixtures) | Not observable live: there is no verified inventory in production | Only a staff-verified offer can produce it today | A listing or inventory partner, or permitted staff verification, with source, check time, quantity, adjacency, cost basis and who checked it recorded |
| A10 trend and sales | #54 (sales statement) | #54 not deployed | Replay A10 | Not observed live | None | Completed-sales data: none available (SeatData gives asking prices only) |
| A11 screenshot | Existing (listing-evidence) | Deployed | listing-evidence (fake reader) | Not observed live (blocked in the audit) | None | Model image read: enabled with `EXTRACTION_PROVIDER` |

## Still open
- **B07 discovery exclusions:** "No pop concerts" is ignored, and house/techno is read as "live music".
- **Live comparison:** needs verified inventory. The code path is proven only on fixtures.
- **Production state:** the A07 watch and the persisted R02-F1 brief were checked only in replay, never against production data.
- **A10 seven-day group trend:** the claim is gated on comparable history, which the replay can't show.
- **A single-offer model read of a two-offer message** is still stored as listing evidence. `C_OFFERS` now answers the question, but that stored read is unused noise.

---

# Round 3: usefulness, wider wording, backend proof (PR #55)

**Status:** PR #55, not merged or deployed.

| Point from the review | What changed | Evidence |
|---|---|---|
| Honest isn't useful: "I haven't checked" leaves the customer shopping | Staffed comparison pilot, off until `STAFF_COMPARISON_OWNER` names a staff address; up to 20 customer requests. The email says a person is looking and will reply in the thread with options and all-in totals, or say nothing fits. The request waits on the owner, who is alerted with what to record. Staff record verified manual offers and re-run research; the existing engine sends the comparison. `/admin/pilot` shows offered, answered, open, median time and the sellers checked. | `tests/acceptance/staff-comparison-pilot.test.ts`: no owner means no promise; owner handoff and alert; staff answer and measurement; limit, with staff tests not counted |
| Beyond exact wording: "I live in London, UK, but want Hamilton in New York" | The abroad guard fires only when the event is abroad. Where someone lives, or where someone else is, never makes a US event "abroad". That example is still declined, by the residence rule (US customers only, ENGINEERING_SPEC §1), with the residence reason. | Regression cases `event.resident_abroad_us_event` and `event.someone_else_abroad` |
| Cancellation needs backend proof | Found and fixed: a customer's cancellation left approved alert sends queued; dispatch looked alert approvals up in the wrong table, which would have blocked valid alerts and ignored cancelled watches. | `tests/acceptance/cancellation-isolation.test.ts`, on two threads with queued alerts, an event alert and a repeated cancel on the closed thread. It fails when either fix is removed. |

**Decision needed from the owner:** should non-US residents buying US events be served? The launch boundary says no. Tourists buying US shows may be a large share of demand, but changing it needs the privacy and legal review the spec calls for (§ "US-only scope still needs appropriate privacy/legal review").

---

# Round 4: the post-#54 full QA (23 sends)

**Status:** on the same branch as PR #55, so #55 carries rounds 3 and 4. Not deployed.

Every fix below is checked on the full rendered email, not the opening line. The replay (`tests/acceptance/post54-replay.test.ts`, fixture `tests/fixtures/qa-post54-cases.json`) sends all 23 emails in send order at the QA clock. Paths that go through the model listing reader are tested with a stand-in reader, including one that drops a negation (`tests/acceptance/post54-screenshot.test.ts`). Paraphrases and negative controls are in `tests/unit/post54-offers.test.ts`.

| Bug | Cause (traced, not inferred from the email) | Fix | Evidence |
|---|---|---|---|
| R3-B04 X02 recommends unsuitable offers | The offer comparison applied only the access rule. It read no view, quantity or split rule, and never checked the budget. "$55 less" came from comparing only the first two offers left after the access filter (C and D). | One record per offer, with quantity, can't-split, view, access, together, fee basis and per-order fee. Hard requirements are applied first: quantity they can actually buy, view they ruled out, access, together, budget. Each left-out offer is named with its reason. The pick is measured against the offer they asked about ("than A"). | Replay X02: "Offer B is the only one that meets what you asked for: $585 … $65 less than Offer A and $15 under your $600 budget", plus A, C and D each left out for its reason |
| R3-B05 X01 per-order fee dropped | The parser didn't read per-order fees, and "including every fee" didn't match the fee pattern. | A per-order fee is parsed and added once. "Including every/any fee" and "fees included" count as all-in. | Replay X01: A $220, B $210, "$10 less" |
| R3-B01 R05 mixed offers, contradictory verdict | The same email was also read as one listing by the model reader, which mixed A's price and access with B's seats. That single-listing verdict, its catches and "You mentioned $80" were rendered after the comparison. | With two or more offers: no single-listing read, subject, quote, market read or "send me a link" ask. An offer's price is never taken as their budget or quoted price, a deterministic guard over either extractor. | Replay R05; screenshot test (the reader is never called for R05) |
| R3-B02 R03 fee basis lost | A quoted price never carried the customer's fee wording. | "$220 total including fees" is recorded as all-in by their account, not as verified. | `audit-0929` R03 packet test; `statedFeeBasis` unit test |
| R3-B08 R05-F1 stale accessible restriction | [Likely] The model's restriction text for "Neither seat is a wheelchair or companion space" contained the keyword, and the code mapping ignored negation. The live email alone can't show which. | Negation-aware restriction codes. Their own "neither seat is / not a wheelchair space" also clears it when the read keeps the word. | Screenshot test with a reader that drops the negation |
| R3-B09 A11 screenshot ignored | [Certain] Resend's received-email detail has no `download_url` (SDK types: signed URLs come only from `GET /emails/receiving/{id}/attachments`). Every attachment was skipped as `no_download_url` before the reader ran. | Signed URLs are fetched from the attachments endpoint. An attachment that can't be fetched is recorded on the message. An unread or missing image gets "I couldn't read the image you attached…" plus a short ask for the typed details. Nothing is assumed: no default of two tickets. | Replay A11 (unfetched image); screenshot test (read image: three tickets, 212/18, $264, obstructed; "its total … includes the fees it lists" instead of "fees are extra") |
| R3-B06 absolute floor, missing timestamp | Wording, plus bullets that carried no time when the data was fresh. | "The lowest asking price I saw among … (checked <time>) … StubHub and Vivid Seats only … can move either way". Every market bullet names its check time. The heading is "when I last checked", not "right now". | Replay: no "that or more" or "right now:" in any reply; `audit-0929` and `timing-advice` tests |
| R3-B07 A04 "Dance pop" pick | Exclusions weren't read. | "No pop / tribute / kids' events" is read from the thread and applied before ranking. | `exclusionsIn` unit tests with controls (pop-up, pop-punk) |
| R3-B03 R03 generic timing | The market read's buy/wait sentences and the model's closing ran after a delivery question. | Neither is added when the question was delivery or their offers. | `audit-0929` R03 packet test |
| R3-B10 A06 re-asks date and city | The no-match fallback always asked "which date and venue". | Given an act, a date and a place, it offers one next step: send the announcement link, or name another date or city. | Replay A06 |
| L01 limitation buried | — | "I can't open StubHub listings myself, so I haven't seen the one you sent…" now comes before any market figures. | Replay L01; market-tracking test |

**Not done, and why:**
- **R3-F01 (visitors):** a policy decision for the owner (see round 3).
- **R3-F02 (verified comparison):** the staffed pilot in #55 is the path; it needs `STAFF_COMPARISON_OWNER` set.
- **R3-F03 (alerts):** still off (`WATCH_SEND_ENABLED`); nothing new is claimed.

**Not proven here:**
- **The live Resend attachment path:** the signed URL host isn't documented, so it isn't held to a host list. It must be https, resolve to a public address and not redirect. Verify one real attachment in production; the audit log records `skippedAttachments` with reasons.
- **The model extraction of these emails:** the replay uses the deterministic extractor. The deterministic guards (no budget taken from an offer price, negated access) are there because the model can make the same mistakes.

---

# Round 5: the Sep 30 morning live QA after #55 (27 sends)

**Status:** new PR from `claude/relaxed-faraday-x955vr` (restarted on main after #55 merged). Not deployed.

**How it's tested.**
- `tests/acceptance/qa0930-replay.test.ts` replays all 27 sends in send order, with each body wrapped at 76 characters as live text arrives. A11's image goes through a stand-in reader that makes the live model's mistake (it calls the $72 base price all-in).
- `tests/unit/qa0930-offers.test.ts` has the counterexamples:
  - renamed and reordered labels, and four wordings of "won't split";
  - a changed requirement that changes the winner;
  - nothing that fits;
  - fees that are known, unknown, per ticket and per order, including the break-even crossing and a tie.

| Bug | Cause (traced) | Fix |
|---|---|---|
| R4-B01 M01 picks the unsplittable six | "seller requires buying all six" wasn't read as can't-split. "six ordinary unobstructed seats" wasn't read as six, because two adjectives broke the pattern. The refusal of an extra ticket wasn't a rule. | Quantity pattern allows up to three words and ignores prices and seat numbers. The can't-split wordings are widened. Attendees, extra tickets (refused or allowed) and the maximum to buy are read across the thread, and the latest word wins. |
| R4-B02 M03 calls late delivery a fit | Delivery was never an eligibility rule. | The customer's deadline ("before we leave at noon", "noon delivery deadline") is parsed. Each offer's delivery time is parsed ("immediate", "by 6pm", or said once for all offers). A delivery that's too late, or has no time, is ruled out. With nothing fitting, the smallest single change is named. |
| R4-B03 X01 "can't compare"; M02 unknown fee "fits"; A11 fee basis | [Likely] Live text is generated from HTML and wrapped, so "no other\ncharges" failed a literal-space pattern. An unknown fee counted as a fit. The reader's all-in label on a $72 base beside a $264 total wasn't cross-checked. | All offer text is flattened to single spaces before parsing. An offer with unknown fees is compared by break-even ("only beats it if its fees are under $40"), and a budget fit is shown as conditional. A per-ticket price below its total's share is treated as before fees, and the quote is the all-in share (A11: $88 each). The fee-gap direction is fixed: an all-in price below a before-fees floor only gets further below it. |
| R4-B04 follow-ups lose the offers | Offers were read from the latest message only. | When a follow-up talks about offers without naming new ones, the offers from earlier in the thread are re-judged on the new terms. A typed correction to an earlier screenshot or listing read (fee basis, per-order fee, total, delivery time) is applied and said first. |
| R4-B05 G02 4pm show for "after 6pm", "the only show in Manhattan" | Discovery had no time window or age rule. | Start-time windows are enforced. A named teenager or "no 21+" becomes an unverified requirement, the venue's age policy. The line reads "the only one I found", not "the only show". |
| R4-B06 G03 barcode question sent to intake | No post-purchase intent. | Already bought plus asking about entry now gets official-transfer guidance with the Ticketmaster and MSG sources the QA checked, and one next step. The request is closed as a reported purchase. |
| R4-B07 unproven saving and urgency | A before-fees alternative was headlined against an all-in price. "Thinning out" was drawn from all-event counts. | Alternatives within a normal fee margin of an all-in price are dropped. The rest carry their fee break-even. Group scarcity is claimed only from counts for that group size. |
| R4-B09 doors vs show | Doors weren't stored. | New `events.doors_at` column (migration 0016), read from Discovery `dates.doorsTimes` [Likely field name; verify on a live sync]. The event line shows "(doors 8:00 PM)" when doors come before the start, and never infers one from the other. |

**Writing-review changes.**
- Comparisons open with the decision ("Offer B wins this one: $210 for both, fees included. That's $10 less than Offer A."). Only that first sentence is bold, not every amount.
- A comparison carries no market floor, no history or group-count paragraphs, no generic delivery warning, and no "send me a link" ask.
- There's no "I'll look at how the tickets are trading" acknowledgment before an answer that needs no search (offers compared, a screenshot, a delivery question), unless something was assumed.

**Not changed, and why:**
- **Signature:** your design gives the full signature on the first reply in a thread and the short one on follow-ups. Dropping the extra acknowledgments makes it more consistent; changing the design is your call.
- **R4-B08 house/techno precision:** still category-level matching. It needs genre evidence we don't have.
- **R4-F01–F04 (verified inventory, monitoring, group trends, visitor policy):** capability and policy gaps, unchanged.

---

# Round 6: the Sep 30 "latest commits" live QA after #56 (18 sends)

**Status:** new PR from `claude/relaxed-faraday-x955vr` (restarted on main after #56 merged). Not deployed.

**How it's tested.**
- `tests/acceptance/qa0930b-replay.test.ts` replays all 18 sends in send order, wrapped at 76 characters. It runs them three ways:
  - with a budget;
  - with the daily budget at $0 and a model extractor that fails the test if it's called;
  - with a model that times out on every call, through the outbox's retries, to the hand-off.
- `tests/unit/reliability-0930b.test.ts` covers:
  - provider error classes;
  - actual-cost accounting and the call cap;
  - the four-try limit;
  - a model name the provider refuses;
  - the variants' arithmetic;
  - the rules reader's party size and budget basis.

**Why R05 and V01 went to a person, and why five sends got no reply.**

| Finding | Cause (traced) | Fix |
|---|---|---|
| R5-B01 R05, V01 "a person will reply" | [Certain] The daily cap (`global_daily`), not the per-request cap. A first call is estimated at about $0.07, far below $1. No price was set for the model, so every call was costed at the $15/$75 fallback. The cap also summed estimates, never actual usage. By early afternoon UTC the day's estimates had passed $10 while the real bill was a few dollars. | Spend counts a finished call at its actual cost, and a reservation only while its call is running. With no budget left, the email is read by the rules reader and answered, never parked. Each such stop is audited (`ai.budget_rules_fallback`) and counted on /admin/operations. The operations page shows the model's configured price, or a red badge when it is using the fallback. |
| R5-B02 V02, V03, A11-F2, V04, R05-F1 unanswered | [Likely, not proven] Every provider error was classed as a network error, so it was retried with backoff for about 42 minutes. Then it was dead-lettered with no reply and no alert. A wrong model name, key or billing (for example after a model switch) fails every call this way. R05-F1 fell under R05's once-per-request holding reply. | Provider errors are split. 400, 401, 403, 404 and 422 responses, and quota or billing errors, are `rejected`: nothing to retry, so the email is read by rules and answered, with `ai.provider_rules_fallback` counted in red on the operations page. Timeouts and rate limits stay `transport` and are retried, but customer work (`request.interpret`, `research.requested`) gets four tries, not eight. After the fourth, the request goes to a person with the provider's error in the staff alert, and the customer gets the holding reply once. /admin/requests/[id] has "Read the latest email again" for a parked request. |
| Call cap never counted finished calls | Settling a call changes its row to `settled`, and the cap counted only `reservation` rows. | Calls = reserved + settled − released. |

**The variants, on the replay.**

| Case | Now |
|---|---|
| R05 | Offer B, $210 for both. A's wheelchair spaces are ruled out with the reason. |
| V01 | The green listing, $180 for all four. Gold is ruled out: "It's five tickets the seller won't split, and you won't buy an extra." "For the whole order" is read as a total, so there's no "I've read $200 as the total" acknowledgment. |
| V02 | "$190 all-in for both" is the pair's total, not $190 each. Seller times are converted: A's 1:30pm New York time (10:30am Los Angeles time) misses the 1pm deadline. B, at 12:30pm, fits at $220. |
| V03 | "With a friend" is two tickets. The $20 parking price isn't taken as a budget. The reply is only the parking answer: $190 for two admissions. No acknowledgment, no seat search, no "send me the listing". |
| A11-F2 | "Updated from your email: four tickets, $316 in total, $79 each including fees." Then three points: $70 × 4 plus $36; section 212, row 18, seats 7 to 10; limited view and delivery by 4pm on Oct 1. Then "These replace what the image showed." |
| V04 | $52.50 + $12.75 a ticket, plus $8: $269, against $272. Both fit $275, and the first saves $3. The per-ticket fee is in the working, and "both offers say immediate transfer" is read mid-sentence. |
| R05-F1 | "Looking at Offer B on its own, with nothing from Offer A applied: it meets what you asked for, at $210 for both." The immediate transfer is read from the later sentence, and $210 is no longer taken as a budget. |
| A11-F1 | The $98.89-before-fees question is answered from their numbers: "Larger… its fees can only add to that." Live, that answer came from the market-floor paragraph, which a synthetic example no longer shows. |
| G02 | The reply opens: "This is one evening option: … The time fits; I haven't confirmed it works for your group yet." "Two adults and our 16-year-old" is three. When Ticketmaster's lowest face value times the party is already over the cap, the budget line says so with the arithmetic (3 × $59.10 = $177.30). |

**Writing-review changes.**
- Offer lines give the reason ("Over your $600 budget by $50.", "Delivery by 6pm misses your noon deadline."), not a "Left out:" or "Meets what you asked for" label.
- M02 opens "Offer B is the straightforward choice if you'd rather skip another checkout", with the $40 threshold straight after it.
- A synthetic example gets no market, checkout or availability advice: the total and the per-ticket price with fees, then the working, the seats and the catches as points, each said once.
- The holding reply says what happened and where the answer will come, with no business hours presented as a reply time.

**Not proven here:**
- **The cause of the five silences on the live service.** The fixes cover both likely causes (refused calls and long retries). The real cause is the "Last error" of the retried or dead-lettered events on /admin/operations.
- **The model path for these emails.** The replay uses the rules reader, which is now also the budget fallback. A model-reading replay would need recorded model outputs.
- **G02's face value.** `events.face_min_cents` comes from Discovery `priceRanges`, which not every event has.

**Not changed, and why:**
- **Signature consistency across follow-ups:** still your design call (as in Round 5).
- **A04 house/techno precision:** needs genre evidence we don't have.
- **Visitor policy:** unchanged.
