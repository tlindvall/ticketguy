# Ticket Guy advice engine

Added September 22, 2026. This is a required product subsystem, not merely a tone prompt. It extends ENGINEERING_SPEC.md and supersedes its earlier minimal trend policy where specified below. Existing human approval, source permissions, spend limits, privacy and send gates continue to apply.

## 1. Product promise

Give the customer an informed, independent answer to: **Is this a good deal for our actual needs, and is waiting worth the risk?**

The engine combines verified current offers, licensed historical observations, comparable-event benchmarks, recent movements and the customer's priorities. Deterministic services calculate the evidence and choose an allowed recommendation. The language model explains it naturally. A warmer voice is valuable; unsupported confidence destroys trust.

Every useful answer should cover, when evidence supports it:
1. My recommendation: buy, wait until a stated checkpoint, consider a specific alternative, or insufficient evidence to advise on timing.
2. What your group can actually buy now, including total price and seating constraints.
3. How that compares with similar historical opportunities and this event's recent prices.
4. Why your circumstances change the advice: five together is different from one flexible seat.
5. What would change my recommendation and the next action.

Historical benchmarks and trends are first-class features. Their availability is displayed honestly. No fake history while data access is being arranged.

## 2. Evidence layers

| Layer | Question | Permitted evidence |
|---|---|---|
| Current offer | What can this customer buy now? | Fresh verified quote for exact quantity and conditions |
| Event trend | Are comparable available options rising or falling? | Repeated normalized snapshots for this event and basket |
| Historical benchmark | Is this price typical for similar events? | Licensed past observations, matched by event context and time before start |
| Group constraint | What is the cost/risk of five together? | Quantity-specific purchasable blocks and split restrictions |
| Customer preference | What trade-off matters here? | Explicit budget, together requirement, flexibility, deadline and tolerance for missing out |
| Forecast, later | What might happen next, with what uncertainty? | Separately evaluated time-aware statistical model and suitable outcome data |

Keep observed listing prices, official face values and verified completed transactions in different datasets. A disappeared listing is not evidence of a sale. Historical asking-price statistics must be labeled as such. An estimated provider price is not a verified historical total.

## 3. Collecting historical data

Build an ingestion pipeline from approved inventory adapters plus a bulk import path for a licensed history provider. Do not assume a public discovery API supplies history. Ticketmaster Discovery documents event price ranges, not the required quantity/seat-level historical benchmark contract. StubHub's introduction describes marketplace API access but does not establish historical dataset rights. [Ticketmaster](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/), [StubHub](https://developer.stubhub.com/docs/overview/introduction/).

TicketData is a vendor lead to investigate for historical pricing, not an approved integration or confirmed commercial feed. Its FAQ covers get-in prices, price history and section tracking; request concrete dataset documentation and license terms before relying on it. [TicketData FAQ](https://www.ticketdata.com/faq).

For any vendor request: sample rows; coverage dates/events; section/row granularity; exact purchase quantity and split rules; timestamp cadence/timezone; complete fee/tax basis; primary/resale identity; listing IDs and duplicate treatment; missingness and outages; asking versus sold prices; retrospective corrections; permitted storage duration, derived aggregates, customer display and forecasting; delivery mechanism, costs and termination/deletion obligations. No outreach is authorized by this document.

Start collecting permitted snapshots as soon as approved data access exists, ahead of active customer requests, for a bounded pilot event panel. Sampling only customer-requested or unusually cheap events biases benchmarks. Keep the panel and sampling selection criteria versioned. Collection schedules obey existing source budgets; do not promise whole-US history from day one.

MVP history storage stays in Render PostgreSQL with Drizzle. Index event/basket/observation time; use bounded aggregations and jobs. Add partitioning only when measured volume warrants it. No vector database is needed to calculate prices. Keep personally identifying request data out of shared market observations.

### Licensing versus retention

The main spec's default observation retention remains a cap unless a specific license allows longer retention. Multi-season benchmarks require explicit longer-term rights. Raw-data permission does not automatically permit indefinite derived aggregates, public display or model training. Store allowed uses and expiry at dataset level; derived records retain lineage and applicable expiry. Delete/recompute affected benchmarks on expiry, revocation or corrected data. A historical claim is blocked if the evidence cannot lawfully be retained or used. Proposed target coverage is 12–24 months where licensed; this is an acquisition goal, not a retention override.

## 4. Historical comparison methodology

Never use one undifferentiated “average Rangers ticket price.” Match:

- Same home team/performer and venue/layout version.
- Preseason versus regular season versus playoffs; home versus away; special games separated.
- Same section where supported, otherwise reviewed equivalent seating zone with explicit disclosure.
- Row/view quality, standing versus seated, restricted views, amenities and accessible seating requirements.
- Exact required purchase quantity and together/split conditions.
- Similar time-to-event: initial configurable buckets 0–6 hours, 6–24 hours, 1–3 days, 3–7 days, 7–14 days, 14–30 days, 30+ days.
- Day type, opponent/demand tier, holidays and season. Demand tiers need evidence/versioning; the LLM cannot invent them.
- Same USD payable-price completeness basis. Do not silently inflation-adjust; label any later adjustment explicitly.

Recent relevant seasons take precedence; venue changes or structurally different seasons are excluded with reasons. An exact section ID must not cross incompatible seating maps. For concerts, tour, stage layout and venue can make historical comparability particularly weak; say so.

### Default benchmark, reproducible in code

Use the historical **best available qualifying group offer** for each comparator event at a matched lead time, not an average across every listing ever collected. This answers what a similar buyer could have found. Compute per-person equivalent as whole-party total divided by quantity for display, preserving whole-party cents as the source of truth.

Choose one snapshot nearest the current lead time within the matching bucket for each historical event, with a configurable maximum distance; if none exists, exclude that event. The current target event never enters its own historical cohort. At each chosen snapshot select the cheapest verified complete eligible group offer. Then compute median, 25th percentile and 75th percentile across event representatives with equal event weighting. Use a documented fixed quantile algorithm (linear interpolation/type 7); round only when displaying. Record event IDs, snapshot IDs, exclusions and the method version.

This avoids making frequently polled events or prolific resellers count as many independent examples. A thousand observations of one event are still one independent historical event. Deduplicate reliable cross-source matches; if identity is uncertain, do not report unique-block totals.

Use “typical observed range” for the middle 50% (P25–P75), never “tickets always cost.” The median is the default central value. An arithmetic mean may be displayed when requested, labeled as a mean with the same sample/method details. Min/max are extremes, not a normal range. Do not call P25–P75 a confidence interval or a future prediction interval.

Initial evidence gates (product defaults to validate, not statistically proven accuracy levels):
- 10+ distinct well-matched past events: eligible for a qualified typical-range statement.
- 5–9 events: show an explicitly small-sample comparison; avoid “normally.”
- Fewer than 5: no generalized historical range; at most separately named historical examples with dates and comparable conditions.

If exact five-seat section data is sparse, widen only through an approved, visible hierarchy (same section → equivalent zone; narrow weekday band → broader day type). Never silently replace preseason with regular season, five-seat availability with singles, or this venue with another. Some cohorts will remain too sparse. Store evidence adequacy as sufficient/limited/insufficient, with reasons; it is not an LLM-generated confidence percentage.

## 5. Group-size intelligence

Evaluate at least two distinct baskets when relevant: customer's actual group and a one-seat entry-price reference. The latter is context, never a purchasable substitute for the group.

“Five available” does not establish five adjacent seats or permission to buy exactly five from a six-seat block. Validate adjacency, split rules and all charges for the actual transaction. Do not multiply the cheapest single by five and call it the group price.

If both quantities are verified in a comparable seating zone, compute a quantity premium with a label. If the single is elsewhere in the building, call it an entry-price reference and do not attribute the difference solely to group size.

Track observed eligible block options and changes using only sources with sufficiently complete pagination and coverage. Say “two qualifying listings among the sources checked,” not “only two blocks remain in the arena.” Deduplicate where supportable; otherwise suppress aggregate unique counts. Listings disappearing may indicate removal, relisting, source issues or purchase.

Suggest 3+2 only if the user permits splitting. Never assert separate transactions can both be secured, or that sections/rows are adjacent without evidence. Do not recommend splitting minors from adults without explicit arrangement details. Clarify relevant seating needs without collecting unnecessary personal information.

## 6. Trend engine

Maintain separate time series for the requested quantity/seat basket and optional whole-event entry prices. Lead with the customer's basket. “Singles are falling, but five together have not” is useful advice.

For a stable event/basket and compatible source coverage, retain:
- Cheapest eligible verified group total.
- Median eligible listing total as context where coverage supports it.
- Matched-listing price movements when persistent identities exist.
- Observed qualifying option count and source availability, with limitations.
- Observation time, provider market timestamp, source set, fee basis and quality flags.

A lower cheapest offer from a new seller is a real change in observed available options, but not proof that existing sellers cut their prices. Report it accurately. Source outage, incomplete pagination, cheaper seat-quality substitution or changed fee basis can invalidate the comparison. Never interpret missing data as zero inventory or a price spike.

Compute 6-hour, 24-hour and 72-hour changes only when actual baseline observations exist within the configured tolerance. No extrapolation to manufacture a 24-hour figure from a two-hour history. Compute percent change as (current minus baseline) / baseline, with a positive baseline. Show the time window and group total difference.

Initial trend gate: at least four valid observations over at least six hours with stable basket and adequate common-source coverage. Suggested direction classification is up/down when endpoint movement exceeds both 3% and $5 per group and the median pairwise slope agrees in direction; otherwise mixed/flat. Thresholds are versioned heuristic defaults, not predictive accuracy claims. Sparse, contradictory or coverage-broken data yields insufficient evidence or mixed. Preserve absolute movement even when below classification threshold. Near-event short-window observations can be described literally, but cannot bypass the six-hour gate to justify a confident wait recommendation.

This stricter gate replaces the earlier three-observation contract. Staff can qualify advice but cannot override missing evidence to create a factual trend.

## 7. Buy/wait decision policy

Decision labels: `buy_now`, `wait_and_recheck`, `consider_alternative`, `insufficient_evidence`.

Price attractiveness and timing advice are separate fields. A below-benchmark price can still be falling; a falling market can still be risky for five people who must attend together. Do not turn one trend arrow into a purchasing instruction.

| Situation | Advice rule |
|---|---|
| Good suitable verified offer, meets budget, customer prioritizes certainty | Buying is reasonable; explain any downside to waiting without guaranteed claims. |
| Group basket trending down, price above target, adequate observed options, customer explicitly accepts waiting risk | Propose waiting to a bounded checkpoint; state loss-of-options risk and stop conditions. |
| Singles down but required five-seat basket rising or observed options narrowing | Explain divergence; no generic “prices are dropping, wait.” |
| Inadequate history but good current cross-source quote | Give current comparison; abstain from historical/timing certainty. |
| Deadline close, delivery uncertainty, must-attend trip or highly specific seats | Favor securing a suitable affordable option, or explain no suitable option; do not encourage waiting past safe delivery. |
| No qualifying offer inside budget | Report no fit; offer permitted alternatives or watch, never silently exceed budget. |

Buy advice never authorizes a purchase. Wait advice requires a customer-defined decision deadline and known tolerance for potentially missing out; ask a concise clarification if either is material and unknown. A default wait plan ends at the earliest of customer deadline, event start minus safe delivery buffer, and licensed monitoring coverage/staff availability. Safe delivery buffer depends on verified provider delivery terms, not one universal duration.

Every wait recommendation records next check time, target or meaningful improvement threshold, maximum acceptable spend if provided, inventory/risk reversal triggers, expiry and current watch consent. A recommendation to wait is not permission to enroll a watch. Without consent, say when the customer should check again; with consent, confirm actual scheduling. Do not promise overnight monitoring if approval staffing cannot support it.

Initial policy is rule-based and human reviewed. No numerical probability of a future price decrease, “best time guaranteed,” or synthetic forecast band. Add statistical forecasting only after time-ordered out-of-sample evaluation beats simple baselines and probability calibration is demonstrated for the relevant cohort.

## 8. Response voice and factual controls

Voice: concise, specific, candid, commercially independent. Have a view when supported. Explain trade-offs like a knowledgeable ticket buyer, without pretending personal experience or insider access. Avoid robotic lists of every source; provide a compact coverage/evidence footer.

Recommended email shape: recommendation → best current option → historical/trend context → group-specific reasoning → action/checkpoint. Target 150–250 words for a normal substantive response; shorter clarifications. Do not force historical paragraphs into requests where data is absent or irrelevant.

Never say “always,” “guaranteed to drop,” “only seats left,” “I know the venue personally,” or “normally X” without adequate scoped evidence. “Here is what I would do given your priorities” is allowed, with reasons. An affiliate payment cannot affect advice, confidence, ordering or urgency.

### Illustrative response — entirely synthetic, not actual Rangers prices

> For five seats together, I’d be comfortable buying this option at $85 each—$425 total including the verified charges.
>
> Across 12 comparable Rangers home preseason games, the best five-seat options we observed in this seating zone at a similar point before the game were typically $75–$95 per person. Today’s offer is inside that range.
>
> The cheapest upper-level single is $35, but that doesn’t translate to five seats together. Your group’s comparable options have fallen from $475 to $425 over the last 24 hours, so waiting could help. Since you said sitting together and definitely attending matter more than squeezing out the last few dollars, I’d take the suitable offer rather than risk losing it.
>
> [View the five-seat offer] — checked at [time]. Prices can change before checkout.

The example demonstrates a buy recommendation despite a downward trend. A risk-tolerant customer's version could recommend a bounded recheck instead, with a real checkpoint and no promise of a further decrease. All example figures are fixture-only and must never enter live benchmark tables.

### Generation pipeline

1. Resolve current request revision and explicit preferences.
2. Fetch/revalidate relevant offers; compute historical cohort and trend snapshots in code.
3. Build a typed evidence packet with approved claim IDs, preformatted numeric values, scope labels, evidence adequacy, caveats and expiry.
4. Run versioned decision rules; persist reasons, abstentions, stop conditions and allowed action.
5. Give the LLM only necessary customer context and that packet. Require structured response blocks referencing claim IDs; no arbitrary numbers, URLs or evidence-free claims.
6. Render monetary/statistical facts from server-owned values. Validate every factual block's claim IDs, permitted scope, quantities, URLs and decision consistency. Numeric string checking alone is insufficient; forbid free-form new factual assertions and flag scope overstatements for review.
7. Staff sees current quote, historical cohort definition/sample, chart/table, coverage changes, decision reason and final email. Approval binds all evidence/method revisions. Revalidate freshness and current permissions before send.

A second model critique may flag wording but cannot substitute for deterministic validation or human review. Repeated generation failure falls back to a safe evidence-only template or staff composition, not unlimited retries. All calls count toward the existing request budget.

## 9. Database and application additions

Add shared Drizzle migrations for:
- `market_datasets`: provider, approved uses, license reference, coverage, retention/derived-data rules, expiry, schema version.
- `market_snapshots`: event, basket definition/version, source-check references, observed/provider timestamps, quantity, coverage/pagination flags and eligibility method version. Link normalized offer observations rather than copying unrestricted raw payloads.
- `venue_seat_zones`: versioned layout/section-to-zone mapping, evidence and reviewer.
- `benchmark_runs`: target context, cohort filters/fallbacks, representative snapshot IDs, independent-event count, median/P25/P75, exclusions, adequacy reasons, license expiry and method version.
- `trend_runs`: basket, source intersection, windows, baseline/current evidence IDs, absolute/percent movements, slope/direction, quality flags and method version.
- `advice_runs`: request revision, benchmark/trend/current-offer references, customer priorities, rule version, decision, reasons, abstentions, checkpoint/stop conditions, claim packet hash, approval and expiry.
- `advice_outcomes`: voluntary purchase confirmation, verified amount if supplied, follow-up available-quote observations, missed-option reports and provenance; never infer a purchase from a click.

Extend preferences with request-specific `must_attend`, `wait_risk_tolerance`, `decision_deadline`, `split_group_allowed`; unknown stays null. Do not globally infer risk tolerance from one purchase.

Add staff-only `POST /api/admin/requests/:id/advice` with expected revision and idempotency key; bounded `market.snapshot_due`, `benchmark.compute`, `trend.compute`, `advice.prepare` workflows; same inbox/outbox and budget controls as existing jobs. Add a historical-data import tool with schema validation, quarantine and lineage; import cannot activate unapproved datasets.

Staff UI: explainable benchmark sample table and small price chart with gaps, quantity and observation window; no smoothing that hides outages. Show “history unavailable” clearly. Add controls to mark bad mappings/data and recompute affected drafts. Current offers, benchmark and trend can have different evidence adequacy; never collapse them to a single misleading confidence score.

## 10. Delivery stages and evaluation

MVP required: evidence packet, group-aware comparison, response renderer, decision policy, historical import/benchmark path, snapshot/trend path, cold-start abstention, staff review and evaluation fixtures. Live historical claims are gated on actual licensed data. These capabilities are core MVP scope, not a future cosmetic enhancement. Existing Render/OpenAI/Resend/Inngest architecture remains.

Stage A: deterministic synthetic evaluation plus current-price advice with explicit missing-history behavior. Stage B: licensed historical imports and ongoing approved panel snapshots, then real benchmark/trend claims. Stage C: measured, calibrated forecasting only after sufficient prospective outcomes. Report which stage is operational for each event category.

Backtest by time: only use observations available when advice would have been sent; hold out complete future events and prevent same-event leakage. Evaluate buy-now, fixed recheck and target-price baselines. Measure benchmark coverage, interval descriptiveness, trend validity, group constraint errors, recommendation usefulness, missing-data abstention, delivery feasibility and staff correction rate. For later probabilistic forecasts use proper scoring/calibration, separated by cohort and group size.

Historical future minimum asking price is not guaranteed purchasable and is not proven customer savings. Evaluate waiting at scheduled decision times with sufficient availability evidence, fees and delivery constraints, and report missing outcomes and survivorship bias. Include downside: increased price, loss of acceptable seats, missed event, and customer stress—not just theoretical savings. Never optimize solely for affiliate conversion.

Launch gates: zero unsupported numeric/availability claims in the agreed fixture suite; all prohibited high-risk claims blocked; all wait suggestions have a valid deadline/checkpoint and permission-aware follow-up; reviewed cohort matching and licensing; prospective pilot audit before automatic advice sends are even considered.
