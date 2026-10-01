# Research 1: adjacent-event decisions (R1-A01 to R1-A05)

The QA wave on Oct 1, 2026 ran against a local reconstruction of `2d051cd`. It covered a comedy club's cover and minimum, a Broadway lottery against a sure pair of seats, and a toddler's admission to a family show. All nine turns failed on usefulness.

These texts are rebuilt from the report, because `EXECUTED_PLAN.json`, the captures and the control harness weren't available here. Every case reproduced on current `main` before any change.

## Findings

| ID | Cause | Fix |
|---|---|---|
| **R1-A01** Comedy got the food-festival reply | `FOOD_DRINK` matched the bare phrase "food and drink", so "food and drink are extra" at a comedy club opened the food-festival Guide route. | A food-and-drink phrase is now an event only with an event noun ("food and wine festival"). The Guide route also skips requests read as comedy, theatre or sports. Concerts aren't excluded, because "festival" reads as a concert hint and the Brooklyn Wine Festival must still route as a food festival. |
| **R1-A02** Decision questions restarted discovery | Nothing answered them before event intake or search. | A new `decisionAnswer()` runs before any search. It handles three kinds of question, described below, and reads rules from what the customer sent rather than from venue keywords. |
| **R1-A03** "$100 total cap" became $9 | The budget reader only knew the cap word *before* the amount, so it fell back to the first price. | "$X (total / all-in / whole-night) cap / budget / limit" is now read as the cap. Normal budget wording is unchanged. |
| **R1-A04** "Two tickets or three?" was read as two | The question was read as a stated count. | An open choice of counts is not a quantity: it's stored as null, with `quantity_unclear`. The decision route stores the number of admissions only once it's decided (three at 25 months). The show name is kept as `eventName`. |
| **R1-A05** "Alternative" set a rock preference | The genre lexicon matched a bare "alternative". | It's now read as a genre only before a music word ("alternative rock", "alternative bands"); "alt-rock" still matches. `docs/LEXICON.md` is regenerated. |
| **Found here:** Research 2's evidence route took the Broadway question | It read "$50 tickets" as a 50-seat group, and "lottery for $50 … pair for $220" as a price rise. | A count after "$" is a price, not seats. The singles and group-total readings now need actual change wording ("from … to", an arrow, or an earlier and a later price). All the Research 2 replays still pass. |

## The three decisions

**A cover and a minimum.**
- The opening says "$48 covers entry for the two of you, not the whole night", and asks only for the item prices, with charges and tip.
- When the customer supplied a rule, its terms are said back as theirs: two qualifying items per person, and food or non-alcoholic drinks count. The link follows, with "I haven't checked it myself".
- With prices, the reply is "$84 total, $16 under your cap", showing $48 cover + four $9 items. It notes that those are supplied prices, not menu prices.

**A lottery.**
- Before the draw, a lottery is "a chance to buy, not a ticket", so it isn't counted as the plan.
- The sure option that meets the requirements is named: the adjacent pair at $220, leaving $20 of $240.
- After a win, the reply says winning doesn't settle seats together, citing the supplied terms when the customer sent them, and that the pair still fits.

**A toddler's admission.**
- At 23 months the answer depends on the arena, under the supplied rule or the common one. The reply asks one question, which arena and performance, because the city is already known.
- At 25 months the reply is three admissions, with "it doesn't mean a child discount".

## Tests (`tests/acceptance/research1-adjacent.test.ts`)

All 11 fail on `main` and pass here. Each paired control fails on `main` through its bug half; its working half passed there already.

- **Conversations.** Each of the three conversations runs both turns. Each of the three supplied-rule controls runs offline. Every reply is checked for:
  - the exact bold answer first, with one bold phrase;
  - no food template, intake form, "Got it", "on file for", or claim of a check, stock or action;
  - its stored brief (category, budget, quantity, event name) and service policy.
- **Paired intake controls.**
  - A food festival and a food-and-wine festival still route as food.
  - "Our total budget is $100" and "$300 total" still parse.
  - "We need three tickets" is still three.
  - "Alternative rock concerts" are still rock.
  - Separate-singles evidence questions still go to the evidence route.

## Not proven here

- **Production extractor.** These are rules-path replays. The production extractor's reading of these messages is untested; that needs a retest through the safe channel after deploy, which Research 2 owns.
- **Reconstructed wording.** The decision route matches patterns written against reconstructed texts. Other wording of the same question may not be recognised, and then the old path answers.
- **No live policy checks.** A supplied rule is never independently checked. Without one, the reply says what the decision depends on, which is common practice rather than a checked rule.
- **R1-M01 and R1-M02** are not reasserted or closed by this work.
