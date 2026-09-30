# Concert QA R9 fixes — 30 September 2026

Concert comparisons now judge the requested experience and admission conditions before price. A cheaper ticket to another show, a ticketless upgrade, or a product with unknown entry terms cannot win simply by costing less. Follow-ups revise the supplied offers before any calendar search runs.

Base: `main` at `6f958a51add676541fe8bb13e0f3a739b01ff58a`. No dependency, migration, deployment configuration, email-cap or test-mode changes.

## Findings and regression coverage

| Finding | Result covered by the tests |
| --- | --- |
| C-R9-01: different room/performance | Kiefer's Hall offer A costs $60 for two; the $40 separate DJ event is excluded for the requested performance. A room-access follow-up answers that question and includes the supplied event/FAQ links. |
| C-R9-02: quote follow-up becomes another event | Arrival and entry corrections stay in the comparison: B $80 at midnight, A $50 at 11:59pm, A $50 at 1am with the corrected 2am cutoff. Missing dates remain unconfirmed. |
| C-R9-03: package entitlement mistaken for stock | One admission per package is distinct from packages available. Two $90 packages buy two admissions for $180. Unknown entitlement clears the old admission-per-package claim. A two-admission package uses package units in the price calculation and explanation. |
| C-R9-04: short corrections lose other offers | `B's price only` and `C's corrected price` update the same records. B becomes $90 total for three with $10 left; C becomes $400, preserving admission and included fees, so B $320 wins the festival comparison. Explicitly abandoning the comparison clears the old offers. |
| C-R9-05: artist appearance and changed goal | Each offer's appearance is evaluated separately. The $180 live-artist offer qualifies for that goal; a deliberate change to the DJ party selects $60 with $20 left. A new supplied confirmation of the named artist replaces the old absence; a DJ's appearance does not confirm the requested artist. |
| C-R9-06: guardian and ID rules | Guardian requirements, age thresholds and ID are separate. A school ID cannot satisfy a government-ID requirement. An ID correction preserves the age/guardian terms. Under-16 accompaniment does not apply to the supplied 16-year-old attendees. Explicit prohibition is never permission. The youngest attendee must qualify; a corrected attendee-age statement replaces earlier ages, while policy thresholds never set the attendees’ ages. |
| C-R9-07: one ticketless add-on | A single merchandise offer gets a direct no-admission answer. “Must already hold a separate show ticket” remains an exclusion. No second quote or date search is needed. |
| C-R9-08: global included-fees wording | “Quotes including fees” applies to the quoted list; an offer's explicit before-fees exception wins. Price-only revisions retain the other quoted fee terms. |
| C-R9-09: source prices become user constraints | Post-extractor guards use the stated party and explicit cap. The Kiefer page's $33.33 price does not become a budget or reduce two adults to one ticket. |

## Email experience

- The answer and party total lead the reply; the HTML makes that sentence bold.
- Offer names and dollar amounts are bold within the comparison bullets.
- Links explain their purpose and domain: event page, venue FAQ or venue page the customer sent. They are references, not invented checkout links or claims of fetched verification.
- Removed the automatic instruction to disregard an earlier comparison; the word “correction” alone does not prove Ticket Guy gave bad advice.
- Supplied policies and artist statements remain conditional. Unknown ID, entry boundary and admission conditions lead to a specific check rather than an unrelated search.

The copy is still structured and somewhat repetitive. These changes improve usefulness and scanning; a wider voice rewrite should be evaluated separately against the same factual assertions.

## Validation method

`tests/fixtures/qa-concert-r9.json` contains the exact 23 audit conversations and 50 customer turns, without audit email addresses, credentials or production responses. The acceptance suite processes all 50 through intake, disposable PGlite, outbox handling, revision storage and email rendering. It also processes 48 turns from 22 conversations using a model stub that deliberately returns the wrong party size, a source price as budget and an unrelated artist. The similar-pop discovery control uses synthetic catalog entries and the fixture extractor.

These are local regression tests, with no external provider calls or sent emails. They establish the deterministic safeguards and rendered content, not the production model's full interpretation, a seller's actual inventory, live checkout totals, source-page freshness or Gmail rendering.

Commands: `pnpm check`, `pnpm registry:build`, production build, and the CI PostgreSQL project. The registry must remain unchanged. Local PostgreSQL tests require a disposable server; CI provides PostgreSQL 18. The local default Turbopack build cannot open its worker port under this host's sandbox; the Webpack build is an additional local check. CI runs the normal production build.

## After merge and deployment

Use the authenticated test inbox with a fresh run ID, not customer email. Replay cases 08, 10, 11, 13, 14, 16, 19, 20, 22 and 23 with their follow-ups. Check stored party/cap, exclusions and source links as well as the picked offer. Then expand to new wording, new performers and venues, contradictory copied policies, and unfamiliar ticket packages. Keep availability and policy verification separate from reasoning over customer-supplied terms.
