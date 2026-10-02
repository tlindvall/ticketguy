# Final human QA (Oct 2, 2026, real Gmail, build `dadd21f`): the Research1 items (Rangers and Hamilton)

The package covers four real buyer journeys: 9 customer emails, 8 replies, and 11 bug items. This change covers the three Research1 items (R1-HUMAN-01 to 03). The eight concert items (HF-C-01 to 08: Metallica and jigitz) are in #88, from the other session, and are not duplicated here.

Exact inputs are replayed in `tests/acceptance/final-human-qa.test.ts`, plus `market-tracking.test.ts` for Rangers and `manual-attention.test.ts` for the hand-off.

| ID | Status | Cause | Fix | Validation |
|---|---|---|---|---|
| **R1-HUMAN-01** Rangers listing link → "needs a manual check" | **Fixed (root cause found)** | The SeatData call reservation (`reserve()`, from #83) bound a JavaScript `Date` into raw SQL. Production's postgres.js driver rejects that, while the embedded test database accepts it. #87 made every StubHub/Vivid listing link run that reservation, so research threw on all four attempts, was dead-lettered and went to staff. Every paid listings read in production had the same crash: cheaper-seat reads for screenshots and price-watch checks too. | <ul><li>ISO strings cast to `timestamptz`. Checked against a real Postgres 16 with postgres.js: three reservations, then refused at the cap.</li><li>The test database now **rejects raw Date parameters** the way production does, so the suite catches this class of bug.</li><li>A failed reservation, or a failed market refresh, costs the reply its market lines, never the reply (`market.read_failed` audit).</li></ul> | <ul><li>With the guard, the bug reproduced in four existing tests; they pass with the fix.</li><li>Exact Rangers text and URL: matched and unmatched listing ids both answered, never manual_attention.</li><li>A throwing market fetch still yields a reply.</li></ul> |
| **R1-HUMAN-03** follow-up after hand-off unanswered | **Fixed** | The follow-up's research crashed the same way. Its hand-off was then skipped (the request was already `manual_attention`) or its holding reply was deduped. | <ul><li>A newer message on a handed-off request gets its own short reply ("Got your follow-up. It's with the same person…"), keyed to that message, plus its own staff alert.</li><li>At most one such reply a day; every message still alerts staff.</li><li>The holding reply now says when the team checks ("9am to 9pm ET"), not a promised reply time.</li></ul> | <ul><li>A dead-lettered follow-up is acknowledged once.</li><li>A replayed dead event isn't acknowledged twice.</li><li>A clarification-limit follow-up is acknowledged; a third the same day is not.</li></ul> |
| **R1-HUMAN-02** Hamilton "no scheduled event" | **Fixed in mechanism; cause unconfirmed** | Production's catalog wasn't inspected. Our Discovery search asked for 20 results sorted by date and recorded itself as covering its whole window, even when the page ran out. "Hamilton" also matches other events (another artist, a township), so a page can fill before Sunday, and the next search for Sunday was skipped as "fresh". | <ul><li>A full page records only the dates it reached.</li><li>Event lookup asks for 100 results.</li><li>A miss on a cached search re-asks once, fresh.</li><li>The no-result line now says what was searched ("I searched Ticketmaster's listings and couldn't find a Hamilton performance… not proof there isn't one"), never "no scheduled event".</li></ul> | <ul><li>Stand-in Discovery API with a flooded page.</li><li>Truncation recorded.</li><li>An old whole-window record is re-asked.</li><li>A touring Hamilton elsewhere doesn't take the New York matinee.</li><li>A genuinely empty day gets the honest line.</li></ul> |

## SeatData listing ids (the open question behind #87)

SeatData's SDK 1.2 (`seatdata-sdk` on PyPI, read for this change):
- **Sales rows** carry `source` `"sh"` with an integer `listing_id`, or `"vs"` with a string one.
- **The listings endpoint** is `GET /api/v0.1.1/listings/get` and accepts `event_id_sh`, a **StubHub event id**. That suggests SeatData keys StubHub data by StubHub's own ids. The listing row's shape is still undocumented.
- **The probe:** `scripts/probe-seatdata-link.ts "<StubHub listing link>"` makes one paid read by the link's StubHub event id. It prints whether the link's `listingId` is among the rows and, for a match, that row's section, row and price to compare with the page.
- **Not run here:** there's no SeatData key in this environment, and the docs site is blocked from it.

## Not verified
- Production's Hamilton catalog rows.
- SeatData id equivalence (run the probe).
- Gmail rendering.
