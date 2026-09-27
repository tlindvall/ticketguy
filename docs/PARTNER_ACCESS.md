# Ticket data: what is connected, what is not, and what each integration needs

Read this before promising anyone a price comparison. It is the honest state of the data side of the product.

## The two layers

| Layer | What it answers | Status |
|---|---|---|
| **Catalog** — which events exist, where, when, who is playing | "Is there a Rangers game on the 20th and where?" | **Live** via Ticketmaster Discovery once the key and adapter row are set (below) |
| **Listings** — what tickets are for sale right now and at what all-in price | "What are the cheapest five together?" | **Not connected to any source.** Every listing source requires a signed partner agreement before credentials exist. |

The catalog layer is enough for the intake half of the product to work end to end: a request resolves to a real event with an official URL, the clarification email names the right game, and the review console lists exactly which sellers a person needs to check by hand. The listings layer is what turns that into a recommendation without a person in the loop, and it is gated on the agreements below.

## What the 135 registry entries actually are

`not_integrated` on every row is true and misleading. Classified by what it would take to get data out of each (`src/lib/sources/access.ts`, shown on `/admin/sources`):

| Class | Count | What they are | What "integrating" means |
|---|---|---|---|
| Catalog API | 1 | Ticketmaster Discovery | Enabled below. Events, never prices. |
| Listing API behind a partner agreement | 6 | Ticket Evolution, StubHub (+ its API entry), SeatGeek, TicketNetwork, Ticketmaster Partner | A commercial application, then a probe, then an adapter. The only rows that can ever become adapters. |
| Listings, no API | 19 | Vivid Seats, TickPick, Gametime, AXS, viagogo, the extended resale storefronts, the fan exchanges | Manual research through the console, permanently unless they answer an email. Most overlap the same broker inventory Ticket Evolution licenses. |
| Primary platform / seller of record | 64 | Etix, DICE, Tixr, Eventbrite, Paciolan, Tessitura, Telecharge, TodayTix, the venue engines | Never an adapter. The venue or show page is the source; the console links to it when the route calls for it. |
| Official routing reference | 21 | nhl-ticket-exchange, nba-tickets, mlb-tickets, broadway.org, Live Nation, AEG | Says who the seller of record is. Followed by a person, not integrated. |
| Context rule | 24 | TKTS, lotteries, rush, cardholder presales, Vet Tix, GovX, Bandsintown | A per-event policy fact recorded in the advice. There is nothing to fetch. |

So the integration backlog is seven rows, not 135, and six of the seven are gated on an application only the business owner can file. Everything else is finished the day the console links exist — which they do.

## Enabling the catalog (Ticketmaster Discovery)

1. Create a developer account at https://developer.ticketmaster.com and an app; copy its **Consumer Key**. Read the API terms of use — commercial use, caching and monitoring rights are the parts that matter.
2. Render → Environment: `TICKETMASTER_DISCOVERY_API_KEY` = the consumer key, `TICKETMASTER_DISCOVERY_ENABLED` = `true`.
3. `/admin/sources` → **ticketmaster** → implementation `ticketmaster_discovery`, enabled, **daily call limit `4000`** (the default quota is 5,000/day; leave headroom), and in *Access approval evidence* write who accepted the terms, when, and the app name. The adapter does nothing until this row exists — a working key on its own never enables an integration.
4. Run the pre-warm once so the pilot names are on file before anyone writes in: `pnpm tsx scripts/catalog-prewarm.ts` in the Render shell. It then runs daily at 04:05 UTC.

What Discovery never does: produce an offer. Its event price ranges are dropped before the catalog sees them. A range is not a purchasable ticket.

## Listing sources — apply for these, in this order

Each of these is a **commercial application**, not a signup form. Expect days to weeks, and expect to state the use case: an email concierge that compares listings and links customers to the seller, never buys or resells. Record the outcome — who approved, what operations, what rate limit, what retention, what link/affiliate terms — in the adapter row's approval evidence. Nothing is enabled on a key alone.

| Source | Programme | Why first | Probe once credentials arrive |
|---|---|---|---|
| **Ticket Evolution** | https://developer.ticketevolution.com — B2B inventory API. Credentials are an Office ID, API token and API secret issued through onboarding (onboarding@ticketevolution.com; sandbox on request). Every request is signed: `X-Signature` = base64 HMAC-SHA256(secret, `GET host/path?sorted-query`). | Broadest resale inventory through one licensed API; ticket groups carry listing-level retail prices — the one source that could feed real price trends | `PROBE_TICKETEVOLUTION_TOKEN=… PROBE_TICKETEVOLUTION_SECRET=… pnpm tsx scripts/probe-listing-api.ts ticket-evolution` (`PROBE_TICKETEVOLUTION_SANDBOX=1` for sandbox); also fetches one event's ticket groups |
| **StubHub** | https://developer.stubhub.com (source: github.com/viagogo/stubhub-api-docs). App-only OAuth gives the **catalog** — events, venues, `min_ticket_price`, event page link. No endpoint returns other sellers' listings; inventory, sales and webhooks are seller-account APIs. Buyer apps go through the affiliate programme: affiliates@stubhub.com with a Partnerize company name/ID. | Core routing source for every category; largest single resale marketplace. `min_ticket_price` could feed a get-in-price series once the terms allow storing it; its fee basis is undocumented, so it is never a quote | `PROBE_STUBHUB_CLIENT_ID=… PROBE_STUBHUB_CLIENT_SECRET=… pnpm tsx scripts/probe-listing-api.ts stubhub` (`PROBE_STUBHUB_SANDBOX=1` for sandbox) |
| **SeatGeek** | https://platform.seatgeek.com — platform/affiliate | Official fan-to-fan marketplace for MLB and several NHL/NBA clubs. **Probed 2026-09-26 with a client id only: HTTP 200, events and venues returned, `stats` empty on all three Rangers games** — no lowest/average price or listing count at this tier. Link-out and catalog cross-check (`url`, `ticketmaster`, `integrated`) only, unless a partner tier fills `stats` | `PROBE_SEATGEEK_CLIENT_ID=… pnpm tsx scripts/probe-listing-api.ts seatgeek` |
| TicketNetwork | https://www.ticketnetwork.com/en/affiliate-tools | Affiliate data feed; confirm it is a listing feed and not only link tooling | — (evaluate the feed contract first) |
| Vivid Seats, TickPick, Gametime, AXS | No public listing API | Manual research only until a partner arrangement exists | — |

**Do not write a listing adapter from documentation.** Run the probe against the real service first; it prints the response shape and nothing else. The adapter is then written against a payload that has been seen, with a fake-fetch test built from that exact shape. The alternative — coding to the docs — is what left the inbound retrieval call returning an unexplained `401` for a day.

## Until then: how a recommendation gets made

The review console shows, for every resolved request, the sources the routing policy requires and a link to each seller's own page for that event (the official Ticketmaster event page where discovery mapped one; a search page elsewhere). A member of staff opens them, and records what they find with the manual-observation form — listing URL, quantity, section, base and all-in totals, whether every fee was visible. Those observations enter the same comparison as an API result would, marked `approved_manual`, and the recommendation goes out with that evidence. It is slower than an adapter. It is not less honest.

## What is explicitly off the table

Scraping any of these sites, automating a browser against them, or presenting a search-page snippet as a live price. Each would get the sending domain blocked or the business into a dispute, and none produces an all-in price a customer can be told is real. The handoff excludes them; so does this document.
