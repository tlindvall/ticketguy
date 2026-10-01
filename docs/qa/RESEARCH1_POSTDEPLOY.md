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
  - **Party change:** "With three new tickets to buy now, I'd take B: $240 in total, fees included." (reworded in the second wave below.)
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

## Second wave (build `1d4b2a4`): R1-M02-OWNERSHIP-REVERSAL-01 (P1)

All six exact deployed replies passed. A wider local test then found a P1: a customer who takes back a held ticket was still treated as holding it. The inputs are the package's `VARIATION_PLAN.json` cases, copied verbatim into the fixture under `ownership`.

**What failed.**
- The opening said one ticket was held and two new ones were needed, and correctly picked A.
- The correction said "Correction: I no longer have my ticket. All THREE of us now need new tickets."
- The reply still said "Offer A wins this one: $180 for the two new tickets … Your own ticket is already covered", leaving one person without admission.
- The stored quantity stayed at 2.

**Causes.**
- **"No longer have" missed.** "I no longer have my ticket" didn't match the reader for nothing held, so the earlier held ticket stood.
- **"Of us" missed.** "All THREE of us now need new tickets" didn't match the new-ticket reader, which knew "friends / people / guests" but not "of us".
- **Stale count.** With one ticket still held and three going, the purchase was worked out as 3 − 1 = 2.
- **Stored quantity.** The brief stored the purchase count only when a held count was above zero, so a held count of zero kept the stale quantity.

**Fixes.**
- **Corrections that take a held ticket back** now set the held count to zero:
  - "I no longer have / own my ticket";
  - "I don't have my ticket anymore / now";
  - "I sold / lost / returned / cancelled my ticket".

  "I don't have my ticket yet" is a delivery question and changes nothing.
- **The whole party buying.** "All N of us need new tickets", "everyone needs a new ticket" and "we all need tickets" mean nobody holds one, and the new-ticket count becomes the party. This applies only when a held ticket was on record. Otherwise "three of us need tickets" is just the party, as before.
- **Counts stay separate.** Party, held tickets, new tickets and bundle stock are still separate facts, and the latest statement of each wins.
- **Stored quantity.** The brief stores the purchase count whenever a held count or a new-ticket count is known, including zero.
- **Conflicting counts get one question.** When one message gives a party, a held count and a new-ticket count that don't add up ("four of us, I still have my own ticket, two friends need new tickets"), the reply is one question and no pick:
  - **Question:** "Does the other person already have a ticket, or do you need three new ones?"
  - **Stored:** quantity `null`, with `quantity_conflict`.
  - **Next message:** the answer stays on the same offers even if it doesn't mention them.
- **The reply names the change.** "Now that you don't have your own ticket, that's three to buy, so I'd take B: $240 in total, fees included. A only covers two of the three you need. It leaves $10 of your $250 budget."

**Writing.** A short bundle is now named once briefly in the lead ("A only covers two of the three new tickets you need"). Its own line still gives the full reason, so the reason is no longer stated twice in the lead and again in the list.

**Tests.** `research1-postdeploy.test.ts` has 5 new tests, 23 in total. All 6 Research 1 targets fail on `main`:
- **Correction pair:** the exact reversal pair gives B at $240 with $10 left, nothing held, and quantity 2 → 3. It fails on `main` on the bug itself.
- **Control pair:** the exact control pair gives the same answer. On `main` it fails only on the new wording; its logic passed there.
- **Live 02:** fails on `main` only on the new wording.
- **Corrections:** the paraphrases above clear the held ticket. "I don't have my ticket yet" and "I still have mine" keep it.
- **Conflict:** the conflict question gets no pick, and answering it ("The fourth person already has a ticket. We need two new tickets.") gets A at $180 on the same offers.
- **Consistent counts never ask:** both live 02 turns run without a question.

All six earlier live regressions are kept. Live 01 and 03 are unchanged; live 02's follow-up lead is reworded per the writing notes.

**Not proven here.**
- **Rules path only.** The production model's reading needs the capture-only live check of both corrections after deploy.
- **Unlisted wordings.** Other ways of taking a ticket back ("my ticket fell through", "I gave mine to my sister") aren't read.
- **Conflicts across messages.** The conflict check looks at one message. Counts that conflict across messages take the latest statement.
- **Comedy research.** The comedy reply still asks for menu prices: live policy and menu retrieval isn't built. Family replies still use generic wording rather than the show name.
