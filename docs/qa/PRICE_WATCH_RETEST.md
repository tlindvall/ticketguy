# SeatData price watch: retest on the deployed build (Oct 1, 2026, `a80744b`)

The retest confirmed `a80744b` (merged #81) live on Render.

**Local results (the package's own suites):**
- original independent suite: 47 of 47 passed;
- baseline: 65 of 65 passed;
- new expanded controls: 9 of 10 passed. X09, the daily call cap, failed.

**Live:** three capture-only conversations, six replies. They found three new problems and one writing problem.

The package's expanded test is ported as `tests/acceptance/price-watch-retest-expanded.test.ts`. On `a80744b` it reproduces X09's failure. The three live conversations are replayed with their exact messages (`tests/fixtures/pw-retest-2026-10-01.json`) in `tests/acceptance/price-watch-retest-live.test.ts`. That replay runs against a local event shaped like theirs. It has no market data and no seller monitoring, as in production.

## Findings and fixes

| ID | Where | Cause | Fix |
|---|---|---|---|
| **PW-ENTRY-REPLY-02** (P1, live L03) | Asked: "I can only arrive after the show starts; late entry must be allowed. Do not suggest a ticket unless that entry rule is confirmed." Got: shopping advice that didn't mention entry. | The late-entry answer ran only for a clock-time arrival ("midnight", "11:30pm"). With no time, the request went to research, whose requirements list had no entry rule. | The late-entry answer now handles an arrival with no time: "after the show starts", "late entry must be allowed", "can't make the start". An entry rule with a time in it ("must permit entry after midnight") sets the arrival too. The reply says "Late entry is unverified", that the start time doesn't say whether latecomers are let in, and that nothing on file states the venue's policy. It suggests no ticket. It also says once that no watch was set up (`unverifiable:entry_rule`). In research replies, the requirements list now includes the entry rule. |
| **PW-CALL-BUDGET-01** (P2, local X09) | A daily allowance of 1 and an HTTP 503 led to three attempts, logged as `calls=3`. | The cap was checked once, before an operation, and the client's two retries didn't look at it. | `SeatDataClient.callCap` is checked before every attempt, retries included. The tracker sets it from what's left of today's allowance before each paid operation. Once the cap is reached, the client stops with `budget_exhausted`, and the log still records what was actually attempted. Controls: with room for them, the two retries still run (503, 503, then success, `calls=3`), and with nothing left, no attempt is made. |
| **PW-MULTI-INTENT-01** (P2, live L03 follow-up) | "Have you verified late entry? … Cancel only any price watch." got the cancellation only. | The stop path closed the request without reading the rest of the message. | The stop still happens first, from what's stored. Then a late-entry question in the same email is answered: "On late entry: no, I haven't verified it." The reply says that nothing on file states the venue's policy, that no checked policy page or contact is available, and not to buy on the start time. Nothing restarts. |
| **PW-EMAIL-FOCUS-01** (P2, live L01 to L03) | 407 to 436 words. The price maths was repeated, the event page was treated as a listing, three questions were asked, and the budget was never asked for. | See below. | See below. |

## Writing (PW-EMAIL-FOCUS-01)

- **Why no watch.** The reply now gives the recorded reason:
  - a requirement listings can't show: "I haven't set up a price watch for this: the resale listing data I can watch doesn't show the sections you need…";
  - a missing budget: "I need the most you'd pay in total for both, fees included…".
  - Otherwise the plain "I can't watch prices for you yet" stays.
- **The hard-requirement check comes first.** When no seller may be monitored, which is the case in production today, a requirement a market watch can't honour is checked before the switch, licence and capability gates. So the reason given is the stable one, and no paid lookup happens for a watch that could never be honoured. The live negatives couldn't show which gate won; now the audit says `market_unverifiable:sections`.
- **Event page vs listing.** A link with no listing id is the event page:
  - "I can't open Ticketmaster listings myself, so I haven't seen the one you sent" is not said for it;
  - the late-entry link reads "Here's the event page for …", not "Here's the listing".
- **One next step for a watch request.** If the budget is missing, the one question is "What's the most you'd pay in total for both, fees included?". Otherwise it's "Found seats you like? Send me the price, section and row…". The deadline and risk questions are dropped.
- **"My read" doesn't repeat the price.** The market lines already give the lowest price, its age and its basis. The read says only how that compares with the budget ("at that price, two come to $169.20 before fees, which leaves $330.80 of your $500 for fees…"), then the timing judgment.
- **The open sale for a watch request** is a place to look ("Event page on Ticketmaster"), not "that's where I'd buy". They asked to wait for a price.
- **Requirements as they said them.** Trailing punctuation is trimmed, so "will not work.." no longer appears. Sections come from their own words when no field carries them ("only sections 101 to 105").

## Tests

- **`price-watch-retest-expanded.test.ts` (12).** X01 to X10 as packaged, with two strengthened checks and two added X09 controls:
  - X09 also checks that the logged calls are at most 1;
  - X10 also checks that an entry-rule reason was audited;
  - control: retries still run when there's room;
  - control: no attempt when nothing is left today.
  - On `a80744b`, only X09 fails.
- **`price-watch-retest-live.test.ts` (5).** The L03 opening, the L03 follow-up, L01 (both turns) and L02, with the exact package messages, plus a control: a re-entry need is not answered as a late arrival.
- **Updated, wording only:**
  - `price-watch-qa-wave1` PW-31: an entry rule with a time is now answered by the late-entry reply, so the audit reason may be `unverifiable:entry_rule`.
  - `audit-0929`, `timing-advice`, `market-tracking`: "My read" no longer repeats the floor. Each test now asserts the floor appears once, in the market lines.
  - `research1-replay`, `research1-discovery`: "event page", not "listing".

## Not fixed or not verified

- **Concurrent quota.** Two overlapping evaluations of *different* watches each read the remaining allowance from the log. Each is capped, but together they can exceed the day's total by up to one operation's attempts each. The scheduler claim keeps a single watch from being read twice. A shared atomic reservation (an advisory lock or a counter row) isn't built.
- **Live happy path.** Still uncertified: staff and admin evidence, an active watch, a first read, approval and one recorded send. The test API doesn't expose watch rows or provider-call logs.
- **The model's reading of these phrasings.** The live replies use the production model's fields. Locally, the rules reader stands in for it, and the thread-text guards (`entryNeed`, `sectionsRequired`) hold whatever the model reads.
