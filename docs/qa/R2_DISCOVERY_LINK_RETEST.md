# Research 2: discovery and ticket-link retest (Oct 1, 2026, deployed `a80744b`)

The retest ran three conversations on the deployed build (two turns each, capture-only, six replies). Results:
- **C01 Los Angeles:** failed.
- **C02 Brooklyn:** failed.
- **C03 Nashville:** partial.

It also ran local checks on the same build: 48 targeted regressions all passed, and 15 of 19 broader checks passed.

The exact six turns are in `tests/fixtures/r2-discovery-retest-2026-10-01.json` and replay in `tests/acceptance/r2-discovery-retest.test.ts`. The package's broader local cases (`local/discovery-independent.test.ts`) and route matrix (`local/redirect-independent.test.ts`) are ported there and in `tests/acceptance/r2-link-retest.test.ts`. On `a80744b` they fail as the package found:
- 6 discovery tests: all three exact conversations, plus the LA, Nashville and Brooklyn local cases;
- the route matrix, on its expiry and destination rows.

They all pass here. This is a rules-path replay with the fixture extractor and a synthetic catalog. It does not show that the production model reads the same way, though the deterministic guards below run after either extractor.

## Per item

| ID | Bug or capability | Cause | Implementation | Validation |
|---|---|---|---|---|
| **R2-CONCERT-AGE-01** (P1) | Bug | Nothing compared a listing's own "21+" with the group's ages, so Dusky (21+) went to the late-entry reply as a candidate for a group with a 20-year-old. | <ul><li>`listedMinAge` reads an age only from the listing's own title ("21+", "18 and Over"), never from the venue.</li><li>`partyAgeLimits` reads the group's ages ("I am 24 and my friend is 20") and their own rule ("no 21+ nights").</li><li>A ruled-out listing is dropped in discovery before any pick, link or late-entry reply.</li><li>The reply leads with it: "Dusky is out: it's listed as 21+, and your friend is 20."</li><li>When the group has an age rule, the reply says the chosen night's age status: "Minimum age: unknown. The event page doesn't list one, and nothing I have states Brooklyn Basement's age policy…"</li></ul> | <ul><li>C02, both turns.</li><li>All-24 control: Dusky is kept.</li><li>18+ listing for a 20-year-old: kept.</li><li>Unknown minimum age stays unknown.</li></ul> |
| **NW-02-SKIP** (P1) | Bug | The exclusion cues in `eventConstraints` had no "skip", "leave out" or "don't include", so "Skip Constellation Room" made it the venue to search. | Those cues, plus "drop" and "rule out", join the existing NW-02 list. The same family, not a new parser. | <ul><li>C01 follow-up.</li><li>Five phrasings (skip, leave out, don't include, avoid, no).</li><li>"Only at Constellation Room" is still a venue rule.</li><li>The package's Santa Ana-is-fine control.</li></ul> |
| **R2-CONCERT-BUDGET-01** (P1) | Bug | The extractor read $300. Then the concert guard (`concertBudget`) replaced it, because "$300 TOTAL including fees" with no "for both" wasn't one of its shapes. | That shape now counts, in a sentence that names no offer, listing, seller, section or row. | <ul><li>C01 saves 2 / 30000 / whole_party on both turns.</li><li>C03 keeps 6 / 60000.</li><li>An under-$250 cap is kept.</li><li>"Listed on StubHub at $300 total. Is that a good price?" sets no cap.</li></ul> |
| **R2-CONCERT-PREFERENCE-01** (P2) | Bug | "Prefer Elsewhere or Nowadays, but another Brooklyn venue is fine" put both in `venueTerms`, so the search was fenced to them. | A venue named with prefer, ideally, "if possible", "such as", "or similar" or "another … venue is fine" is a starting point, not a fence. "Only" still fences. | <ul><li>C02 finds Night Shift at Brooklyn Basement.</li><li>"Elsewhere only" control: Night Shift is not offered.</li><li>Unit checks on `eventConstraints`.</li></ul> |
| **R2-CONCERT-GEO-01** (P2, local) | Bug | Only Orange County could be ruled out (`OUTER_LA_RULED_OUT`, an LA-only rule), so "Nashville only, not Franklin" still offered Franklin. | `citiesRuledOut` is generic: a city they negate ("not Franklin", "No Franklin", "not Anaheim or Santa Ana", "don't want to travel to …"). It applies only among the cities the candidate venues are actually in, never the city being searched. A later "Franklin is fine" lets it back, and the latest message wins. There are no town-specific rules. | <ul><li>C03, both turns.</li><li>The package's Nashville case.</li><li>Franklin-allowed control.</li><li>"I'm not in Nashville until Friday" excludes nothing.</li></ul> |
| **R2-EMAIL-HIERARCHY-01 / R1-DISCOVERY-CLOSURE-01** (P2) | Bug (count, choice) and writing | `requestedCount` allowed one adjective and no "links" or "artists", so "one or two official event links" got three options. The choice question missed "which you would choose". The no-fit closer re-asked for dates and genre they'd already given. Provider titles were copied whole. | <ul><li>Requested count: up to three describing words, plus links, listings, artists and nights.</li><li>The choice question also reads "which you would choose", "choose for us" and "which option would you choose".</li><li>When one candidate is closer, the next step offers to check it: "Want me to check … for QA Nashville Country? Reply and I will, or name the other one." A tie is said as a tie.</li><li>After hard dates and a genre, the no-fit closer is "That's everything I have on file for … that night. If the night or the area can change, tell me what…".</li><li>`readableTitle` turns all-caps titles into title case and drops "featuring …" rosters; the full billing stays on the event page.</li></ul> | <ul><li>C01 and C03 show two options and answer the choice.</li><li>Readable-title unit checks.</li><li>The existing browse tests keep the generic closer where no genre or date was given.</li></ul> |
| **R2-LINK-STALE-01** (P2, local) | Bug | `linkDecision` checked observation freshness and lifecycle, not the recommendation's `expiresAt`. | An expired recommendation now stops the link (`advice_expired`, with its own page). "At the limit" counts as past it. The check comes after the price-freshness check, because a stale price is the more specific reason. | <ul><li>Route matrix: expired advice with a fresh observation is gated.</li><li>The expiry boundary is gated.</li><li>One minute left still redirects.</li><li>Withdrawn, replaced, stale-source and lifecycle rows are unchanged.</li><li>Reference, legacy and current-page behaviour is unchanged.</li></ul> |
| **R2-LINK-CONTEXT-01** (P2, local defense gap) | Defense gap (no production misroute observed) | A stored buy link whose URL was changed to another artist's page still redirected when the event and advice ids matched. | A buy link's destination must be one stored with the advice's own chosen observation: that offer's `directPurchaseUrl` or its `affiliateUrl`. Anything else is `destination_mismatch`. That page offers no onward link, and `?current=1` doesn't bypass it. Identity is never read from URL words. A legitimate affiliate wrapper stored with the offer still works. | <ul><li>Route matrix: the mismatched URL is gated.</li><li>The mismatched URL with `?current=1` is gated.</li><li>An affiliate wrapper still redirects.</li><li>The changed-request-event row is unchanged.</li></ul> |

## Also in this change

- **The late-entry reply** opens with the age lead when discovery dropped a listing on age. With a cap, it says "The total for two isn't checked yet; your limit is $120 including fees."
- **The single-pick note** ("I've left out Constellation Room…") already goes in the acknowledgement email before research. That still holds.

## Missing data capabilities (not bugs)

- **No venue age or entry policy data.** Nothing on file states a venue's age or late-entry policy for a night, so those stay "unknown". No policy page or contact is offered, because none has been verified. The RA directory is a place to look, not proof.
- **No live seats, adjacency or all-in totals for discovery candidates.** They stay "not checked yet". A tentative choice rests only on what's listed (the genre label), never on seats or price.
- **Checkout identity and affiliate attribution are not tested.** The destination guard compares stored URLs. It doesn't open the seller page.

## Still unverified

- How the production model reads these phrasings (the guards run after it, but its fields aren't replayed).
- Gmail and mobile rendering.
- Real-provider sender headers.
- Production redirects.
- A live retest of C01 to C03 on the new build.
