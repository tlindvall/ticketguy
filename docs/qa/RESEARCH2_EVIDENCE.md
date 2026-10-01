# Research 2: price evidence and useful answers — fixes and limits

Research 2 (Sep 30, 2026) captured three live conversations on build `ed55056` (PR64). All three failed on usefulness. Disposable local controls on `055edf6` (PR66) also reproduced three trend-engine and response defects. This note records what changed for each finding and what is still not proven.

**Inputs.**
- I had the report as pasted text.
- `WAVE_1_CASES.json`, `EMAIL_EVIDENCE.html`, `LOCAL_ENGINE_CONTROLS.json`, `local/controls.test.ts` and the raw captures were not available here. The message texts and control inputs in the tests are therefore rebuilt from the report's descriptions. When those files arrive, their exact texts should replace these.
- R1-U01, R1-U02 and R1-U03 are Research 1's findings and are not touched here.

## Findings

| ID | On `main` | Now |
|---|---|---|
| **R2-TREND-TIME-01** (P1) | `computeTrend` ignored `now`. A series ending 14 days ago, or entirely in the future, came out `up / sufficient` and was rendered as "over the last 24 hours". The pipeline loaded every snapshot with no time bound. | Observations after `now` (5-minute skew) are dropped, and the pipeline no longer loads them. Direction and span are read over the 72 hours up to the newest valid observation. If that observation is older than 24 hours (the market series' cut-off), the trend is `insufficient` for timing, with `endpoint_stale:Nh`, and the old interval is kept under `historical` with its real dates. The visible claim says "The newest comparable price I have for your group is from Sep 16, too old to say how prices are moving now", and gives the dated movement. A current trend whose newest point is more than 90 minutes old says "in the 24 hours up to {time}". The claim's `observedAt` is the newest observation, not the time of the reply. The method version moves to `trend-1.1`. |
| **R2-TREND-RIGHTS-01** (P1) | `computeTrendFor` checked fixture status only. Revoked, quarantined and expired datasets produced the same trend as an approved one, and the trend was customer-visible by default. | New `trendRights()`: each snapshot's dataset must be `approved`, inside its retention, and approved for `advice`. Display also needs `customer_display`. A real snapshot with no dataset record has no rights. Fixture rows count only in the fixture world, and never through a real dataset. At approval, a draft's visible trend claims are rechecked against today's rights, so a draft written before a revocation returns `409 trend_rights_changed` and stays pending. |
| **R2-SUPPLY-COPY-01** (P1) | In `marketRead`, the falling-price branch ran before the low-count branch. A customer who accepts wait risk was told "plenty to choose from… no need to rush" with one listing, with no count, or with venue-wide counts for a group. | A thin count (under 15 for their group size) is a caution, whichever way prices move. An unknown count is said as unknown: "that alone isn't a reason to wait", with the risk and the deadline kept. A known adequate count is described as listings with N or more tickets, with the split and seats-together limit. Waiting is then "reasonable if you're ok with the risk", never a promise. "About 1 listing has" is now singular. |
| **R2-EVIDENCE-01** (P2) | Questions about supplied figures went to event intake: "Two tickets Today. Got it." or "which event?". The quote's "today" became the event date. | `suppliedEvidenceAnswer()` runs before event intake and needs no event fields. Four families are covered (below). The reply leads with the answer in bold, then one distinction, one evidence limit, and a next step only when one would change the answer. There are no links. In the stored brief, a "today" or "yesterday" next to a price is cleared, and sales-report ticket counts are not used as their quantity. |

**R2-EVIDENCE-01 families:**
- **Singles vs group.** "Singles fell $30, from $90 to $60 (33.3% lower)." The five adjacent upper-tier seats are a different basket with no prices.
- **Group totals.** "For your five-seat group, the supplied total went up $50: $450 to $500." That is 11.1%, without forecasting or telling them to buy.
- **Fee basis.** $200 before unknown fees against $250 all-in, which breaks even at $50 of fees. With $60 of old fees: $260 against $250, so today is $10 cheaper (3.85%).
- **Listings vs sales.** A drop of 30 listings (30%) is listings, not tickets, orders or sales. A separate report of 12 orders covering 24 tickets is reported conditionally, as the customer's figure. Why the other listings came down, and any change in demand, stay unproven.

## Controls

All of these fail on `main` except the positive controls. That was checked by running `research2-evidence.test.ts` in a clean worktree: 12 failed, 1 passed (the approved-dataset positive control).

- **Time.**
  - Positive: a fresh series is current and sufficient.
  - Negative: the same series ending 14 days ago, or 48 hours ahead, is not current.
  - Mixed: one future point is dropped while the rest still count.
  - Lookback: a valid 72-hour baseline is kept, and older points don't steer the result.
- **Rights.**
  - Positive: an approved dataset gives the trend, and its draft approves.
  - Negative: revoked, quarantined, expired, retention ended, no advice use, and no dataset record.
  - Advice without display: the trend is used but not shown.
  - Fixture isolation.
  - Revocation after drafting blocks approval.
- **Supply.** Counts of 1 → 1, unknown, and 100 → 100.
- **Evidence.**
  - Incompatible baskets: different seat counts, or a single seat against five seats. The existing `suppliedTrendQuestion` safeguard keeps priority.
  - Unknown fees.
  - Unreconciled removals.
  - Missing provenance: "apparently 12 orders" is "your figures", not "your report".
  - Ordinary named-event requests and labelled offer comparisons are left to their own paths.
- **Complete-reply check.** No "fair", "under budget", buy or wait, "plenty", "prices will", or demand asserted after a correct calculation. No event intake wording.

## Not proven here

- **Production model.** These are rules-path replays. The production model may phrase intent differently, and its extraction of these messages wasn't exercised. The six-message conversation set still needs a live retest, which is Research 2's to run.
- **Reconstructed texts.** The parser is regex-based and was written against my reconstruction of the messages. Different wording of the same facts may not be recognised. In that case the route returns null and the old path answers. That fails safe, but it isn't useful.
- **Production data.** Production dataset state was not inspected. These changes enforce rights; they don't establish that revoked data was ever used.
- **Stale cut-off.** The 24-hour current-trend threshold matches `MARKET_STALE_HOURS`. It is a policy choice, not derived from evidence.
- **Other approval paths.** The approval recheck covers trend claims only. Other stored claims aren't rechecked for dataset rights at approval.
- **Rendering.** Gmail and mobile rendering were not checked.
