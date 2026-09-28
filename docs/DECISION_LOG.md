# Decision log

Dated 2026-09-22 unless noted. Categories: **implemented**, **fixture-only**, **manual**, **approved-live** (none yet), **deviation**.

1. **Handoff persisted into the repo (implemented).** The handoff arrived as pasted text; `docs/handoff/*.md`, `research/*`, and `.env.example` reproduce it. The research master's per-source tables were replaced by a pointer to the canonical JSON registry (identical data; avoids two divergent copies). The JSON is generated from `scripts/registry-source.tsv` by `pnpm registry:build`; CI fails if the committed JSON drifts.
2. **Webhook verification implemented in-house (deviation, low risk).** Resend webhooks are Svix-signed; `verifySvixSignature` implements the documented HMAC-SHA256 over `id.timestamp.body` with a 5-minute tolerance and constant-time compare, tested on tampered bytes/wrong secret/old timestamp. Swap to the SDK verifier once a staging account exists if it exposes one; the contract is the same.
3. **Provider payload field names are assumptions (blocked).** `fetchReceivedEmail`/`normalizeReceived` follow the receiving docs as of the research date. They must be validated against a live staging payload before the intake path is trusted.
4. **Country confirmation is asked, never inferred (implemented).** If a clarification goes out, the US question rides along (within the 3-question cap). For complete first requests the acknowledgment carries a one-line US check. Research proceeds; the recommendation review note flags "customer country unconfirmed" so staff decide. Explicit non-US statements → `unsupported`.
5. **Ticketmaster Discovery drops price ranges (implemented).** The adapter returns events/URLs/dates only and reports `not_supported` for quotes; A12 is enforced at the adapter boundary.
6. **Benchmark per-person display rounds to whole dollars (implemented).** Whole-party cents stay the source of truth; only the rendered per-person P25/P75/median are rounded to the dollar.
7. **Trend "new seller lowered the floor" is inferred from the cheapest-source marker in snapshots (implemented).** Fixture snapshots carry `cheapest_source:<id>` in `qualityFlags`; live snapshot writers must set it the same way.
8. **Manual evidence joins the comparison for 6 hours (implemented).** Staff observations for the same event/quantity within 6h of a research run are included; freshness at approval/send still applies (5/15-minute windows), so a stale manual observation blocks approval until revalidated.
9. **Watch creation only from an explicit watch intent with a stated budget (implemented).** No budget basis → no watch; the clarification path asks. Watches attach to fixture sources only today; `monitoringAllowed` on a real adapter requires recorded polling rights.
10. **Marketing campaigns not built (blocked).** Tables and permission/suppression logic exist; there is no segment builder, campaign UI or sender. Provider use-case clearance is a prerequisite anyway.
11. **Historical import CLI not built (partial).** Datasets are quarantined by default and the benchmark refuses unapproved/expired/fixture data; an importer with lineage is the next piece when a vendor sample exists.
12. **Sharp installed but not wired (partial).** Decoder-free header inspection enforces A22 limits; re-encode/strip-metadata/resize via sharp before any model call is a follow-up.
13. **Sentry not wired (not built).** `SENTRY_DSN` is accepted; alerting destinations require the owner's account.
14. **ESLint pinned to 9.x (deviation).** ESLint 10 is incompatible with `eslint-plugin-react` as pulled by `eslint-config-next@16.3.5`.
15. **TypeScript 5.9 rather than 7.x (deviation).** TypeScript 7 is the Go-based compiler preview line; 5.9 is the stable toolchain Next.js/Drizzle are built against.
16. **PGlite singletons via `globalThis` (implemented).** Next dev instantiates module graphs per route; PGlite refuses a second open of the same data dir. A stale `postmaster.pid` from an unclean kill is removed on open (dev only, single-process assumption documented).
17. **Raw SQL timestamps as ISO strings with casts (implemented).** postgres.js and PGlite serialize untyped `Date` parameters differently; `leaseDueOutbox` and `recordProviderAccepted` pass ISO strings with `::timestamptz`.
18. **No OpenAI eval report (blocked).** The handoff asks for a bounded eval; without an API key none was run. The fixture suite covers extraction/injection rules deterministically instead.
19. **Real-Postgres tests ran on PostgreSQL 16 locally; CI uses 18 (implemented).** Only PG16 server binaries exist in this environment; the workflow's service container is `postgres:18`, matching the target.
20. **Local demo staff account (implemented, not committed).** `scripts/create-staff.ts` requires `STAFF_INITIAL_PASSWORD` and honors `STAFF_EMAIL_ALLOWLIST`; no credentials are in the repo.
21. **`APP_URL` resolves from `RENDER_EXTERNAL_URL`, and must be https in staging/production (implemented).** The first `render.yaml` omitted `APP_URL`, so a deployed instance would have kept the `http://localhost:3000` default — silently breaking Better Auth trusted origins, the admin CSRF origin check (every staff mutation 403) and every signed preference/unsubscribe link in outbound mail. Resolution order is now `APP_URL` → `RENDER_EXTERNAL_URL` → localhost, and a production-like environment refuses to start on a non-https value.
22. **`EXTRACTION_PROVIDER` makes the rules extractor a deliberate choice (implemented).** `APP_MODE=live` without `OPENAI_API_KEY` previously fell back to the regex `FixtureExtractor` with no signal. A production-like environment with `EXTRACTION_PROVIDER=openai` (the default) now refuses to start without a key; `EXTRACTION_PROVIDER=rules` runs the deterministic path deliberately and logs it at startup. Nothing customer-facing could have escaped review either way, but a silent model-to-regex swap is exactly the substitution the spec forbids.
23. **`MEDIA_MAX_TOTAL_BYTES` pinned to 256 MiB in the blueprint (implemented).** The 1 GiB default is larger than the storage of the smallest Render PostgreSQL plans, and database-backed media would have competed with business data. Raise it with the plan.
24. **Anthropic Messages API replaces the OpenAI Responses API (deviation from the handoff, owner-directed).** The handoff specified OpenAI with `gpt-5.4-mini` plus a gated `gpt-5.4` escalation. The owner directed a switch to Anthropic. Implementation notes:
    - **`claude-opus-5` for both extraction and drafting.** Extraction errors are the least-caught failure in the system — a reviewer sees the extracted brief, not a diff against the original email, so a misread budget basis or quantity can pass review. At pilot volume the model bill is a few percent of the human-review cost the spec's own model predicts, so the accuracy is cheap. Drafting could run on `claude-sonnet-5` (~60% cheaper) once measured; it is deliberately not split yet, because one model means one cache namespace, one price row and one thing to evaluate.
    - **Escalation is effort, not a second model.** `ANTHROPIC_BASE_EFFORT=low` / `ANTHROPIC_ESCALATION_EFFORT=high` replace the base/escalation model pair. Both tasks are well-specified rather than hard reasoning, and a cheaper-model cascade would forfeit cache reuse across models.
    - **Output ceilings raised** (extraction 2,000 → 8,000; drafting 1,200 → 4,000 tokens). Thinking tokens count against `max_tokens`; the handoff's caps were sized for a non-thinking model and would have truncated mid-object. Truncation is a typed `incomplete` failure, not a salvage attempt.
    - **Server-side refusal fallbacks enabled** (`fallbacks: 'default'`). If a safety classifier declines a request the API re-runs it on a fallback model in the same call; our own refusal path (route the request to staff) remains the last resort.
    - **Price table replaced** and longest-prefix matched, so a future `claude-opus-5-5` cannot silently bill at the `claude-opus-5` rate; unknown models price conservatively at $15/$75 per MTok.
    - **Privacy copy corrected.** The draft page claimed OpenAI storage was disabled via `store:false`. That parameter has no Anthropic equivalent; the page now says retention is governed by Anthropic's terms and our account configuration, and still requires legal review.

## 25. Service domain is `ticketguy.now`, and it lives in one place

The handoff specified `ticketguy.live` as the service domain. That domain was never registered (it does not
resolve); the owner purchased `ticketguy.now` instead.

The domain had been hard-coded in five places — two env defaults, the marketing subdomain, the root layout's
meta description, the how-it-works page, and the crawler user-agent — so a change like this could silently
half-apply. `src/lib/config/brand.ts` now holds `SERVICE_DOMAIN` and the values derived from it; the public
pages read `CONCIERGE_INBOUND_ADDRESS` from the environment so an operator override is honoured without a
deploy, and `tests/harness.ts` derives its fixture recipient from the same constant rather than repeating a
literal. Repeating the literal was what turned this into six failing tests: the pipeline ignores inbound mail
whose `To` is not `CONCIERGE_INBOUND_ADDRESS`, so a hard-coded fixture address becomes an unknown recipient
the moment the domain moves.

Deliverability note for the owner, not a code concern: `.now` has no established sending reputation and is
unusual enough that some filters weight it against a new sender. It matters little for inbound (customers
email us) and more for the marketing subdomain. Warm up `news.ticketguy.now` separately from the service
address, and keep DMARC at `p=none` until reports confirm every legitimate sender.

## 26. Many send addresses, one receivable set, enforced at startup

The owner needs to send from more than `my@`. Sending is the easy half: DKIM and SPF authorize a domain, not
a local part, so a verified sending domain can send from any address on it with no extra DNS.

Receiving is the constrained half, and it is where the product breaks. Root MX has exactly one owner, the
intake accepts only addresses it is configured for, and everything else is dropped as
`inbound.unknown_recipient_ignored`. A `From` nobody receives on therefore loses customer replies in silence
— Reply-To covers most clients, but not a customer who types the address or forwards the thread.

So: `CONCIERGE_INBOUND_ADDRESSES` extends the accepted set beyond the public address, and
`MESSAGE_CLASS_FROM_ADDRESSES` maps any of the eight message classes to its own `From`. `parseEnv` refuses to
start when a configured `From` is neither accepted inbound nor listed in `UNMONITORED_FROM_ADDRESSES`. The
escape hatch exists because a marketing subdomain legitimately is not receivable; requiring it to be named
turns a silent drop into a recorded decision.

Both settings default to empty, so behaviour is unchanged until an operator configures them. Loop detection
now treats every accepted and every sending address as our own, so a bounce from any of them is still caught.

Advice to the owner, unchanged from the discussion: prefer varying the display name over the local part, and
use a separate subdomain where separate sending reputation is actually wanted. Extra local parts on one
domain buy no deliverability — reputation is domain-and-IP level — and each one adds an address that must be
received on.

## 27. Two model providers behind one interface, and no guessed prices

The owner has OpenAI credits and no Anthropic account. Rather than migrate a second time, the model layer
is now provider-neutral: `src/lib/ai/model-client.ts` owns the prompts, the untrusted-input framing and the
schema validation, and each provider supplies only a `StructuredClient` that turns one request into typed
output or a typed `ModelOutputError`. `EXTRACTION_PROVIDER` (`anthropic` | `openai` | `rules`) decides;
the provider is never inferred from whichever key happens to be set, so a stale key cannot quietly take
over a run.

The OpenAI client was written against the installed SDK's own type definitions (`openai@7.23.0`), not from
memory: `responses.parse` with `text.format: zodTextFormat(...)`, `reasoning.effort`, and failure mapping
from the real response shape — a refusal is an output item rather than a status, so it is checked before
the incomplete and malformed paths, which would otherwise report a refusal as a schema failure and hide
the reason. `gpt-5.5` is the default because it is the model the shipped SDK's own documentation uses and
the newest general-purpose entry in its model enum.

**No OpenAI prices are hard-coded.** `platform.openai.com` and `openai.com` are blocked by this
environment's network policy, so published rates could not be verified, and a guessed rate would
under-reserve against the budget caps — worse than no rate, because the conservative default at least
fails safe by exhausting the cap early. `MODEL_PRICES_USD_PER_MTOKEN` lets the owner supply real rates
without a deploy; a malformed entry fails at startup rather than at spend time.

One bug this surfaced: the pipeline estimated cost against `ANTHROPIC_BASE_MODEL` at four call sites, which
would have priced every OpenAI call at Anthropic rates. Cost is now estimated against `env.modelName`, the
model the selected provider actually calls.

## 28. A named month constrains event resolution

Found in owner testing. "my wife and I want to see the knicks sometime in November, flexible on price"
resolved to a Knicks event on **2026-10-24** and said nothing about the mismatch. Every downstream artefact —
source coverage, comparison, advice, draft — would have been built on an event in the wrong month, and the
reviewer would have seen a confident, plausible header.

`resolveEvent` filtered candidates by `resolvedLocalDate` and `city` only. `dateExpression` was captured and
then ignored, so a request that named a month but no day carried no date constraint at all. With one Knicks
event on file that left exactly one candidate, which the resolver treats as resolved. This was not a
rules-extractor artefact: a model returning `dateExpression: "sometime in November"` with a null
`resolvedLocalDate` — which the extraction instructions explicitly ask for — would have hit the same path.

`monthWindowFor` turns a bare month into an inclusive local-date window (rolling to next year when the month
is already past, matching `resolveMonthDay`), and the resolver narrows candidates to it when no exact date is
known. Narrowing rather than refusing was the owner's call: it uses what the customer actually said, and
leaves the ambiguous case to ask which game rather than asking from scratch.

Two extractor defects surfaced by the same message:

- `mustAttend` was set to `false` by a bare `\bflexible\b`, so "flexible on price" was recorded as flexible
  about *attending*. That is not cosmetic: `mustAttend` drives the buy/wait decision, so a guess there
  changes the advice a customer receives, and asserting a fact the customer never stated breaks the
  extractor's own rule that unknown facts stay null. The pattern now requires the flexibility to be about the
  date, day, game, night, timing, or going.
- "my wife and I" did not yield a quantity, although the same phrase was already recognised for `forSelf`.
  It failed safe by flagging `unresolved: quantity`, but cost a clarification round it did not need.

## 29. The model extractor had no way to be exercised

Three quantity and date defects were found by hand in one session, all of them limitations of the
deterministic rules extractor — the documented fallback, not the provider that ships. The reason they were
found that way is that there was no configuration in which the model extractor could run at all:

- `services.ts` selected a model client only when `APP_MODE !== 'fixture'`.
- `simulate-inbound/route.ts` returned 403 unless `APP_MODE === 'fixture'`.

The two conditions are mutually exclusive, so the only route to the model was a real Resend webhook, which
needs DNS, a public URL and a deploy. Gate G4 was untestable, and hand-patching regexes in a fallback
extractor does not converge.

The simulator is now gated on `isProductionLike` alone, so it runs at any `APP_MODE` in development and
stays refused in staging and production. `DEV_FIXTURE_OFFERS` serves the synthetic offer set at
`APP_MODE=live` so the model extractor and the advice engine can be exercised together; `parseEnv` refuses
it outright in a production-like environment, and it defaults off, so a deploy that never sets it is
unaffected.

Verified end to end at `APP_MODE=live`: the simulator accepts a message, the event resolves, a draft is
produced, and the draft still carries "FIXTURE DATA — cannot be sent" with the send gate refusing it. The
fixture-content block never depended on `APP_MODE`, and this change does not weaken it.

## 30. A JS Date in a raw SQL template only fails on real PostgreSQL

`/admin/operations` returned 500 on the first real deployment. The cause was not the empty database it
looked like:

```
Failed query: select count(*)::int from "recommendations"
  where review_status = $1 and expires_at < $2
TypeError: The "string" argument must be of type string or an instance of Buffer
  or ArrayBuffer. Received an instance of Date
```

A `Date` interpolated into a raw ``sql`` `` template is handed to the driver unconverted. PGlite tolerates
it; postgres.js throws. Every local run and every PGlite test therefore passed, and the failure waited for
production. Two sites had it — the stale-approvals count on the operations page, and the due-watches query
in `evaluateDueWatches`. The second is worse: it runs on a cron, so it would have failed silently rather
than showing anyone a 500.

Both now use Drizzle's typed operators (`lt`, `lte`), which serialise the value correctly on both drivers.
`tests/pg/date-parameters.test.ts` runs those two query shapes against real PostgreSQL; both were confirmed
to fail with the production error before the fix was restored.

Separately, the deployment had the schema and no reference data: `preDeployCommand` ran only
`pnpm db:migrate`, while the source registry and the default kill switches are created by `pnpm db:seed`.
An operator therefore had no kill switches to flip and an empty sources page. The pre-deploy step now runs
both. `seedRegistry` is idempotent and `scripts/seed.ts` refuses the fixture world unless
`APP_MODE=fixture`, so this only ever loads reference data.

## 31. Residency is a notice, and only the customer's words set it

The first clarification asked "are you based in the US?" as a question. For the pilot's customers the
answer is nearly always yes, so it read as a chore. It is now a notice that needs no reply: "Ticket Guy is
for US-based fans for now, so if you're outside the US, just let me know." The acknowledgment already used
this opt-out form. This departs from ENGINEERING_SPEC §1's "ask for a simple country confirmation"; the owner
chose to reduce friction. What the spec protects still holds: residence is never inferred from the event,
venue or email domain, and a recommendation for an unconfirmed customer still carries "customer country
unconfirmed" for the reviewer.

Reading residence had a defect that did real harm. Any "I'm in …" phrase was taken as a country statement,
and anything that didn't say "US" was recorded as NON_US. So "I'm in a hurry" or "I'm in Brooklyn" closed a
US customer's request with "Ticket Guy is US-only for now". `src/lib/domain/country.ts` now requires the
words after "I'm in / I live in / from / based in" to be a recognised place. It reads NYC-area places and US
states as US, doesn't treat a trip ("visiting", "for the weekend") as residence, and returns NON_US only for
a named non-US place or an explicit "not in the US". Anything else changes nothing.

## 32. Assume and say, and answer "what's on?" with what's on

The owner's review of real replies: the concierge "looks for too much 100% confirmation before acting".
Two changes follow from it.

**Assume and say.** An unstated quantity used to cost a round trip ("How many tickets do you need?"),
and so did a budget with no basis ("per ticket or for everyone combined?"). Now:
- an unstated quantity is two;
- a bare budget is the total;
- the reply says each assumption once, in a line the customer can correct ("I've assumed two tickets —
  just tell me if you need a different number").

The value is written into the brief, so a later "actually four" overrides it through the ordinary
revision path, which also invalidates any draft built on the assumption. Real doubt is still asked: "a
few tickets" flags `quantity_unclear` and gets the quantity question. This relaxes
API_AND_DATA_CONTRACTS §1's mandatory fields. Recommendations remain human-reviewed, so an assumption
that turns out wrong is caught before advice goes out, not after.

**Browse.** A request that names no performer or team is not a malformed search; it asks what the
options are. It now gets up to five real scheduled New York-area events for the span named, or the
next two weeks, and says so. Quantity and budget wait until the customer picks one.

## 33. A browse list narrows by what the reply says, and a borough is a preference

Two live browse emails failed:
- "An american football game… the second week of October" listed baseball and basketball.
- "I like indie rock and roll. We are staying in Brooklyn" returned the same list as before, word for word.

The brief had no way to hold either fact. "Football" was not a kind of event, so the one word left
was "game", which means every sport. The kind of music, and a borough inside the market, were read
and then dropped.

**Football and soccer are their own categories, and the NFL is in the pilot.**
- The Giants and Jets at MetLife are some of the heaviest demand in New York, so a football request
  gets the games, not a refusal.
- NFL listings that aren't a ticket to the game are dropped: seat licences (PSLs), season plans,
  tailgates and parking.
- The provider is asked about East Rutherford.
- The Giants and Jets are seeded into the catalog.
- Soccer stays outside the pilot and says so.

**A window with nothing in it is not a dead end.** NFL teams play at home about every other week, so
the week asked for is often empty. The reply then offers the next few after it (up to six weeks on)
and labels them as later dates.

**Kind of music is `genreHint`.** It stores the customer's words, which match a genre family in
the lexicon. The catalog now stores the headliner's genre and sub-genre, falling back to the event's, because
venues file their whole calendar under one genre. The main genre decides: "pop / pop rock" is not
rock. The list is filtered by family, and the provider is also asked for that genre by name, so a busy week's first hundred shows
can't crowd it out. When nothing on file matches, the reply says so and shows everything that's on.
It doesn't send an empty list, because genre tags are uneven.

**A borough keeps the list to its venues and says so** ("say if you'd go further"). It falls back
to the whole market when nothing is on there. In event resolution, a borough no longer excludes
the market's other venues: "Knicks, we're staying in Brooklyn" still means Madison Square Garden.

**One listing per show.** When listings share a venue and a start time, they are the same show if
either name is contained in the other or they share a performer. The provider's Premium Seating
and Pinstripe Pass copies of a game therefore collapse into the plain listing.

## 34. One match is the answer, and a number already given is not asked again

"An american football game… the second week of October. We need 4 tickets." got a one-item list, then
"Reply with the one you want and how many tickets". Both halves of that are wrong: there was nothing to
choose between, and the number was in the email.

- **One match plus a quantity** goes straight on as an ordinary request. The reply is the usual
  acknowledgement and the price check starts, with one line saying why: "That's the only football game in
  New York for Oct 8–14, so I've gone ahead with it — tell me if you had something else in mind." This is
  assume-and-say (#32) applied to the event.
- **One match without a quantity** is shown as the one option ("there's one on"), and only the number is
  asked. A customer asking "what's on?" has not said they're buying, so prices wait.
- **Several matches with a quantity** ask only which one: "Reply with the one you want, and I'll check
  prices for 4 tickets."
- **Fallbacks never count as a match.** A borough or genre fallback, or the next-weeks list, always shows
  options, because it isn't what was asked for.

## 35. A shared nickname means the local team; "the other 7" means the rest of the list

**"Giants tickets Oct 11"** was answered with "which Giants do you mean?" and "which city or venue?". Asking
"which one" would have been fine; the problem was that the facts on file already answered it.

The rule is local first. It is not "biggest" or "most famous": the San Francisco Giants are not a smaller
team, and fame is not something code can compute (the LA Kings and the Sacramento Kings are both big).
- When two teams share a nickname and both have a game in the window, the one that plays in the market we
  serve is meant. That is a team named for it ("New York…", "Brooklyn…", "New Jersey…") or one playing at
  home in one of its venues.
- The reply says so in one line: "I've gone with the New York Giants — tell me if you meant a different
  team."
- When neither team is local, or both are, the customer is still asked.

Two fixes in the pieces that feed that rule:
- **The model's flags are dropped once the event is settled.** The model flags "Giants" as ambiguous and
  "no city given" from the words alone. Once the catalog has settled the event, those two flags are dropped
  instead of forcing questions.
- **The rules extractor keeps a shared nickname as typed.** It used to swap in whichever team happened to
  be listed first. Now it leaves "Giants" for the resolver to decide.

**"Can you give me the other 7"** returned the same five. Nothing marked the reply as asking for more, and
nothing remembered what had been shown. Now:
- `wantsMore` (lexicon and model) marks it, and never carries over to the next message.
- The number in the phrase counts the list, never tickets.
- The request remembers what browse listed (`requests.browse_shown`, migration 0006). The next page leaves
  those out.
- The reply says "That's everything I have…" when the list runs out.

## 36. Still on general sale: point at the official sale; buy/wait is resale-only

The owner's rule has two parts:
- "Wait or buy now is just for resale."
- An event that still has tickets through the main ticketing page gets that page, unless the customer asks
  about resale. If the event isn't sold out, resale may well be cheaper.

Both parts are kept.
- **Official prices get no buy/wait advice.** They are fixed, or they rise with dynamic pricing, so there
  is no "wait for the drop".
- **An official sale that is open now is the answer.** "Open now" means all of:
  - the provider says `onsale`;
  - the public sale window has started and not ended (`events.sale_status`, `public_sale_start_at`,
    `public_sale_end_at`, migration 0007);
  - the event is still ahead;
  - the provider's own link is on an https host we know.

  The customer gets that link, one line saying events that aren't sold out often go for less on resale,
  and "reply 'compare'". No research runs. The request state is `referred`, which stays open, so the reply
  threads.
- **"compare" (or "resale", "StubHub", "best price", "cheapest") sets `resaleAsked`.** That runs the
  resale comparison and buy/wait advice. So does asking about resale up front, a pasted listing, or a
  watch.

"On sale" is the provider's word for the sale window, not a count of seats left. The reply never claims
seats remain, and it quotes no price: event price ranges are never offers (API_AND_DATA_CONTRACTS). For
the same reason this reply goes out without review. The owner decided this explicitly: it is a pointer
to the official seller, not a market recommendation. Every reply that carries prices or buy/wait advice
still goes through review.
