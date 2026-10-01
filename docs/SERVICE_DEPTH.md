# Service depth: implementation and rollout

What was built from the service-depth implementation guide (reviewed baseline `6f958a5`), how to turn it on, and what it still can't do. The decision is DECISION_LOG #61.

## Where the policy lives

| Piece | File |
|---|---|
| Depth mapping, format, operations, limits, overrides, capability, outside intents | `src/lib/domain/service-depth.ts` |
| Decision + capability read against the database; shadow logging; snapshots | `src/lib/intake/service-policy.ts` |
| Source plan under a depth (executable / official pointers / unavailable with reasons) | `src/lib/sources/routing.ts` (`planSources`) |
| Constraint basket for watches | `src/lib/domain/watches.ts` (`constraintBasket`, `readBasket`, `meetsDelivery`) |
| Rollout reconciliation (dry run / apply) | `src/lib/intake/reconcile-service-depth.ts`, `pnpm service-depth:reconcile [--apply]` |
| Migration (additive, nullable) and its manual rollback | `drizzle/0017_service_depth.sql`, `drizzle/rollback/0017_service_depth.down.sql` |

## Findings and fixes

| ID | Fix | Mode |
|---|---|---|
| F01 | Unknown provider classification → `unknown` (Guide), never `concert`. "Fest" alone isn't a festival. Electronic depth comes from format (arena = concert, club = Guide). Provider taxonomy kept in `events.classification`. | category always; depth gates under enforce |
| F02 | `planSources` intersects the route with integrated, approved, covering sources and the depth's budget. No empty-plan fallback. Skipped sources are recorded (`policy:<reason>`) and never called. | always (budget under enforce) |
| F03 | Tracker enrolment, `refreshEvent`, due polling and backfill are gated. Ineligible rows are paused (`policy:no_valid_reason`), and history is kept. A cohort reason stays valid on its own. | enforce |
| F04 | Watches store the full basket. Evaluation searches and judges with it. An unverifiable requirement means no alert. A legacy row rebuilds its basket from its own revision. | always |
| F05 | Watch creation/evaluation/approval/dispatch use one event-specific capability: a monitoring source that covers this event. Rights revoked → paused with reason, no polling. | rights always; depth under enforce |
| F06 | Outside intents get a scope reply before ticket intake. Food/drink gets a bounded Guide reply. A resolved Guide event gets the official route without a quantity loop. Operator blocks stay stronger than any depth. | enforce |
| F07 | Research runs benchmark, trend, tracking, listings reads and the staffed pilot only where allowed. A dispatch rechecks claim operations. | enforce |
| F08 | `request_versions.service_policy` and `research_runs.service_policy` snapshots. The admin request page shows depth, reasons, override, unavailable capabilities and searched/skipped sources. The watch list shows the pause reason. | shadow and enforce |
| F09 | Covered by the homepage update on main (`c3237ff`): coverage, history and buy/wait are qualified there. This PR changes no homepage copy. | n/a |

## Turning it on

1. Deploy with the default `SERVICE_POLICY_MODE=shadow`. Customer replies and provider calls are unchanged.
2. Read the `service_policy.would_block` audit entries and the admin "Service depth" card for a few days.
3. Run `pnpm service-depth:reconcile` (dry run) against production and review each pause/invalidate line.
4. Set `SERVICE_POLICY_MODE=enforce`, then run `pnpm service-depth:reconcile --apply` once. Enforce gates new work and workers together; reconcile clears existing rows in one pass instead of waiting for the next worker run to pause them.
5. To promote a specific event, add an entry to `SERVICE_DEPTH_OVERRIDES` (JSON array of `{id, depth, eventIds|entitySlugs, owner, reason, expiresAt, evidence}`). It expires on its own.

Setting `off` records nothing and gates nothing, but keeps every consent, evidence, source-access, suppression and safety check.

## Tests

- `tests/unit/service-depth.test.ts`: SD01–SD03, outside intents, overrides, capability (SD11), source planning (SD04/SD24), basket (SD13), affiliate ranking (SD22).
- `tests/acceptance/service-depth.test.ts` (enforce): SD02, SD04–SD08, SD11–SD20, SD23, SD25–SD28, plus shadow/off. These count adapter searches, SeatData calls, research runs, tracked events, watches and alerts alongside the replies.
- SD09/SD10 (no comparable history, single-ticket market vs a group of five) remain covered by `tests/unit/policy-market.test.ts` and `tests/unit/timing-advice.test.ts`. SD21 is the existing sports/concert regression suite.
- The whole suite also passes with `SD_MODE=enforce` (the harness applies it to `testEnv`).

## Still limited

- **Format is heuristic.** It works from venue and event-name words, and anything it can't place is `unknown`. Unknown never raises depth, but a real arena it doesn't recognise leaves a touring concert at Compare until staff override it.
- **Guide limits.** The Guide clarification limit of one question isn't separately enforced: Guide skips the quantity/budget ask, and other questions follow the existing three-round cap.
- **Browse.** Browse isn't depth-filtered beyond operator blocks: a Guide category can still appear in a "what's on" list (one bounded catalog lookup).
- **Integrations.** No real quote-search or monitoring integration exists yet, so live comparison and watches still run only on fixture/manual sources. The policy changes nothing about what is integrated.
- **Not tested here.** The real-PostgreSQL migration wasn't run here because no `TEST_DATABASE_URL` is configured; PGlite applied it. Live-model extraction of the new intents is untested: the rules extractor and the regexes in `outsideIntent` are what was tested.
- **Docs.** `SERVICE_DEPTH_MATRIX.md` (the product matrix the guide references) was not in the handoff, so this follows the guide's own tables.
