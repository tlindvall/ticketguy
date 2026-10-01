# SeatData price watch: QA wave 1 (Oct 1, 2026, merged #78 at `2f1bd19`)

The QA package tested the merged price watch locally:
- 65 existing tests passed;
- of its own 47 checks, 39 passed and 8 failed, across five issues.

All five are **local findings**. None was seen live. The live preflight showed the deployed build was still `9eb3679`, from before #78: `GET /api/internal/watches` returned 404. So the live behaviour of the feature is untested, not certified.

The package's independent test is ported as `tests/acceptance/price-watch-qa-wave1.test.ts`, with its exact phrasings. On `2f1bd19` it reproduces the package's result: 39 pass, 8 fail. Here, all 63 tests pass, which includes the added controls.

## Findings and fixes

| ID | Cause | Fix |
|---|---|---|
| **PW-REPEAT-KEY-01** (P1). A $390 → $260 drop gave no alert. | The dedupe key bucketed totals by a step of 5% *of the total itself*. So every total above $200 fell into the same band, 19 or 20. This hit seller alerts too, not only market ones. | Keys are per exact total, so the same price never alerts twice. Whether a different price is worth an alert is the re-alert rule's call. It compares against the **lowest total already alerted in this watch generation, at any time**, not only the last 24 hours. That keeps the old band's oscillation guard beyond a day. An alert the system invalidated never reached the customer, so it is no baseline. The daily cap still counts every alert in the rolling 24 hours. |
| **PW-SECTIONS-01** (P1). "Only sections 101–105" created an unrestricted market watch. | Nothing filled `acceptableSections`, so `marketWatchable` never saw the sections. | `sectionsRequired` reads hard section rules from the thread and from the model's `seatingPreference`. It handles ranges with "–", "-", "through" or "to"; lists with ",", "or" or "and"; "must be in section 212"; and "sections … only". A preference ("ideally section 101") is not a rule, and "any section is fine" clears one. The market watch is refused with `market_unverifiable:sections`. On seller watches, the sections now apply to eligibility. |
| **PW-ENTRY-01** (P1). "Must permit entry after midnight" and "Late entry is required" created watches. | The basket carried only the age rule. | `entryNeed` reads late-entry and admission requirements. A quoted doors or start time is a fact about the event, not a requirement. "We don't need late entry" clears it, and the latest message wins. The audit reason is `market_unverifiable:entry_rule`. A third phrasing ("I can only arrive after midnight; entry then must be allowed") goes to the late-entry reply before the watch path. That reply now records `unverifiable:entry_rule` and tells the customer, once, that no watch was set up. |
| **PW-SCHEDULER-CLAIM-01** (P2). Two overlapping ticks made two paid reads and reported two alerts. | The due rows were read without a claim, and `onConflictDoNothing` was still counted as an insert. | Each due watch is claimed by moving its `next_check_at` on, but only while it is still due (`UPDATE … WHERE next_check_at <= now RETURNING`). A tick that loses the race skips the watch. A crash after the claim waits for the next slot instead of retrying a paid read. Alerts are counted from the inserted rows (`RETURNING`), and `evaluated` counts the claimed watches. |
| **PW-REPEAT-CONTRACT-01** (P2). The brief said "$10 OR 5%", but the code needs both. | The brief (and DECISION_LOG #62) was wrong. The code was right. | The conservative rule is kept: a repeat must be at least $10 **and** at least 5% lower, whichever is larger. #62 and the test brief are corrected. The boundary tests use the agreed rule: $120 → $114 is no, $200 → $190 is yes, $400 → $391 is no, $400 → $380 is yes. |

## Email

- **Creation reply.** The difference between market monitoring and checked seats is stated once: "Your market-price watch is on. I haven't verified a set of 4 seats together you can buy." The fee allowance is described as an assumption ("using an assumed 30% for fees (checkout fees can be higher)"), not as a ceiling. While a market watch is running, the requirements paragraph and "I can't see live resale listings" are hidden, because they contradicted the watch. The "send me a listing" line stays, because it's the customer's one way to get seats checked.
- **Alert.** It opens with the decision number, and only that number is bold: "Heads-up: resale listings now come to **about $390 for four** with fees, inside your $400." The event, the listed price and the allowance follow. Its footer drops "we … link you to the seller", because this alert has no link by design.

## Tests

- **Ported package test: 63 tests.** That's the package's 47, plus:
  - the four section phrasings, and three controls: a preference, a later "any section is fine", and no section at all;
  - two entry controls: quoted doors and start times, and "we don't need late entry after all";
  - the late-entry reply saying no watch was set up;
  - repeat rules: a $1,000 → $800 drop, a rise followed by a return to the earlier low, a small dip after 24 hours, and a generation change.
- **Exact audit reasons.** Failure checks now assert the precise `market_unverifiable:<reason>`, not just the prefix.
- **Combined counters.** PW-15 also asserts that the combined `evaluated` and `alertsCreated` across both ticks equal one each.
- **Updated assertions:**
  - `market-watch.test.ts`: the new creation and alert wording.
  - `security-intake.test.ts` A25: the oscillation guard is now asserted on the re-alert rule, not on two prices sharing a key.

## Not verified here

These limits are unchanged:
- live build, setup, licence, cron, admin UI and inbox rendering;
- real PostgreSQL row locking (PGlite runs queries one at a time; the claim relies on Postgres re-checking `WHERE` after a row lock);
- real SeatData data, and whether customers can find a matching listing after a heads-up.

An alert invalidated for being stale still blocks a later alert at **exactly** the same price for that generation, because its key exists. A different price can still alert.

## Also carried: thread order on equal timestamps

Every `messages` ordering now breaks `receivedAt` ties on `createdAt`. Without the tie-breaker, two messages with the same timestamp come back in physical row order, so "latest word wins" can read an older message as the latest.

That happens in replays with a fixed clock, and in production when two messages arrive in the same second. The TGQA-R8 S02 replay hit it while the R1 discovery work was being done in parallel: it read the 3pm deadline as the old 1pm one. `main` doesn't fail on it today, but only because of the order the rows happen to be in.
