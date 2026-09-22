# Ticket Guy: US ticket-source master directory and search policy

Research date: September 22, 2026. Version 1.0.

## Scope and meaning of completeness

This directory contains **135 named sources, programs, routing authorities, and infrastructure candidates**. They are not 135 independent marketplaces or 135 integrations. It covers major national primary/resale sellers, specialty exchanges, theater discounts, venue-ticketing platforms, sports routing authorities, eligibility programs, and adjacent entertainment categories.

US-only means US customers and events physically in the 50 states and Washington, DC for this version. Canadian games in US leagues, overseas concerts, and foreign rounds of sporting competitions are excluded. US territories are not included automatically; add them deliberately if desired. An international company may still be relevant when it sells a ticket to a US event.

No finite list can truthfully enumerate every local box office, promoter, school, artist presale, private offer, or newly launched seller. The comprehensive policy therefore combines this maintained registry with **mandatory discovery of the actual event's official sales and offer channels**. It does not treat a static national list as exhaustive market coverage.

The categories below describe research routing, not a decision to expand the initial MVP into every category. Movie tickets and tourist attractions are covered for completeness but can remain unsupported at launch.

## Main findings

1. Start with the home team, artist, show, festival, promoter, or venue's official event page. Resolve its actual checkout. Never identify an official seller from a paid search ad or a plausible-sounding domain alone.
2. The league name does not uniquely identify the primary seller. Ticketmaster describes itself as the NHL marketplace; Minnesota Wild now identifies SeatGeek as its ticketing partner. Treat the home-team checkout as decisive for that event. [NHL marketplace](https://www.ticketmaster.com/nhl), [Wild ticketing](https://www.nhl.com/wild/tickets/seatgeek).
3. MLB names SeatGeek its official fan-to-fan marketplace. [MLB](https://www.mlb.com/tickets/seatgeek).
4. Specialty channels can uncover offers that broad resale comparisons miss: [CashorTrade](https://cashortrade.org/), [Tixel US](https://tixel.com/us/), [TodayTix rush/lottery](https://www.todaytix.com/us/static/lotteryandrush), [TDF](https://www.tdf.org/faq/), and venue/team offer links.
5. Public availability of a site is not permission or technical ability to monitor its inventory. The [Ticketmaster Partner API](https://developer.ticketmaster.com/products-and-docs/apis/partner/) is restricted. [StubHub documentation](https://developer.stubhub.com/docs/overview/introduction/) and [Ticket Evolution](https://developer.ticketevolution.com/) are integration leads, not confirmed access for Ticket Guy.

## Required search sequence

**Step A — Establish the exact request.** Event, venue, local date/time, ticket count, togetherness, total budget, seating restrictions, delivery deadline, and flexibility. Confirm an event exists. A request for an artist is not proof that an event is scheduled.

**Step B — Identify official sales.** Inspect the event's official team/artist/production/festival and venue pages. Follow authorized ticket links. Include official resale/returns, publicly available offers, bundles, and box-office information where relevant. The platform may be Ticketmaster, SeatGeek, AXS, or a smaller branded storefront.

**Step C — Execute the category route below.** For events with a meaningful resale market, check core comparison sources and all applicable extended sources. For a local school performance or nontransferable club admission, irrelevant national resale sites can be marked not applicable with a reason. Do not stop searching merely because an affiliate seller has a plausible price.

**Step D — Check special opportunities.** Artist/venue presales, official ticket releases, offer codes, approved fan exchanges, rush/lottery, group offers, and user-eligible programs. Separate immediately purchasable tickets from lotteries, waitlists, reservations, and seller-acceptance offers.

**Step E — Normalize and verify.** Compare total payable cost for the requested count; explicitly flag unknown taxes/fees. Verify section/row, seated versus standing, adjacency, view, access conditions, delivery, age limits, entry deadlines, and package contents. Membership fees and minimum spends matter. Do not equate face value with final price.

**Step F — Report coverage honestly.** Record each applicable source as checked-with-offers, checked-no-matching-offers, not-listed, not-on-sale, sold-out-confirmed, blocked, unavailable, eligibility-required, or not-applicable. A blocked fetch is not sold out. Only say a source was checked when its relevant event results were inspected. Recheck the selected offer before sending it.

**Step G — Monitor the same brief.** Revisit authorized sources at feasible frequencies, prioritize sources that actually cover the event, and preserve explicit gaps. If a deadline or search budget prevents completion, report a partial comparison and unfinished sources rather than imply full coverage.

## Shared comparison sets

**Core C:** Ticketmaster, AXS US, SeatGeek, StubHub, Vivid Seats, TickPick, Gametime. Ticketmaster/AXS/SeatGeek primary, official-resale, and third-party marketplace roles must be kept distinct. The actual official primary seller is required even if outside C.

**Extended E:** TicketIQ, TicketNetwork, TicketSmarter, TicketCity, MegaSeats, GoTickets, SOLDOUT.COM, Ticket Club, ScoreBig, Ticket Liquidator, Event Tickets Center, Tickets-Center, TicketsOnSale, TicketFaster, viagogo, and SeatPick. These are comparison candidates, not a blanket recommendation or trust certification. Evaluate seller terms and event-level delivery before presenting an offer. SeatPick is an aggregator: the final seller must be identified.

For a fully covered, broadly traded event, C + applicable E is the master comparison policy. MVP integration can start smaller, but its coverage claims must remain correspondingly smaller. Overlapping inventory can have different checkout prices, so compare payable offers without counting them as independent ticket supply.

## Routing matrix by request

| Request | Required official starting point | Routine comparison | Additional conditional checks |
|---|---|---|---|
| NHL | Home team's tickets + venue + NHL route | C + E | Team group/family/promotion pages, FEVO-linked offers; verify team provider exceptions |
| NBA | NBA Tickets + home team + arena | C + E | Team offers, theme nights, packs, suites only if requested |
| WNBA | WNBA team directory + home team + arena | C + E where listed | Group/theme offers; exclude games outside US |
| NFL | Home team + NFL tickets + stadium | C + E | Team offers; On Location for requested hospitality; distinguish parking and PSLs from admission |
| MLB | Home club + MLB tickets | C + E, including SeatGeek | Team promotion/value packs, FEVO, Tickets.com/ProVenue; verify food/parking inclusions |
| MLS / NWSL / other US soccer | Home club + league schedule + stadium | C + E where listed | Supporter-section rules, team/group offers; US-hosted matches only |
| NCAA regular season | School athletics ticket office | C + E where listed | Paciolan/eVenue, Ticketmaster, SeatGeek, Tickets.com, vivenu, TicketReturn, HomeTown as designated |
| NCAA championship / bowl | Championship or bowl's official event page + NCAA route | C + E where listed | Authorized hospitality, donor/student eligibility; different from school regular-season rights |
| Minor-league / independent sports | Club + venue; MiLB directory for baseball | C + E only where event exists | Etix, TicketReturn, Tickets.com, vivenu, Paciolan, official promotions |
| High school / youth sports | School, district, or state association | Official route first; resale only when specifically valid | GoFan, HomeTown, local ticketing; do not compare athlete registration with spectator admission |
| UFC / boxing / WWE / AEW | Promoter + arena official event page | C + E | Authorized hospitality, session/card changes, venue restrictions |
| NASCAR / INDYCAR / NHRA / US F1 | Race promoter/track + series | C + E where listed | F1 Ticket Store, F1 Experiences, track packages; race vs qualifying vs weekend, grounds vs seats |
| Tennis / golf | Tournament + governing-body event page | C + E where permitted and listed | Court/session/grounds distinctions, official lotteries and packages; exceptional badge/transfer rules |
| Rodeo / PBR / lacrosse / emerging sports / esports | Organizer/league/team + venue | C + E where listed | Official platform can be Etix, Tixr, Eventbrite, ShowClix or another branded storefront |
| Arena / stadium concert | Artist tour + venue + promoter | C + E | Live Nation/AEG offers, artist presales, Ticketstoday, permitted face-value exchanges, cardholder offers |
| Club / independent concert | Artist + venue | Primary + CashorTrade/Tixel/TicketSwap when applicable; C/E where listed | DICE, TicketWeb, Etix, Eventim US, Tixr, Prekindle, Eventbrite, VenuePilot; official waitlists |
| Festival | Festival official ticket and resale policy | Primary + authorized exchange; C/E if compatible with transfer rules | Front Gate, AXS, Tixr, Eventim US, Etix, Ticket Fairy, CashorTrade, Tixel, TicketSwap; camping/parking separate |
| Electronic music / nightlife | Promoter + venue | Primary + approved return/resale | DICE, RA, Shotgun, Posh, Ticket Fairy, Tixr, Eventbrite; entry time, age, table vs individual admission |
| Broadway / Off-Broadway | Show official site + Broadway.org | Official seller + TodayTix + applicable C/E | Telecharge, Broadway Direct, BroadwayBox, Playbill, TheaterMania, TKTS, TDF; authorized rush/lottery; Broadway.com; group route if eligible |
| Touring Broadway / regional theater | Production + local presenting venue | Official seller + TodayTix where covered + applicable C/E | Local offer codes, student/senior rush, Lucky Seat if designated; AudienceView, Spektrix, Tessitura and local platforms |
| Orchestra / opera / ballet / dance | Company + venue box office | Official inventory + applicable TodayTix/C/E | Subscriber/under-age-program/student offers when eligible; local box-office infrastructure |
| Comedy | Comedian + club/theater/arena | Arena: C + E; club: direct first | TicketWeb, Etix, Tixr, Prekindle, Eventbrite, Helium/Comedy Cellar as relevant; minimum spend and seating assignment |
| Family shows / circus / touring spectacle | Show/promoter + venue | C + E where listed | Official family packs, Groupon/Fever where exact event matches; child/lap-seat policy |
| Fairs / local festivals / community events | Organizer + venue | Official primary; C/E only for separately ticketed major shows | Etix, TicketSpice, Big Tickets, Freshtix, TicketLeap, Humanitix, Events.com and other local platforms |
| Conventions / fan expos / film festivals | Official convention/festival site | Official ticketing + specifically approved exchange | ShowClix/Leap, Eventbrite, Tixr, Universe, Ticket Fairy; badge transfer/name rules and session reservations |
| Las Vegas entertainment | Show + hotel/venue box office | Vegas.com, Tix4, TodayTix where covered, applicable C/E | Groupon/Fever, authorized hotel packages; seat categories and pickup conditions |
| Museums / timed exhibits / attractions | Attraction's official tickets | Fever, Tiqets, Groupon if exact product matches | Universe, SimpleTix, venue platform; CityPASS only when relevant to itinerary |
| Theme parks | Park official tickets | Undercover Tourist + user-eligible channels | Ticket duration, date, park-hopper, residency eligibility and reservation requirements; optional expansion |
| Cinema | Cinema's official checkout | Fandango + Atom where supported | Membership/discount eligibility; optional expansion |

## Source registry

The full per-source registry (135 entries: role, routing tier, routing condition, evidence level) is the machine-readable file `ticket-guy-us-source-registry.json` in this directory. It is the canonical seed for the `source_registry` table. Each entry is a research reference or entry point. Entries based only on a public shell, search index, or blocked fetch are identified in the JSON `evidence_level` field. No end-to-end checkout, seller-vetting, API entitlement, or monitoring integration has been completed. Routing is Ticket Guy's proposed policy, not a claim made by a source.

Groups: Core comparison (7), Extended comparison (16), Music and festival primary (17), Fan exchanges (3), Theater and discounts (14), Local and venue platforms (31), Sports routing (22), Comedy direct (2), Attractions and entertainment (9), Eligibility and special offers (7), Discovery and context (4), Infrastructure evaluation (3).

## Aliases, exclusions, and unresolved candidates

| Name | Treatment | Evidence / next action |
|---|---|---|
| See Tickets US | Alias/migration under Eventim; do not double-count | [Official transition page](https://eventim.seetickets.us/) |
| Goldstar | Route to TodayTix; not a separate default integration | [TodayTix welcome page](https://www.todaytix.com/nyc/category/goldstar-welcome) |
| Brown Paper Tickets | Legacy inbound links; discover migrated Events.com event | [Retirement notice](https://www.brownpapertickets.com/), [migration](https://events.com/bpt/) |
| OvationTix | Retain domain detection; AudienceView family | [Official notice](https://audienceview.com/ovationtix-is-now-audienceview/) |
| ShowClix | Preserve legacy links; homepage currently routes to Leap Events | [Current destination](https://leapevents.com/) |
| eVenue | Paciolan-backed storefront pattern, not independent general inventory | [Paciolan](https://www.paciolan.com/) |
| Lyte | Do not activate as a dependable live source without fresh proof | Fetch failed; historical disruption [reported by Pollstar](https://news.pollstar.com/2024/09/17/lyte-website-down-as-industry-sources-fear-trouble-for-ticketing-service/) |
| Ticketera | Puerto Rico-specific candidate outside the initial 50-state/DC scope | [Official site](https://www.ticketera.com/); activate if territories enter scope |
| 247tickets | Not a routine US source | [Current site](https://www.247tickets.com/) focuses on China |
| Ticket To Cash | Seller-facing service, not buyer comparison source | [Official site](https://www.tickettocash.com/) |
| RazorGator, TicketsNow, historical brands | Do not assume independent active inventory | Resolve current ownership/redirect and operational checkout before adding; not validated in this pass |
| Stub.com, Ticketure, Ticketebo, DontMiss | Unresolved candidates, not active registry coverage | Direct attempts unsuccessful; inspect current operation and US event use before activation |
| Go City, AAA, Chase offers | Conditional research backlog | Need current US product/eligibility page verification; do not quote inaccessible offers |
| UFC, PGA Tour, USGA, USL, PLL | Official-organization discovery patterns still required | Some attempted URLs failed; resolve exact current event official page case by case; failure is not closure |
| Improv / Comedy Store and other club chains | Venue-direct discovery required | Some attempted routes failed; official venue event page must be resolved rather than hard-coded from an old URL |
| Facebook groups, Reddit, Craigslist, unverified DMs | Outside automated recommended seller set | May help identify demand or official announcements; no unprotected peer payment recommendations |
| Travel/hospitality resellers not listed | Event-specific discovery and vetting | Only expand when the request calls for a package; separate lodging/service value from admission |

This backlog is intentionally explicit. A complete research policy must not quietly label uncertain sources as active, defunct, safe, or checked.

## Non-marketplace opportunities that every applicable route must consider

- **Venue and team offers:** official family packs, group sales, theme nights, weekday offers, newsletter codes, last-minute releases, and box-office purchase options. Verify terms and available inventory; do not assume a box office removes fees.
- **Artist and festival routes:** artist presales, fan-club allocations, official return queues, approved fan exchanges. Include membership costs and do not bypass access restrictions.
- **Theater value routes:** official in-person rush, digital rush, lotteries, standing room, cancellation lines, and eligibility programs. Treat uncertain admission as a different outcome from guaranteed tickets.
- **Card, employer, member and service programs:** ask only when useful and use user-declared eligibility. Never collect account passwords or infer protected/sensitive eligibility for marketing tags.
- **Local authorized brokers or a seller the user provides:** investigate legitimacy, rights and delivery before admitting to the source registry. A long national list must not exclude a demonstrably useful local source, but an unknown domain must not be auto-trusted.

## Engineering requirements derived from this research

1. **Maintain an event-to-source map.** Separate the official authority, primary checkout platform, resale storefront, underlying inventory family if known, and aggregator referral. Store aliases and redirects. Unknown inventory relationships remain unknown.
2. **Treat the directory as configuration.** Source IDs, supported categories, geographic rules, conditional eligibility, active status, last review, evidence links, and integration status should be editable without changing the concierge prompt.
3. **Separate data access from affiliate agreements.** Neither a public page nor an affiliate account establishes rights to scrape, retain prices, or poll inventory. Per-source due diligence must cover commercial use, API approval, monitoring, retention, rate limits, and terms.
4. **Use an auditable coverage ledger.** Every recommendation records event-specific source outcome and timestamp. A search-result snippet does not establish a currently buyable ticket. Scope the language to sources actually checked.
5. **Represent offer differences explicitly.** Total and per-ticket price, quantity/split rules, togetherness, section/row, ticket notes, obstructed view, admission type, currency, fees/taxes, delivery, deadline, eligibility, membership cost, and confidence. Flag unavailable fields; never fill them with invented values.
6. **Protect event identity.** Compare home/away, venue, local date/time, session, day pass/weekend pass, parking vs admission, and special packages. Artist-name equality is not enough.
7. **Do not count duplicate listings as supply.** A shared row/section/quantity is evidence of possible duplication, not proof of an identical seat block. Track uncertainty and compare final buyer prices.
8. **Separate offer states.** Immediately purchasable, seller acceptance pending, lottery, queue, presale not open, membership required, package-only, and stale/unverified must not share one ranking without explanation.
9. **Maintain a source-health process.** Suggested cadence: weekly operational health, monthly source/alias review, event-primary verification per new event, and selected-offer revalidation before each outbound recommendation. These are proposed operating policies, not source-provided service levels.
10. **Separate eligibility from marketing permission.** US-only launch does not turn a ticket-interest tag into evidence of consent or eligibility. Keep marketing suppression/preferences and sensitive service requirements independent of search routing.

## MVP application

Build the complete registry now, then activate integrations in stages. Start with official-event resolution, reliable access to the broad core comparison set, and the specialty routes relevant to the pilot's supported venues. Keep the extended directory available to human reviewers while access is evaluated.

Do not promise that all 135 entries are queried on every email. Promise the full applicable search policy only when it is actually executed. During the pilot, disclose the sources inspected and gaps. The end goal is comprehensive applicable coverage, not a large number of redundant homepage searches.

## Research limits and next diligence

This is broad current web research, primarily official source pages and indexed official descriptions. It confirms source roles and candidate routing, not live inventories, historical accuracy, buyer-protection performance, commissions, API entitlements, or successful checkout. Some pages are browser-rendered or blocked to research tools; these are recorded as limited evidence, not absent inventory.

Before production, perform event-level access and recommendation-vetting checks on each activated source. Build the initial team/venue-to-provider map for the pilot market. Expand that map continuously from verified official links; enumerating every US local organization is an ongoing registry-maintenance task, not something a static document can truthfully finish.
