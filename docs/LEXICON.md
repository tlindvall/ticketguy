# Lexicon

<!-- Generated from src/lib/lexicon/lexicon.ts by `pnpm lexicon:doc`. Edit the table there, not this file. -->

How customers say things, and what each phrase means to the concierge. The same table drives the rules
extractor and is taught to the model (entries marked **model**). Every example below is run through the
extractor on each test run, so an entry that stops meaning what it says fails the build.

**Request types:** find (one named event) · browse ("what's on?") · watch (tell me when it changes) ·
change (a correction) · stop (end a watch).

**To add a phrase:** add it to an entry's `phrases` and `pattern` (or add an entry), give it an example,
run `pnpm test`, then `pnpm lexicon:doc`.

## What kind of request

| Meaning | How customers say it | Sets | Categories | Request types | Example |
|---|---|---|---|---|---|
| Asks what is on, with nothing specific named — answered with a short list, not questions. **model** | “what's on”, “what's happening”, “what options do I have”, “what can I see”, “any good shows”, “anything fun on”, “recommendations”, “things to do” | `intent="browse"` | any | browse | “I'm coming to New York and want to see some music gigs during the first week on october. What options do I have?” |
| Wants to be told when something changes, not a one-off answer. | “keep an eye”, “keep looking”, “let me know if”, “alert me”, “notify me”, “watch for” | `intent="watch_request"` | any | watch | “Knicks on October 24, 2 tickets, $300 total. Let me know if it drops.” |
| Stop a watch that is running. | “stop the watch”, “cancel my alerts”, “stop looking” | `intent="cancel_watch"` | any | stop | “Please stop the watch, we bought tickets.” |

## What kind of event (no performer or team named)

| Meaning | How customers say it | Sets | Categories | Request types | Example |
|---|---|---|---|---|---|
| Hockey. **model** | “hockey”, “NHL”, “a hockey game” | `categoryHint="nhl"` | nhl | browse, find | “Any hockey games coming up?” |
| Women's pro basketball. Checked before 'basketball'. | “WNBA” | `categoryHint="wnba"` | wnba | browse, find | “Any WNBA games this month?” |
| Basketball. **model** | “basketball”, “NBA”, “a basketball game” | `categoryHint="nba"` | nba | browse, find | “Want to catch a basketball game next week, what is on?” |
| Baseball. **model** | “baseball”, “MLB”, “a ball game” | `categoryHint="mlb"` | mlb | browse, find | “Any baseball on this weekend?” |
| American football. In a US product "football" is the NFL; college football reads the same and is outside the pilot too. **model** _Checked before "a game", so a football game is never every sport._ | “football”, “American football”, “NFL”, “a football game” | `categoryHint="nfl"` | nfl | browse, find | “I want to see an american football game in or near new york the second week of october” |
| Soccer. **model** | “soccer”, “MLS”, “NWSL”, “a soccer match” | `categoryHint="soccer"` | soccer | browse, find | “Any soccer on next weekend?” |
| Live music of any kind. **model** | “gig”, “gigs”, “concert”, “live music”, “music”, “a band”, “a DJ set”, “festival” | `categoryHint="concert"` | concert | browse, find | “Any good gigs in Brooklyn in early October?” |
| Broadway and plays — outside the pilot, so the customer is told plainly. **model** | “Broadway”, “a musical”, “a play”, “theater”, “theatre” | `categoryHint="theater"` | theater | browse, find | “Any good Broadway musicals on next week?” |
| Stand-up — outside the pilot. | “comedy”, “stand-up”, “a comedian” | `categoryHint="comedy"` | comedy | browse, find | “Any stand-up shows this weekend?” |
| A game of any sport. Checked last, so "a hockey game" stays hockey. **model** _"Show" on its own is deliberately unread: it is a concert, a musical or a comedy set._ | “a game”, “sports”, “a match” | `categoryHint="sports"` | sports | browse, find | “What games are on this weekend?” |

## What kind of music

| Meaning | How customers say it | Sets | Categories | Request types | Example |
|---|---|---|---|---|---|
| Rock, indie, alternative and punk — one family, because the provider files indie bands under either Rock or Alternative. **model** | “indie”, “indie rock”, “rock and roll”, “alternative”, “punk” | `genreHint="rock"` | concert | browse, find | “I like indie rock and roll. We are staying in brooklyn.” |
| Jazz. **model** | “jazz”, “a jazz club”, “swing” | `genreHint="jazz"` | concert | browse, find | “Any jazz in the city this weekend?” |
| Hip-hop and rap. **model** | “hip-hop”, “hip hop”, “rap” | `genreHint="hip-hop"` | concert | browse, find | “Looking for a hip hop show next week” |
| Electronic and dance music. **model** | “electronic”, “EDM”, “techno”, “house music”, “a DJ” | `genreHint="electronic"` | concert | browse, find | “Any techno parties in Brooklyn next weekend?” |
| Pop. | “pop”, “a pop concert” | `genreHint="pop"` | concert | browse, find | “We want a pop concert in October” |
| Country, Americana and bluegrass. "Country" on its own is not read: it is usually about where someone lives. | “country music”, “Americana”, “bluegrass” | `genreHint="country"` | concert | browse, find | “Any country music shows next month?” |
| R&B, soul and funk. | “R&B”, “soul”, “funk” | `genreHint="r&b"` | concert | browse, find | “Something R&B next weekend?” |
| Metal and hardcore. | “metal”, “heavy metal”, “hardcore” | `genreHint="metal"` | concert | browse, find | “Any metal gigs in early November?” |
| Folk and singer-songwriters. | “folk”, “singer-songwriter”, “acoustic” | `genreHint="folk"` | concert | browse, find | “Looking for a folk gig next week” |
| Latin: reggaeton, salsa, bachata. | “latin”, “reggaeton”, “salsa” | `genreHint="latin"` | concert | browse, find | “Any reggaeton concerts in October?” |
| Blues. | “blues” | `genreHint="blues"` | concert | browse, find | “Any blues bands on this weekend?” |

## How many

| Meaning | How customers say it | Sets | Categories | Request types | Example |
|---|---|---|---|---|---|
| One ticket. **model** | “just me”, “only me”, “just myself”, “going solo”, “by myself” | `quantity=1` | any | find, change | “Rangers on Oct 3, just me.” |
| Two tickets. **model** | “me and my wife / husband / partner / friend / son / daughter / dad / mum”, “my wife and I”, “the two of us”, “a pair”, “both of us” | `quantity=2` | any | find, change | “Knicks on October 24 for me and my son.” |
| A stated party size. | “party of 4”, “family of five”, “four of us”, “group of 6”, “4 people” | `quantity` | any | find, change | “Rangers on Oct 3 for a family of four.” |
| A real doubt about the number — asked, never assumed to be two. **model** | “a few tickets”, “some seats”, “several tickets”, “a group of us”, “a bunch of tickets” | asks how many | any | find | “A few tickets for the Rangers on Oct 3.” |

## Budget: each or total

| Meaning | How customers say it | Sets | Categories | Request types | Example |
|---|---|---|---|---|---|
| The amount is for each ticket. **model** | “$150 each”, “per ticket”, “per person”, “a ticket”, “apiece”, “pp” | `budgetBasis="per_ticket"` | any | find, change | “Knicks next weekend, 4 seats together, $150 each” |
| The amount is for everyone together. A bare amount is read this way too, and the reply says so. **model** | “$300 total”, “all in”, “for both”, “for all of us”, “combined”, “altogether” | `budgetBasis="whole_party"` | any | find, change | “Two tickets for the Rangers on Oct 3, $300 total.” |

## Seats

| Meaning | How customers say it | Sets | Categories | Request types | Example |
|---|---|---|---|---|---|
| Seats must be next to each other. | “together”, “next to each other”, “side by side”, “adjacent” | `togetherRequired=true` | any | find, change | “Two Rangers tickets on Oct 3, together please.” |
| Seats may be apart. | “don't need to sit together”, “split is fine”, “separate seats are ok” | `togetherRequired=false` | any | find, change | “Four Rangers tickets on Oct 3, we don't need to sit together.” |

## When

| Meaning | How customers say it | Sets | Categories | Request types | Example |
|---|---|---|---|---|---|
| A span of days, not one date — narrows the search without picking a day (src/lib/domain/dates.ts). **model** | “first week of October (also "on"/"in")”, “early / mid / late October”, “end of October”, “Oct 1-7”, “3rd - 9th Oct”, “next few weeks”, “next 2 weeks”, “this month”, “next month”, “this week”, “next weekend”, “in October” | `dateExpression` | any | find, browse | “Rangers tickets in early October” |

## Where

| Meaning | How customers say it | Sets | Categories | Request types | Example |
|---|---|---|---|---|---|
| The pilot market, however it is named. | “New York”, “NYC”, “Manhattan”, “Brooklyn”, “MSG”, “Madison Square Garden”, “Barclays” | `city="New York"` | any | find, browse | “What concerts are on in NYC next week?” |
