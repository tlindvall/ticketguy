# Architecture review: how sports and concert requests flow (Oct 10, 2026)

Written after three live failures on Oct 9: a "which Rangers game is cheapest before Christmas" question that was answered with an acknowledgement and then a buy-or-wait essay about one game; a "what sports games are on in New York next week" question that listed a college exhibition as one of three picks; and the general pattern of every second email being a single-game brief whatever was asked. The review traces every route a customer email can take, says what each one produces today, and names the structural causes. Line numbers refer to `src/lib/intake/pipeline.ts` (P), `src/lib/advice/packet.ts` (K), `src/lib/advice/renderer.ts` (R), `src/lib/market/tracker.ts` (T) and `src/lib/domain/browse.ts` (B) at commit `6815305` (main, Oct 9).

## Bottom line

1. **The request model is one request, one event.** `requests.eventId` is a single column and `research()` refuses to run without it (P:3077). Every substantive answer (seats, prices, trend, verdict) is produced for exactly one event. A question about more than one event has no answer path.
2. **Comparisons are treated as event *resolution*, not as the answer.** "Which game is cheapest" runs `cheapestGame()` (P:2781), which ranks the games, keeps one, and writes the comparison into an `assumed` sentence (P:968). That sentence is only ever rendered as a paragraph of the acknowledgement email (templates.ts:122) and is dropped entirely when the acknowledgement is skipped (any follow-up revision). Research then runs on the one kept game and sends the single-game brief. The same "decision written as an assumption" pattern is used for the conflict suggestion (P:898), the nearest-elsewhere show (P:912) and the remembered event (P:2847).
3. **Pricing coverage is reactive, and the budget cannot cover a comparison on demand.** A game has a price only if it was tracked in SeatData before, which happens when a customer previously asked about it or the team is in `MARKET_TRACK_ENTITIES` (T:180). `cheapestGame` never enrols or matches games (it only reads stored series and `currentListings`, which returns null for untracked games at T:488). Matching and polling one cold game costs about 3 to 8 SeatData calls; the first game of a team at a venue also triggers a history backfill of up to about 25 calls (the guard at T:604 reserves 9 but the loop can spend 25). The daily cap is 50 (`SEATDATA_DAILY_CALL_LIMIT`). Twelve cold Rangers games cannot be priced in one day under that cap.
4. **Browse ranks by date only.** The "three picks" are the three earliest events on three different days (`choosePicks`, B:106, with a genre score that is always 0 for sports). The `sports` hint includes `ncaa_regular`, `ncaa_championship`, `minor_league`, `combat`, `motorsport` (B:24). Nothing demotes exhibition or preseason games (`isNonGameName` at catalog/sync.ts:133 has neither word). No prices are shown even when we hold them.
5. **Follow-ups after a list are weak.** `browseShown` is used only for paging and corrections (P:2018, 2066). "The second one" is not mapped to the list; it re-browses and burns a clarification. A date-only reply re-browses that day. After a comparison picked game X, "great, 4 tickets" re-resolves the team with no date, the take-charge rule picks the next home game Y, and `keepSettledEvent` returns null because the fresh resolution succeeded (P:2850), so X is silently replaced.

Everything else (opt-out, deletion, cancel watch, entry help, product choice, two pasted offers, residence, outside intents, official sale, late entry) has a dedicated route and behaves as designed. The weak spots are all "more than one event" or "the message after a list".

## 1. The pipeline in one picture

```
inbound email
  -> ingestInbound (P:224-305): thread by In-Reply-To/References; sender must match; one request per open conversation; revision += 1
  -> outbox request.interpret
  -> interpret (P:324-1319)
       LLM extraction (RequestExtraction: intent, performerOrTeam, city, date, quantity, budget, seating, resaleAsked, quotedPrice, notifyAsked, categoryHint, genreHint, wantsMore, ambiguities)
       19 early exits (rate limit, deletion, off-topic, opt-out, delete, cancel watch, entry help, capability, outside tickets, outcome reply, non-US, outside policy, evidence facts, decision, supplied evidence, supplied offers, concert terms, food/drink)
       browse (isBrowseRequest: no performer, and intent browse or a category hint) -> list of 3 -> needs_clarification
       resolveEventWithDiscovery -> ONE event, or ambiguous, or no_match -> clarification / referred / researching
  -> outbox research.requested (only from the 'researching' route, P:1315)
  -> research (P:3070-3417): adapters, SeatData series, listings picks, subject listing, official sale, benchmark
  -> buildPacket (K): claims with ids and visibility rules
  -> validateAndRender (R): a fixed precedence of claims -> text + HTML -> review or auto-send
```

Two facts decide most of what follows: `research()` reads `req.eventId` and nothing else (P:3077-3078), and the only way to send a customer anything other than the single-event brief is one of the early exits or the browse list.

## 2. Request types for sports and concerts: how each is processed and answered today

| # | Customer asks | Detected by | What happens | Email they get | Verdict |
|---|---|---|---|---|---|
| A | "2 Rangers tickets Oct 11, max $400" | performer + date | resolveEvent exact match -> researching | Price lead brief: what I'd do, why, next action (PR #127 outcomes) | Works |
| B | "4 tickets to the next Rangers home game" | team, no date | take-charge rule picks the next home game (P:2448-2471), says so in one line -> researching | Same brief, with "I've gone with the next home game, Mon Oct 5" | Works. With a window holding 2+ home games it asks which date instead |
| C | "Which Rangers game before Christmas is cheapest for my son and me?" | `rules.cheapest` (PRICE_LOW + GAME_CHOICE regexes, P:126) | ambiguous pool of home games -> `cheapestGame` prices only tracked games, keeps the cheapest, writes the ranking as an assumption -> researching | Acknowledgement carrying the ranking (first message only), then a single-game buy-or-wait brief | **Broken** (live Oct 9). Being replaced by a ranked-list reply, see §4 |
| D | "My family is in New York next week. What sports games are on?" | `isBrowseRequest` (category hint, no performer) | Ticketmaster Discovery pull (100 rows, date-ascending), DB read, three earliest on three days | List of three with team/event links, "reply more", "reply with the one you want" | **Half**: works as a list; ranking by date puts an exhibition above the Knicks; no prices; ordinal replies dead-end |
| E | "Find me the best Metallica tickets" | performer, no date, no quantity | resolveEvent: several nights -> ambiguous -> clarification | "Which night: Nov 19 or Nov 21?" plus "how many" | **Half**: asks the date, not what "best" means (view vs value) |
| F | "Metallica Nov 19, 2 tickets" | performer + date | researching | Price lead brief | Works |
| G | A StubHub/Vivid link, a screenshot or a pasted listing: "is this a good deal?" | `submittedUrls` / `listingEvidence` / pasted text; `asks.worth` | research subject path: link looked up by listing id in one SeatData read (P:3222), or the screenshot read; verdict, catches, cheaper equivalents | C_VERDICT first, then what the listing shows, catches, cheaper listings | Works in mechanism; wording is not yet "I'd choose this alternative / I'd stick with yours / the total is cut off". Being fixed, see §4 |
| H | "Buy now or wait?" / "will it drop nearer the game?" on a settled event | `TREND_ASKED`, `LATE_ASKED` | research: resale series (24h/72h), past games at this venue (`lateMoveFrom`) | C_TREND_ANSWER: direction, what past games did, watch offer when over budget | Works (PRs #124, #125, #127) |
| I | A follow-up question in the thread about the same event | `followUp` (a recommendation already sent, event unchanged) | research again; header and seat card suppressed when an answer claim is visible | Just the answer | Works since #125, with the bug in §3.5 for replies that re-resolve |
| J | Two offers pasted: "which of these?" | `suppliedOffers` >= 2 | `answerSupplied` compares them deterministically | "Your offers compared" | Works |
| K | "Which MRAK ticket should four of us buy?" | `asksProductChoice` | `productChoiceAnswer` (P:1258) | "Which ticket to start with", no trend | Works |
| L | "Let me know when tickets go on sale" | `notifyAsked` | event alert, only when `EVENT_ALERTS_ENABLED` | Alert set, or the capability reply | Config-gated (off in production) |
| M | "Keep looking under $200 and email me" | `intent = watch_request` | researching + `maybeCreateWatch` (needs `WATCH_SEND_ENABLED`, cadence, capability, a watchable basket) | Brief plus the watch line, or why no watch | Config-gated |
| N | Event on general sale, resale not asked | `officialSale` | referred with the official link, **only when `SEATDATA_API_KEY` is unset** (P:1284); with the key set the request goes to research and gets resale picks | Official-sale reply, or the brief | Works, but the branch is dead in production whenever SeatData is configured |
| O | "Did you check Saturday too?" | `ALT_DATE_ASK` | keeps the settled event, computes `altDateNote` about the other night | The note reaches the customer **only on the late-entry route** (P:1095); on the research route it is dropped | **Bug** |
| P | Stop / bought / unsubscribe / delete my data / entry help / restaurants / outside the US | dedicated regexes and intents | early exits R5-R12 | One short reply each | Work |

Concerts and sports share every route above; the only sport-specific logic is the home-game take-charge rule, the shared-nickname local-team rule (P:2421-2432) and the league tiers in the roster.

## 3. The structural defects

### 3.1 One event per request
`requests.eventId` is the only handle research has. Multi-event questions (C, D's follow-ups, "this date or that one", "cheaper next week?") are therefore answered either by collapsing to one event or by a clarification menu. There is no "ranked list of events with prices" reply type. The browse list is the closest thing and it carries no prices.

### 3.2 Decisions written as assumptions
`resolution.assumed` is prose that rides along with the acknowledgement. It is the comparison itself for `cheapestGame`, and it is the explanation for the conflict suggestion, the nearest-elsewhere show and the remembered event. On revision > 1 (unless the request came from a referral or a browse pick) the acknowledgement is not sent (P:1312), so the sentence the customer most needs is dropped, and research proceeds as if the question had been about one game. The acknowledgement template also always promises "I'll look at how the tickets are trading and come back to you shortly", even when the assumption text is already the finished answer.

### 3.3 Reactive pricing and the call budget
- Tracking is enrolled from open requests and the `MARKET_TRACK_ENTITIES` cohort (T:180). Nothing else is ever priced.
- `cheapestGame` reads stored series fresh within 36h (`CHEAPEST_GAME_FRESH_MS`), else at most 6 `currentListings` reads, which return null for untracked games. It never calls `refreshEvent`.
- Cost of pricing one cold game on demand through `refreshEvent` (T:306): match 1 to 2 calls, first poll 1 to 6 calls (stats up to 5 pages, plus a sales or listings prompt), so 3 to 8. The team-at-venue history backfill runs once a month and can spend about 25 calls while reserving 9 (T:604-626). When the cap is hit mid-backfill `refreshEvent` reports failure even though the poll succeeded (T:345).
- With `SEATDATA_DAILY_CALL_LIMIT = 50`, pricing twelve cold games in one request is not possible; after the cohort is warm, the hourly tracker keeps about 40 due rows fresh per pass within the same cap.

### 3.4 Browse ordering and scope
`choosePicks` ranks by genre fit (always 0 for sports) then original index, which is `localStartAt ascending` (P:1964). The Discovery pull is also date-ascending and capped at 100 rows, so a busy metro's two-week window can be truncated. `ncaa_regular`, `ncaa_championship`, `minor_league`, `combat`, `motorsport`, `tennis_golf` and `emerging_sports` are all "sports". `isNonGameName` filters practice, clinics, fan fests and tours, but not exhibitions or preseason games. Picks show no price even where a fresh series exists.

### 3.5 Follow-ups after a list or a comparison
- No code maps an ordinal or "the Ottawa one" to `browseShown`; `ordinalChoice`/`dayChoice` run only on `elsewhere` lists and `resolveEvent` candidates (P:919-929). A reply must name the team or the date.
- `keepSettledEvent` keeps the settled event only when the fresh resolution did **not** resolve (P:2850). "Great, 4 tickets" after a comparison pick resolves the team with no date, the take-charge rule picks the next home game, and the chosen game is replaced. The settled event's date is never written back into the brief (only `altAsk` does that, P:966).
- `altDateNote` and the browse age-out `pickLead` are computed on every route and rendered on one.

### 3.6 Smaller defects found on the way
- `research()` dereferences `brief.quantity!` (P:3099). The Guide route with an open official sale suppresses the quantity question (`guideNoFieldAsk`, P:1143) expecting the official-sale exit to answer, but that exit is dead whenever `SEATDATA_API_KEY` is set (P:1284). Likely a null quantity reaching research; not reproduced.
- Picks are gathered when tracking is allowed (P:3266) but the market object also needs `historical_context` (P:3165); with tracking allowed and history not, C_PICKS is built invisible, yet its presence still suppresses the requirements line and the "found seats?" follow-up (K:2106, K:823). Not reproduced against a real depth.
- A typed price ("is about $100 each OK?") with no listing makes research pay for a listings read and then `picksAnswer` returns null because `a.quote` is set (K:1379).
- Routes that exit before P:978 leave the previous revision's `eventId` on the request, so an admin re-run of research uses a stale event.
- When the ambiguity comes from two teams sharing a nickname, `cheapestGame` compares across both teams and labels them all with the first team's name (P:2809).
- The extractor prompt tells the model to emit `categoryHint = ncaaf` for a college matchup (model-client.ts:87); `CATEGORY_HINTS` (B:20) has no such value, so the hint can never be `ncaaf` and the `LEAGUE_HINT` entries for `ncaaf`/`ncaab` in `team-names.ts` are unreachable.
- `cheapestGame` builds its own `MarketTracker` and calls `currentListings`, bypassing the ten-minute read cache that `recentListings` honours (T:464).

## 4. What is being changed now (PR in flight, Oct 10)

Intake side (pipeline.ts, browse.ts, tracker.ts, templates.ts):
- A "compare the games" reply becomes a first-class deliverable: every candidate game priced from stored series or, within the daily budget, through `refreshEvent`; one email ranked cheapest first with the party's price a ticket before fees; unpriced games named as "started tracking"; the request left like a browse list (`browseShown`, `needs_clarification`), no acknowledgement, no single-game research. The games it refreshed stay tracked, so the next customer asking about the same team is answered from stored data.
- Browse ranks by prominence before date: major pro leagues, then other pro and college regular season, then exhibition, preseason and friendlies last. Picks carry "from $X a ticket before fees" when we already hold a fresh price.
- "Find me the best Metallica tickets" gets one question: best view or best value, and how many.
- The product-choice reply is recommendation-first and trend-free.

Answer side (packet.ts, renderer.ts, ticket-brief.ts):
- Subject replies (a link, a screenshot, a pasted listing) follow "what I'd do, why, next action": "I'd choose this alternative" when an equivalent is cheaper; "I'd stick with yours" when theirs is the lowest; "I can see the section and row, but the total is cut off" when the price is unreadable; "I'd keep your original pair" when the cheaper one has a restricted view or is not together. No trend essay unless timing was asked.

Not in that PR, and why:
- The one-event request model stays. The ranked-list reply works around it by reusing the browse state; a real fix (a request that holds a candidate set and an answer kind) is a schema and pipeline change that should follow once the reply shapes above are settled.
- The call budget and the tracking cohort are configuration (§5).
- Direct listing links depend on the field names SeatData returns in its listings rows, which only the admin market page shows.
- The §3.6 defects are logged here for the next pass; the Guide-route null quantity needs a reproduction first.

## 5. Decisions only the owner can make

1. **Which teams are tracked ahead of time.** Put the pilot's teams in `MARKET_TRACK_ENTITIES` (by entity name or slug). Their games within 120 days are then matched and polled by the hourly tracker, and comparison questions are answered from stored data with no calls at request time. The cost is polling: with the current cap of 50 calls a day, about 40 game polls a day are possible, so a cohort of more than roughly 20 to 30 upcoming games cannot be kept within the 36-hour freshness window that comparisons require. Either keep the cohort to the three or four teams the pilot is about, or raise the cap.
2. **The daily call cap.** `SEATDATA_DAILY_CALL_LIMIT` is our own limit, not SeatData's. Raising it is a cost decision against the SeatData plan. Nothing in this review changes it.
3. **The listings field names** (the "Last listings read … keys … sources …" line on `/admin/market`), which decide whether a buy outcome can link to the exact seats.

## 6. Verdict

After the in-flight PR, requests A, B, C, D, E, F, G, H, J and K produce a reply that states what to do, why, and the next step, and no question about several games is answered with an essay about one. What still does not "make sense" without the decisions in §5: a comparison across a team's whole schedule on a cold day will be partly priced, and it will say so. What still does not make sense without the model change in §4: a customer who replies "the second one" to a list.
