# Research 1 QA: goal changes and follow-up memory — R1-M01 and R1-M02

The QA run (Sep 30, 2026, build `149a80f`) found two P1 recommendation failures on customer-supplied quotes. This note records the causes, the fixes and what is still not proven.

**Inputs.**
- I had the report as pasted text.
- `scenario-plan.json`, `raw/`, `BUGS.json` and the captured HTML were not available here. The messages in `tests/acceptance/research1-memory.test.ts` are rebuilt from the report's descriptions.
- Both failures reproduced on current `main` with those texts, before any change.

## R1-M01: an upgrade without admission was recommended as concert tickets

**Causes.**
- **Exclusion not read.** `admissionTerms` read exclusions such as "concert *tickets* not included", but not "concert *admission* is explicitly NOT included" or "separate concert tickets *are* required". C's own words then matched the inclusion pattern ("concert admission"), so C became `admission: included`.
- **Wrong product type.** "Upgrades" (plural) didn't match the upgrade pattern, so C was typed `productKind: admission`.
- **Budget update ignored.** "Our budget is now $250" wasn't read as the new cap.
- **Priority missed.** "Lower-tier seats matter most" wasn't read as a priority, and neither was the hyphenated "lower-tier" as an offer's tier.
- **Price reading.** "Two adjacent seats, $190 all-in" was read as $190 each.

**Fixes.**
- **Exclusions.**
  - Any of "admission / entry / tickets … (explicitly) NOT included / excluded", "excluding admission", and "separate … tickets are required / needed" excludes admission. The exclusion is read per offer, within that offer's own text.
  - An offer that excludes admission is never typed as admission. "Upgrades", "lounge access" and "lounge passes" are typed as upgrades.
  - "Entry is included" counts as included, and hyphenated tiers ("lower-tier") are read as seats.
- **Comparison.**
  - A cheaper add-on is explained for what it is: "Skip C: it's an upgrade with no concert admission, so its $100 doesn't get either of you into the show."
  - An offer whose admission is unknown is told to confirm first, not skipped.
- **Price reading.** A count of seats followed by "$X all-in", with no per-ticket word anywhere in the offer, is that block's all-in price.
- **Follow-up turn.**
  - "Budget is now $250" is the new cap.
  - "Lower-tier seats matter most" is a priority.
  - The priority pick says how much budget is left.

## R1-M02: tickets already held, and how many each bundle admits

**Causes.**
- **Party size used as purchase count.** The party size was used as the number of tickets to buy, so an already-held ticket was never subtracted.
- **Bundle size dropped.** "A fixed bundle of two … admissions for $180" kept neither the bundle's size nor its stock. With a package's count unknown, $180 was multiplied per person.
- **Stored quantity.** The stored brief recorded the party (3 → 4) rather than the purchase (2 → 3).

**Fixes.**
- **Party reading.** `partyTerms` now reads tickets already held: "I already have my own ticket", "we already have two tickets", "I don't own any tickets yet". It also reads the new admissions needed, either said outright ("three friends now need new tickets") or as the party less what's held. A message that restates the party without a new count derives it again.
- **Purchase count.** The comparison and the supplied-offer path use the new-ticket count.
  - The reply says "for the three new tickets", never "for all four".
  - It says once: "Your own ticket is already covered."
  - The stored brief's quantity is the purchase count.
- **Fixed bundles.** "A bundle of N … admissions" with "fixed", "exactly N available" or "no partial purchase" is one basket of N admissions. "No partial purchase" means it can't be split. A basket short of the party is rejected before price ranking: "Skip A: it has only two admissions, and you need three new ones, so it would leave one person out."
- **Unknown capacity.** A bundle that doesn't say how many it admits keeps its quoted price as the bundle's price and covers nobody. It is never multiplied.

## Controls (`tests/acceptance/research1-memory.test.ts`, 14 cases: the original 13 fail on `main`, all 14 pass here)

- **R1-M01 replay.** The opening gives A at $190 with $10 left, and C skipped as an upgrade. The stopped $250-cap follow-up gives B for the lower tier: $50 more than A, $10 left, and C still excluded. That follow-up is the first run of this path.
- **Negation controls.** Five phrasings: "NOT included", "explicitly NOT included", "does not include admission", "admission sold separately", and "separate tickets are required". Each gives excluded, not typed as admission, and never the pick.
- **Positive control.** A VIP package that includes two concert admissions stays eligible, and wins when it's cheaper.
- **Unknown admission.** It stays unknown ("confirm first", not "skip"), and unknown adjacency isn't called together.
- **Owned-ticket wording.** "I bought a ticket for the wrong date" is not a held ticket; "I already bought my ticket" is.
- **R1-M02 replay.** Both turns, and the stored quantity 2 → 3.
- **Isolation.**
  - Capacity: the same bundles, three needed, nothing held → A fails and B fits.
  - Owned count: ordinary two- and three-ticket quotes with one ticket already held → two to buy.
  - Four new tickets against two- and three-admission bundles → a useful no, with no invented stock.
  - Unknown capacity → covers nobody, and is never multiplied.
- **Existing controls.** The R10/R11 package controls (admissions per unit, units available, totals across packages, partial purchase) still pass unchanged.

**Isolation caveat.** On `main`, several controls also fail because "$X all-in" after a seat count was read per ticket. Each control isolates its own fact here, but its failure on `main` isn't proof of that fact alone.

## Also fixed: opt-out dates followed the real clock

The "Yes, that's recorded (since Sep 30)" replies read the suppression's database timestamp, while the pipeline runs on its own clock. Tests pin that clock, so three replay tests started failing on `main` once the real date passed Sep 30 in New York. The suppression helpers now take the pipeline's clock.

In production both clocks are real time, so customers weren't affected. CI on any PR, including #68, would have failed from Oct 1 without this.

## Not proven here

- **Reconstructed texts.** The parser is regex-based. Other wording of the same facts ("my ticket's sorted", "a three-pack") may not be recognised.
- **Production model.** These are rules-path replays. The production model's extraction wasn't exercised, and the deployed build needs a live replay of both conversations.
- **New wording.** The "N seats, $X all-in" block-total reading is a new interpretation. It applies only when no per-ticket word appears in the offer, but a customer who meant per ticket without saying so would now be read as giving a total.
- **Rendering and links.** Gmail and mobile rendering weren't checked. These fixtures have no seller URLs, so no links were added.
