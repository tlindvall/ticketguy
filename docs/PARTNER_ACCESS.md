# Ticket data: what is connected, what is not, and what each integration needs

Read this before promising anyone a price comparison. It is the honest state of the data side of the product.

## The two layers

| Layer | What it answers | Status |
|---|---|---|
| **Catalog** — which events exist, where, when, who is playing | "Is there a Rangers game on the 20th and where?" | **Live** via Ticketmaster Discovery once the key and adapter row are set (below) |
| **Listings** — what tickets are for sale right now and at what all-in price | "What are the cheapest five together?" | **Not connected to any source.** Every listing source requires a signed partner agreement before credentials exist. |

The catalog layer is enough for the intake half of the product to work end to end: a request resolves to a real event with an official URL, the clarification email names the right game, and the review console lists exactly which sellers a person needs to check by hand. The listings layer is what turns that into a recommendation without a person in the loop, and it is gated on the agreements below.

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
| **Ticket Evolution** | https://developer.ticketevolution.com — B2B inventory API for licensed resellers | Broadest resale inventory through one licensed API; clear buyer-total price basis; documented purchase links | `PROBE_TICKETEVOLUTION_TOKEN=… pnpm tsx scripts/probe-listing-api.ts ticket-evolution` |
| **StubHub** | https://developer.stubhub.com — partner API | Core routing source for every category; largest single resale marketplace | `PROBE_STUBHUB_TOKEN=… pnpm tsx scripts/probe-listing-api.ts stubhub` |
| **SeatGeek** | https://platform.seatgeek.com — platform/affiliate | Official fan-to-fan marketplace for MLB and several NHL/NBA clubs; event-level stats only unless partnered | `PROBE_SEATGEEK_CLIENT_ID=… pnpm tsx scripts/probe-listing-api.ts seatgeek` |
| TicketNetwork | https://www.ticketnetwork.com/en/affiliate-tools | Affiliate data feed; confirm it is a listing feed and not only link tooling | — (evaluate the feed contract first) |
| Vivid Seats, TickPick, Gametime, AXS | No public listing API | Manual research only until a partner arrangement exists | — |

**Do not write a listing adapter from documentation.** Run the probe against the real service first; it prints the response shape and nothing else. The adapter is then written against a payload that has been seen, with a fake-fetch test built from that exact shape. The alternative — coding to the docs — is what left the inbound retrieval call returning an unexplained `401` for a day.

## Until then: how a recommendation gets made

The review console shows, for every resolved request, the sources the routing policy requires and a link to each seller's own page for that event (the official Ticketmaster event page where discovery mapped one; a search page elsewhere). A member of staff opens them, and records what they find with the manual-observation form — listing URL, quantity, section, base and all-in totals, whether every fee was visible. Those observations enter the same comparison as an API result would, marked `approved_manual`, and the recommendation goes out with that evidence. It is slower than an adapter. It is not less honest.

## What is explicitly off the table

Scraping any of these sites, automating a browser against them, or presenting a search-page snippet as a live price. Each would get the sending domain blocked or the business into a dispute, and none produces an all-in price a customer can be told is real. The handoff excludes them; so does this document.
