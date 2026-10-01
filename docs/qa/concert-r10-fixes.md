# Concert R10 remediation

Base: `main` at `c3237ff` (includes PR63 sports changes and its bounded alternative event lookup). No migrations, email-cap changes, provider changes or real email sends.

## Behavior

Unusable quoted offers are rejected before price ranking. The comparison now retains supplied availability, permitted festival days, mandatory view and original-purchaser collection/transfer restrictions independently of price. Corrections update those facts without silently reopening unrelated restrictions. Supplied facts remain explicitly unverified; they do not become checked inventory.

| R10 case | Result on supplied terms |
| --- | --- |
| 24 | One $90 package admits two. A third attendee cannot be covered by invented stock. No $180 basket is displayed as buyable. |
| 25–27 | Mixed ages and a correction are retained. School ID qualifies when the policy allows government OR school ID. AND is not treated as OR. An under18 guardian prohibition remains binding. |
| 28–29 | Original-artist performance and DJ attendance stay separate. Live-concert wording qualifies B; latest artist/party goal and budget win. |
| 30 | Explicit before-fees exception beats shared all-in wording. A $20-per-ticket fee is added once: A $140 with stated charges, B $130. Remaining unstated fees are not invented. |
| 31 | Sold-out A cannot win. When B also sells out, neither is actionable. Explicit reopened-stock corrections work. |
| 32 | The existing adjacency rejection remains passing. |
| 33 | B's immediate transfer meets the supplied performance timing; A's 11pm delivery misses the 8pm start. A buyer guarantee cannot make a missed show safe to attend. |
| 34 | A restricted view cannot satisfy mandatory full view. Unknown view is not confirmed as full view; an explicit relaxed requirement is retained. |
| 35 | Friday-only admission cannot satisfy Saturday. Replacement validity can remove an obsolete exclusion. |
| 36 | A sole $90 package including two admissions initially wins. A clear reference to that bundle changing to merch-only retains B's $120 regular pair. Two packages including two admissions in total do not manufacture four admissions. |
| 37 | Strictly-before 11pm excludes 11pm and 11:30pm; an earlier 10:30pm arrival on the stated date enables A. Missing overnight dates remain unknown. |
| 38 | Incompatible observed quantities/zones/fee bases get a direct comparability answer, not a calendar. $110 × 5 = $550 and $50 budget room are arithmetic from supplied quotes, not a market forecast. Other quantities and decimal prices are covered. Comparable snapshots stay on the existing market-data path. |
| 41 | Nontransferable tickets and collection requiring an absent original purchaser cannot win as a resale bargain. Transfer permission alone does not erase a separate collection condition. |

Cases39/40 were prepared national discovery probes, not reproduced bugs in the self-review. This change does not claim to verify their live genre coverage, prices or inventory.

## Queue recovery

The three saved live R10 test requests were reconciled by read-only GET after the PR63 deploy (`dep-daupvm60tbcc73c805c0`, commit2aad219). All are now settled with one recorded reply each. No run was cancelled and no duplicate message was submitted. The earlier exact hung await was not proven; the unbounded alternative lookup fixed by PR63 is a plausible explanation, not a confirmed production trace.

A new concert regression forces a venue mismatch and asserts that resolution stops after one alternative lookup. The operations screen also counts leased work, expired leases and the oldest unfinished row. A stuck leased row no longer disappears from the pending-only counters. This is visibility; it does not add an unsafe timeout race or pretend all dispatcher failure modes are solved.

## Verification

- Exact 16 R10 conversations / 25 customer turns replayed twice: fixture extraction and a hostile model stub misreading artist, quantity and budget. 66 assertions check decisions, retained facts, useful direct replies and bold HTML. The stub is not a real production-model test.
- 34 semantic/arithmetic/negation controls, one bounded concert lookup test, and one expired-lease visibility test. The old R9 and sports replay assertions remain in the full suite.
- Local full check: 1017 passed, 7 PostgreSQL-only tests skipped pending CI's disposable PostgreSQL18. Typecheck and lint pass; the existing eslint config warning remains.
- Local production Webpack build passed. The final branch also includes the latest homepage change; CI verifies PostgreSQL18 and the normal production build on that combined head.

Evidence: `ticket-guy/qa/concert-r10-remediation-2026-09-30/`. `BEFORE_AFTER.html` shows captured reply text for all25 turns; before uses main2aad219 before the unrelated homepage update, after uses the proposed changes. Evidence is synthetic unless explicitly marked live GET reconciliation. No live claim is made for the new concert code before merge/deploy and a test-mode replay.

## Email wording

The selected offer and total remain bold. When a cheaper concert offer is unusable, the lead now explains why to skip it; the details retain its specific restriction. Fee corrections show each component and distinguish missing fees. Policy answers qualify their source once rather than asking again about IDs already supplied. Trend answers explain what comparable history needs and avoid invented ranges. Existing descriptive HTTPS source links are retained; no checkout URL or affiliate coverage is fabricated.
