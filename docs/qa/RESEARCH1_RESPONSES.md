# Research 1: useful advice and email responses — reconciliation and fixes

The Research 1 preparation (Sep 30, 2026) scored six emails captured from build `2aad219`: Austin, Brooklyn and LA, two turns each. It listed four families, NW-01 to NW-04, and ten response rules. This note records what current code already did, what changed here, and what is still not proven.

**Inputs.**
- I had `START_HERE.md` as pasted text.
- `TEST_CASES.json`, the captured HTML/text and Research 2's latest results were not available in this session.
- The eight cases in `tests/acceptance/research1-replay.test.ts` are therefore reconstructed from the brief, on a synthetic catalog (`tests/acceptance/r1-research.harness.ts`) with the clock fixed at Sep 30, 2026, so the historical dates replay as written.
- When `TEST_CASES.json` arrives, its exact texts should replace the reconstructed ones.

## Reconciliation

| Family | Case | On `main` before this change (rules path) | Now |
|---|---|---|---|
| NW-01 | Brooklyn (midnight arrival, 10:30pm start) | Opening: "still on general sale on Ticketmaster, and that's where I'd buy". The follow-up moved the request to Sat Oct 3 and never answered the entry question. | Both turns open with **Midnight entry is unverified**: a start time isn't a last-entry time. The event is offered as a candidate, with one next step. "Did you check Saturday?" is answered for the same performer, and the request stays on Friday. |
| NW-02 | LA correction (excluded venue) | **Already fixed**: the R8 exclusion parsing drops the excluded venue. Still open: the opening offered Santa Ana's Constellation Room as "Los Angeles". | "Los Angeles" prefers the city itself. A venue elsewhere in the metro is shown, with its own city named, only when the city has fewer than two options. After "that's Santa Ana, not LA", only the city. |
| NW-03 | Austin (country or Americana, Fri or Sat, $150 for two) | The rules reader didn't know Austin and searched New York. Only Friday was read. On a genre miss, browse fell back to every other genre. "Not rock or pop" was read as asking for rock. | Any known market city is read, and "Oct 9 or Oct 10" is both days. A genre with nothing on is a useful no: said as coverage ("not proof that nothing suitable is on"), with no other genres unless the customer allowed them. The budget is carried, and the one next step is the show on the other date they gave. Negated genres are ignored. |
| NW-04 | LA (reserved seats together, $300 for two) | A generic "my three picks" list. The $300 cap was dropped (the concert cap reader didn't accept "$300 total for both"), and seat requirements weren't stated. | The opening line says what isn't established: reserved seats, together, $300 all-in. Candidates are listed as "two I can check for you", not picks, and the one next step is "Tell me which one appeals, and I'll check it against those." |
| R1-04 | Supplied quotes, preference-sensitive | Both quotes were rejected as "admission unverified": a seat wasn't read as admission. | **I'd take A for you** when spending less matters; **I'd take B** when the lower tier matters, naming the $45 premium. "That's based on your quotes; I haven't verified availability or the view." |
| R1-05 | No fit, then relaxation | The no-fit answer was obscured by the admission flags. The follow-up "we could stretch to $350" lost the offers and answered about an unrelated event. | "None of the two meets all your requirements. The smallest change: if you can stretch to $340…". The relaxation is applied to the same offers: B fits, leaving $10 of $350. |

All eight cases fail on `main` (checked in a clean worktree) and pass here. Some of those failures are wording the cases now expect; the table above gives the behavior that actually differed.

## Controls

- **Broaden only with permission.** With "anything else is fine", other genres are shown and the reply says why. Without it, they are not.
- **Last entry, independent of start.** "Last entry is 1am" means midnight fits the quoted terms, said as their quote. "Entry before 11:30pm" means it doesn't fit, with one next step. With nothing quoted, entry is unverified.
- **Venue named for vs against.** "A concert at Constellation Room" searches Santa Ana. "Not Constellation Room" never makes it the destination.

## Writing rules applied

- **Answer first.** The answer to the latest question is the first line, in bold: entry status, no-match, the pick for this person.
- **Corrections.** A correction is acknowledged once ("You're right that my last reply should have said that first.").
- **Next step.** Each reply ends with one next step.
- **Residency line.** The US-residency line now appears only on the first reply in a thread.
- **Provenance.** Supplied quotes stay labelled as the customer's ("based on your quotes"), never as verified inventory.

## Not proven here

- **Production model.** These are rules-path replays. The production model reads intent, dates and genre itself, so a live re-run of the three conversations is still needed. Research 2 owns live tests.
- **Real catalog.** Real availability, entry policies and event pages were not checked. The Dusky link is the one in the brief, used as a fixture.
- **Rendering.** Gmail rendering was not checked.
- **City core.** The core uses a 20-mile radius from the metro centre, and a venue with no coordinates is judged by city name. It is a heuristic.
- **Personal pick.** The pick is personal only when the customer states a priority. Without one, the cheaper fit wins, as before.
