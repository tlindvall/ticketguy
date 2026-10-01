# Research 1: post-deploy retest (Oct 1, 2026, build `a173486`)

The retest ran the exact customer messages against the deployed build. All three live openings picked the right offer, but all three follow-ups ignored what had changed. The local comedy and lottery turns also dropped facts the customer had supplied.

The inputs are the package's own, copied verbatim into `tests/fixtures/r1-deployed-regression-2026-10-01.json`:
- `scenario-plan.json`: the three live pairs.
- `EXECUTED_PLAN.json`: the local openings, follow-ups and supplied-rule controls.
- `WORDING_ISOLATION_CONTROLS.json`: the ten exact and equivalent phrasings.

Every failure reproduced on `main` before any change.

## Findings

| ID | Cause | Fix |
|---|---|---|
| **R1-M02** The held ticket was lost, so "neither bundle fits four" | The held-ticket reader knew "my own ticket" but not "I already own my concert ticket" or "my already-owned ticket". It also missed "THREE friends who each need a new ticket". With nothing held, the party of four became the purchase. | Those phrasings are now read, along with "I already have mine". The purchase is the new tickets: A for two ($70 left), then B for three ($10 left). Skip A, because it would leave one person out. The stored quantity goes 2 → 3. |
| **R1-PREF-01** A later preference was ignored | "I prefer the lower tier when it fits my budget", "lower-tier preference" and "enough to pay the difference" weren't read as priorities. The earlier "keeping the spend down" stayed current. | All three are a feature priority, and the latest message that states one wins. A preference that depends on the cap acts once the new cap lets it fit. |
| **R1-A02-MINIMUM** The supplied comedy rule disappeared | The minimum rule knew "per person" but not "per attendee". "It does not require two alcoholic drinks" sat in the next sentence, which wasn't read as part of the rule. | "Per attendee / guest / head" counts. A rule now includes the sentences after its source sentence in the same paragraph, until one of the customer's own facts ("we", "our"). |
| **R1-A02-LOTTERY** The win, the quote and the terms were misread | "I have now won" wasn't read as a win, and neither was "I've just won". "Two actual adjacent seats … for $220 TOTAL" didn't match an option, because options had to start with "a" or "the". "Even winning does not guarantee adjacent seats" came after the source sentence, so it was never read. | All three are now read. The $220 pair, with $20 left, appears in the opening and after the win. The win is acknowledged, and seats together are still called unconfirmed. "I need two seats together" and "cannot accept separated seats" count as the requirement. |

## Writing (`USEFUL_REPLY_STANDARD.md`)

- **Changed picks explain the change.** A follow-up compares the customer's terms before and after their latest message.
  - **Party change:** "With one more new ticket to buy, B is the one: $240 for the three new tickets."
  - **Preference change:** "Since you'd now pay more for the lower tier, I'd choose B: $285 for both … $45 more than Offer A. It leaves $15 of your $300 budget."
  - **Cap change:** "With your budget now $250, the lower tier fits, so I'd choose B: … $50 more than Offer A, the other usable option."
  - **Cap too small:** when the cap still doesn't fit the preferred tier, no change is claimed.
- **The delivery reminder is gone.** "Before you buy, check its delivery time on the listing" was appended to every supplied-quote pick. When the customer gave a deadline, it's already checked against each offer. Without one, it's a task the comparison doesn't need.
- **Uncertainty is named once.** The lottery reply with supplied terms now has one status line: "Here are the lottery terms you sent: … This rests on them and your quotes; I haven't checked the terms or availability myself." It used to have two caveats.
- **The comedy reply says what's missing.** "What's missing is the price of those four items", not a generic request for prices.

## Tests (`tests/acceptance/research1-postdeploy.test.ts`, 18)

14 tests fail on `main` and pass here. The other 4 also pass on `main`, which is correct, because they check behaviour that must not change:
- an unclear held ticket isn't guessed;
- the comedy $48 / $84 replies are kept;
- lottery terms without an adjacency clause say nothing about adjacency;
- the family admission answers are kept.

- **Live pairs, exact messages.** Each pair checks the full lead of both turns, the stored quantity, and the absence of the delivery line, a view claim, a stock claim or "Got it".
  - 01: A, then B with the change explained, $50 more and $10 left. C is still excluded.
  - 02: two new tickets, then three, never four.
  - 03: saving-first picks A. The changed preference picks B, and "keeping the spend down" is not repeated.
- **Package wording controls.** Each exact phrasing and its equivalent now give the same fact: `toBuy`, `priority`, the rule, the win and the $220 quote.
- **Negative controls.**
  - A ticket for the wrong date, or one not yet owned, is not a held ticket.
  - "One of us might already have a ticket" stays the party of three, with no held ticket guessed.
  - "The lower tier isn't worth the difference" is not a feature priority.
  - **Too small a budget:** at a $280 cap, B ($285) is $5 over and A stays the pick.
  - **Four new admissions:** with five going, against two- and three-admission bundles, the reply is "None of the two meets all your requirements", and the three-admission bundle "would leave one person out".
  - **Comedy:** without a rule the general line stays, and a customer's own sentence after the rule isn't read as part of it.
  - **Lottery:** a quote not described as together never meets the requirement and isn't called the plan. Unwon paraphrases stay "not the plan".
- **Preserved.** The comedy $84 / $16 follow-up, and the family 23- and 25-month answers with the FAQ link.

## Not proven here

- **Production model.** These are rules-path replays, with the fixture extractor and drafter in enforce mode. The deployed build's model extraction of these messages is untested, so the live pairs need a retest through the safe channel after deploy.
- **Pattern-based reading.** These readers are still patterns. They now cover the exact package wording and the paraphrases above, but other wording may not be read:
  - "my ticket's sorted";
  - "the lower tier is worth it now";
  - a lottery quote with more than about 45 characters between the seats and the price.
- **No stated reversal.** A message that drops a preference without stating a new one ("the lower tier isn't worth it") leaves the earlier priority in place.
- **The change lead.** It compares this message with the thread before it, read the same way. The budget is compared only when the customer's concert wording gives it on both turns.
- **New attachment rule.** A supplied rule now includes the sentences after its source sentence. Such a sentence is excluded when it has a first-person word. A rule paragraph that mixes in the customer's facts without "I / we / our" could still be read as rule text.
- **No policy checks.** A supplied rule is never independently checked, and nothing here is live stock or a fetched policy.
- **Rendering.** Gmail and mobile rendering weren't checked.
