# Product gap analysis and roadmap

Date: 2026-09-29. Compares the codebase at `main` (through PR #45) with the buyer research "Ticket Guy: publicly
stated resale-ticket buyer problems" (22 Reddit threads + FTC fee rule, exploratory, not a survey).

## Bottom line

The plumbing is strong. The core promise, "send the ticket link before you buy", is not built yet.

- A pasted link is read only for date, quantity and team (`src/lib/domain/ticket-links.ts`). The listing itself
  (price, section, row, fees, delivery, restrictions) is never read.
- Screenshots are validated and stored, but never passed to the model.
- No live inventory source is connected. All 135 registry sources are `not_integrated`.

So today Ticket Guy can answer "is $106 a good deal?" only when the customer types the $106, and "better
options" only when staff enter offers by hand.

## What's built

### Intake and conversation (live since 2026-09-24)

- Email in and out through Resend: signature-checked webhook, one-thread conversations, quoted-reply stripping,
  auto-reply detection.
- Claude pulls a structured brief from each email: event, quantity, whole-party vs per-ticket budget,
  together-required, accessibility, must-attend, risk tolerance, deadline, split-OK, quoted price, "notify me".
- Pasted links from StubHub, Ticketmaster, SeatGeek, Vivid Seats, Gametime, TickPick and AXS are read for date,
  quantity, listing id and team, from the URL only.
- Event resolution never invents an event. It asks up to 3 clarifying questions and keeps a settled game across
  follow-ups.
- Browse ("what's on in Bushwick"): neighbourhoods, runs of dates shown as one pick, Resident Advisor links for
  electronic music.

### Deciding

- Comparison engine (`src/lib/domain/comparison.ts`): whole-party totals in cents, exact-quantity match,
  together/adjacency checks, obstructed/VIP/parking/deposit exclusions, flags for unknown fees, tax and delivery,
  a duplicate hint rather than an "identical seats" claim, and savings only against a verified baseline.
- Buy/wait engine (`src/lib/advice/*`): benchmark, trend and a rule-based policy with an explicit "not enough
  evidence" outcome and checkpoints. Affiliate data never feeds ranking.
- SeatData resale statistics (`src/lib/market/*`): a listed-price series per event, group-size series for 3–12
  built from listings, a supply-shrinking signal, and a shadow scorecard that grades would-be wait/buy calls
  without sending them. Nothing runs until the licence is approved on `/admin/market`; advice and customer
  display each need SeatData's written OK.
- Price-check claims: the customer's price against face value (`C_QUOTE`), the face-value range (`C_FACE`), and
  "official sale is open" with a buy link (`C_OFFICIAL`).
- The model can only say what the server has proven: every statement cites a claim ID, and prohibited phrases
  are blocked.

### Operations and trust

- Staff console: request review, approval tied to the exact draft, manual offer entry with evidence, market page,
  operations view, kill switches.
- Send gate: fixture data can never reach a customer. Price checks with no listing send without review; buy
  recommendations wait for approval.
- Watches (consent, cadence, caps). No price watch is created today, because no connected seller allows
  scheduled checks.
- On-sale and new-date alerts are built on Ticketmaster Discovery but off (`EVENT_ALERTS_ENABLED=false`) until
  its terms are confirmed.
- Affiliate link wrapping and disclosure; unsubscribe, preferences and deletion.

## Research findings vs. what exists

| # | Job | Status | What's missing |
|---|---|---|---|
| 1 | Buy now or wait | **Partial** | Engine and SeatData series exist. Licence gates block customer use, the scorecard has no graded results yet, and groups of 3+ have no past-game "typical" price. |
| 2 | Fair total / comparison work | **Engine only** | No live listing source. "Compare four sites" is manual staff work. |
| 3 | Seat/view uncertainty | **Missing** | No venue knowledge, stage configuration, view references or "no seat number" flag. Only an obstructed-view restriction code. |
| 4 | Delivery anxiety | **Thin** | The policy has delivery-feasibility fields, but no departure/travel time is captured, there is no issuer release-hold knowledge, and no pre-purchase explanation of delivery risk. |
| 5 | Scam / where to buy | **Missing** | No red-flag check (pay-now pressure, off-platform payment, screenshot as proof). Sale-window data exists but isn't used to flag listings posted before the onsale. |
| 6 | VIP / accessibility | **Partial, one real bug** | VIP packages are excluded and accessible seats are required when asked. No entitlement breakdown. **Bug:** when the buyer didn't ask for accessibility, an accessible-only listing passes as an ordinary cheap option (the R18 failure). |
| 7 | Group quantity / together | **Strong** | Exact quantity, adjacency unknown, split permission and group series all exist. Nearby split groups offered as a compromise don't. |
| 8 | Constant checking | **Built, can't run** | Price watches need a source that allows scheduled checks. Event alerts are off. |
| 9 | Explainability / independence | **Strong** | Claim-cited replies, disclosure, and affiliate data kept out of ranking. A real differentiator. |
| — | Pilot measurement | **Missing** | No problem-type tag, no "did this change what you bought?" follow-up, no outcome tracking. |

## The gaps that matter

1. **The subject listing isn't read.** Every deal check starts from "what are they looking at?" Fetching
   marketplace pages is a terms problem; reading the customer's own screenshot or pasted listing text isn't.
   This is the cheapest unlock, and nothing else gets a deal check working without licensed inventory.
2. **No listing inventory.** "Better options" can't scale past staff until there is one listing API partner or
   SeatData's written OK. This is business development, not engineering.
3. **No disclosure checklist.** Seat number, adjacency, delivery date vs. the buyer's departure, entitlements,
   accessibility, sale stage: the research's "each answer should make clear" list has no structured home in the
   reply.
4. **No measurement.** The 30-request concierge pilot can't be run as written.

## Problem → solution for the core features

### A. Deal check v1 (customer-supplied evidence, no data rights needed)

- **Problem:** the buyer has a listing and wants to know if it's safe and fair. We can't see it.
- **Solution:**
  - Read screenshots and pasted listing text into a subject offer: price, fee basis, quantity, section, row, seat
    numbers, delivery date, restriction text.
  - Run it through the existing comparison and constraint checks.
  - Return fit, a price read (face value now; SeatData once licensed), and a checklist of known and unknown items.
  - End with a recommended next step or an explicit abstention.

### B. Risk and route check (rules, not AI "legitimacy")

- **Problem:** scam fear, speculative listings, delivery too late for travel.
- **Solution:**
  - Flag a listing posted before the official onsale, using sale-window data already stored.
  - Flag off-platform or direct-payment offers.
  - Compare the delivery date with the event start and the buyer's departure (ask for it once).
  - State the documented remedy. Never "verified legitimate".

### C. Entitlements and accessibility disclosure

- **Problem:** resale seats sold with unclear VIP perks; accidental accessible-seat purchases.
- **Solution:**
  - Unverified perks are shown as unknown, never included.
  - Accessible-only inventory is never ranked as a bargain for a buyer who didn't ask for it (fixes the bug above).

### D. Better options

- **Problem:** comparing four sites takes an hour.
- **Solution:** the engine is ready and needs inventory. Short term, staff enter offers manually for pilot
  requests. Medium term, one listing partner (the registry already names TicketNetwork's affiliate tools).

### E. Seat/view knowledge (venue by venue)

- **Problem:** side views and obstructions.
- **Solution:** start with the ~10 NYC venues the pilot actually sees. Section notes and stage configurations,
  with exact-seat photos kept separate from section examples.

### F. Watch it

- **Problem:** constant re-checking.
- **Solution:** already built. It needs a source that allows monitoring, and the Ticketmaster terms sign-off for
  event alerts.

## Roadmap

### Phase 0 — pilot-ready deal check (1–2 weeks, no external dependency)

1. Read screenshots and listing text into a structured subject offer. Customer-supplied evidence gets its own
   collection mode.
2. Disclosure checklist claims: seat numbers, adjacency, delivery vs. event/departure, restrictions, sale stage,
   fee basis, "checked at" time.
3. Fix the accessible-seat bug.
4. Pilot instrumentation: problem-type tag per request, a follow-up email after the event date ("did this change
   what you bought or when?"), and a small outcome board.

### Phase 1 — trust the timing call (in parallel; mostly owner decisions)

1. Get SeatData's written OK for advice and customer display. Let the scorecard build 2–4 weeks of graded
   results first.
2. Confirm the Ticketmaster Discovery terms, then turn event alerts on.
3. Update `docs/FEATURE_STATUS.md`. It's stale: it still lists Claude extraction as blocked and doesn't mention
   the SeatData, alert and link work.

### Phase 2 — risk and entitlements

1. Risk and route rules: pre-onsale listings, direct payment, delivery timing.
2. Entitlement breakdown for an event, from staff-checked promoter terms.

### Phase 3 — better options at scale

1. One listing API partnership, then real "cheaper or better alternative" answers.
2. Price watches become real at that point.

### Phase 4 — seat/view for pilot venues

### Deliberately not building

Post-purchase rescue, peer-to-peer middleman work, "verified legitimate" stamps, confidence percentages.

## Next moves

- Build Phase 0, item 1 first; everything else in the deal check depends on it.
- In parallel, start the SeatData and listing-partner conversations. They're the long pole, and code can't
  shorten them.
- Screenshot reading and the accessibility fix are small enough to be the first build tickets.
