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

## 37. Links go where the customer wants to go; picks, not lists; commission never picks

The owner's link rules, as built:

| Link | Destination |
|---|---|
| Event title | The official event page. Our own event brief replaces it only once a brief exists and adds something; none exist yet, and none are built ahead of demand. |
| Listen / Watch / Team page / Official site | The performer's or team's own links, **as the provider lists them** (`entities.links`, from Ticketmaster attraction `externalLinks`). Nothing is searched for or constructed. With no link on file, there is no button. |
| Event & tickets / Buy tickets | The seller's page for that exact event, through an affiliate link when one is configured for that seller (`AFFILIATE_LINK_TEMPLATES`). |
| Compare / full shortlist | Not linked yet. There is no shortlist page, and "reply 'compare'" stands in for it. No empty internal pages. |

**Discovery emails show up to three picks**, not the first five by date:
- Picks are the best fit (a sub-genre naming what was asked), spread across different days, shown in date
  order.
- Each carries one line on why it fits, built from facts on file only (the kind of music or the matchup,
  the day, the venue), plus at most two links.
- "More" pages through the rest, and paging doesn't count toward the clarification limit.

**Buying emails give one recommendation and a direct seller button.** Today that means the official-sale
reply; resale recommendations follow once a resale source is live.

**Commission never picks.** Affiliate wrapping runs after the pick or recommendation is chosen and never
feeds back into it. A test proves the same event is recommended with and without an affiliate format.

**Disclosure goes on every email with a paid link.** Any email carrying an affiliate link says: "Some
ticket links pay Ticket Guy a small commission. It never changes what we recommend." This is what an FTC
material-connection disclosure requires.

The owner sets a format per seller only after reading that program's terms on email use.

## 38. Links are words in sentences, not buttons or cards

The owner's review of the first live picks email: "hyperlink, not sections and buttons". Cards and filled
buttons made a reply from a person read like a marketing newsletter.

**Picks are an ordinary list.** Each line reads "Tue, Oct 6 — **Michael Ward** at Brooklyn Bowl.
Progressive rock. Listen · Tickets":
- the title links to the event's page;
- the other links sit inline at the end of the line.

**The reason is only what the line doesn't already say.** That means the kind of music, or the matchup. The
first version repeated the day and the venue.

**The buying email is one sentence with the seller's name as the link.** It reads "… is still on general
sale on **Ticketmaster** — that's where I'd buy your 4 tickets." Dates are written the way people write them
("Sun, Oct 11 at 1pm"), not as "1:00 PM EDT". The team or act's own link is left out of this email: it
carries one recommendation and one place to buy.

The plain-text part keeps each URL on its own line, because plain-text mail clients show no links.

## 39. National: any US market, found by metro

"Why just New York? I asked for LA." The pilot market was a handoff default, not a technical limit:
Ticketmaster Discovery covers the US, and so do the parts that work today (browse picks and the
official-sale reply). The owner decided to cover the US.

**A market is a metro, not a city.** `src/lib/domain/markets.ts` lists about 40 US metros, each with:
- a centre, a radius (35–50 miles) and a timezone;
- how people name it ("LA", "Philly", "the Bay Area");
- its venue cities, as a fallback;
- how its teams are named.

**Finding events:**
- A named metro is searched by the provider's geo search (geohash and radius), so "LA" includes
  Inglewood, Anaheim and Pasadena.
- A US town with no metro ("Boise") is searched by name.
- A place outside the US is told plainly that we cover the US only.

**Which venues count:** a venue is in the market when it is within the radius. Venues now store the
provider's coordinates (migration 0009). A venue with no coordinates counts when its city is on the
metro's list. New York keeps its borough narrowing ("staying in Brooklyn").

**When no place is named:** the market is the one the customer last asked about, else `DEFAULT_MARKET`
(New York). The reply says which it assumed.

**Shared nicknames:** "the local team" is local to that market, so "Kings" in LA is the LA Kings.

**Known gaps:**
- Venues that sell through AXS or another primary seller outside Ticketmaster aren't in Discovery. For
  LA, that probably includes Crypto.com Arena. Browse doesn't show their events until an AXS or similar
  source exists.
- The daily pre-warm still seeds only the New York teams. Other markets fill on demand.

## 40. Theater and comedy are covered; a run of dates is one pick

A Broadway request was answered "Theater isn't something I cover yet", for the same reason football was
(#33): a pilot default, not a limit. The owner had already set the structure: comedy is its own category,
and Broadway belongs under Theater & Shows.

**`broadway`, `touring_theater` and `comedy` join the default pilot categories.** Soccer remains outside
the pilot and says so.

**A run is one pick.** A show that plays many nights at one venue (a Broadway run, a two-night stand, a
series) is listed once, at its first date, with "Also 3 more performances through Sat, Oct 10". Runs are
formed before paging, so a show already sent doesn't come back as its next night. A run is never treated
as the single match that goes straight to prices: which night is still the customer's to pick.

**Category advice on the buying email** (the owner's per-category rules):
- Comedy: "Comedy clubs often add a drink or food minimum on top of the ticket, so check the venue's page
  before you go."
- Broadway: "TodayTix and the TKTS booth sometimes have cheaper seats for the same week."

The comedy note states the practice only; it claims nothing about this venue's minimum.

**Known gap: most Broadway houses don't sell on Ticketmaster.** Shubert theatres sell through Telecharge,
and others through Broadway Direct, so Ticketmaster Discovery covers only part of Broadway. Touring
theater and comedy are much better covered.

## 41. "Is $106 a good deal?" is answered; our integrations are not the customer's business

The customer asked "Is $106 for Father John Misty a good deal?". The draft queued for review:
- ignored the $106 (the model read it as a budget);
- listed 27 sources as "not integrated";
- said "I can't make a useful buy-or-wait call from this packet";
- ended with "check primary and major resale marketplaces directly", which hands the research back to the
  customer (#37).

**A price they saw is `quotedPriceCents` (with `quotedPriceBasis`), not a budget.** The lexicon and the
model are both taught the phrasings ("good deal", "worth it", "too much").

**We answer with what we do know, even without listings.** There are three new server-rendered claims:
- **C_QUOTE** puts their price against the provider's published face value. Face value is now stored
  from Discovery `priceRanges` (migration 0010): before fees, and never offered as a price to buy at
  (A12). The verdict is below face value, within it, a little above (fees can account for that), or
  well above (a resale markup).
- **C_FACE** gives the face-value range when no price was quoted.
- **C_OFFICIAL** says the official general sale is open, with a "Buy on Ticketmaster" link.

A quoted price takes the full answer path rather than the bare official-sale pointer (#36).

**The customer never sees our plumbing.**
- With no listing source checked, the coverage line is "I can't see live resale listings for this show
  yet, so this doesn't compare other sellers' prices."
- The "no history" and "0 qualifying listings" lines are dropped when there was no market to compare.
- Sources we have no integration with are listed for staff in the review console, not in the email. A
  source that should have answered and failed is still named.
- The drafting prompt forbids telling the customer to check other sites themselves, and forbids
  "packet", "claims", "sources" and "coverage".

## 42. Price checks without listings send themselves; every category is covered unless blocked

**Price checks.** The owner exempted one more class from the pilot's review rule. An answer that offers no
listing (no verified offer) but does answer a quoted price (C_QUOTE) goes out without a person approving it.
- Nothing in it needs judgement. Every fact is server-rendered from the provider's face value and the official
  sale (#41), and the model only supplies connective prose that the renderer validates.
- It is recorded as a recommendation with `reviewStatus = auto_sent` (reviewer `system:price-check`), audited
  as `recommendation.auto_sent`, and sent as `no_result` with the `raw_auto` template. That template carries
  the automated footer, not the reviewed one.
- The sign-off says "AI-assisted", not "AI-assisted, human-reviewed". A message says "human-reviewed" only
  when a person approved it.
- As soon as a listing is offered, the draft is a buy recommendation again and waits for approval.
- Known wrinkle: the acknowledgment ("Got it — checking your options") still goes out first, and the answer
  follows seconds later. It is left in on purpose. At the moment of acknowledging we don't yet know whether
  research will find listings and hold the answer for review.

**Categories.** Coverage is now everything the provider lists, minus a short blocklist.
- The blocklist is `BLOCKED_CATEGORIES`, default `high_school,conventions,attractions,theme_parks,cinema`.
  These are not live events a ticket concierge adds value on, or they are events we must not market to
  (high school).
- A request's category hint narrows the search (NFL → `nfl`, theater → `broadway, touring_theater,
  classical`); no hint searches all categories.
- `PILOT_SUPPORTED_CATEGORIES` is superseded and ignored. It still parses, so an old setting doesn't break
  startup. Keeping a curated allowlist meant every new category was refused until someone noticed (theater,
  NFL, soccer), and each refusal is a lost customer.

## 43. Sale and new-date alerts need no resale data; price watches only exist when they can run

**Price watches without a monitorable seller are no longer created.** A watch needs a seller with recorded
rights to be checked on a schedule (`monitoringAllowed`). None is connected in production, yet
`maybeCreateWatch` still created the row, and staff saw an "active" watch that could never alert. The
customer's reply already said "We are not monitoring this automatically", so nothing changes for them. Now
no row is created, and `watch.not_created` is audited instead.

**"Let me know when it goes on sale / when they announce a date" is a different product, and it works
today.** It needs the catalog, not listings. So it is built on Ticketmaster Discovery, the source we already
use:
- `notifyAsked` is a new brief field, taught to the model and in the phrasebook (`alert.notify`).
  - It is not a price watch. A price word in the same message ("let me know if it drops under $300") keeps
    it a watch.
  - It applies to one message only, like `wantsMore`, so a later reply cannot re-arm an alert that was
    cancelled or sent.
- **On-sale alert:** the event is known and the provider publishes a general-sale start in the future.
  - The reply names the published date.
  - We re-check the event just after that time, and at least daily in case it moves.
  - The alert fires when the official sale is open (the same test as the official-sale reply, #36).
  - No sale date at all is not treated as "not on sale yet": it could as easily mean sold out.
- **New-date alert:** nothing is scheduled for that performer or team in the customer's market on any date.
  - Their named city's metro is used, or nationally when they name none.
  - We check daily for 180 days and fire when an event appears, listing up to three with links.
- The "we couldn't find a scheduled event" clarification now offers it: reply "let me know". It is only
  offered when nothing is scheduled at all, not merely on the date they asked.
- **One-shot.** The alert is claimed before the email is queued, so a second pass can't send it twice.
  "Stop the alerts", "stop all emails" and deleting the contact all cancel it.
- **It sends without review.** It uses the new `event_alert` message class. It carries no prices; it is the
  official-sale referral the owner already exempted (#36), sent later.
  - The `EVENT_ALERTS_ENABLED` switch, the `watches` kill switch and a watch suppression all stop it at the
    send gate.
  - A human-approved alert would arrive after the moment it is about.
- **Cost:** each check is one Discovery call inside the existing daily budget.

**Off until the terms are checked.** `EVENT_ALERTS_ENABLED` defaults to false, in the code and in
`render.yaml`. Scheduled checks that notify customers are a use the Ticketmaster Discovery terms have to
allow, and a working key is not permission (handoff rule). While it is off, nothing is offered, created,
checked or sent.
- The check runs hourly from Inngest (`evaluate-event-alerts`).
- Or a Render cron can POST `/api/internal/event-alerts` with the cron secret.

## 44. SeatData resale market statistics: our own series, a group-aware wait rule, and a scorecard

**What SeatData is to us.** It is market data, not a seller. For each event it reports the cheapest and
median *listed* price per ticket, before fees:
- for any quantity (`get_in`) and for listings of two or more (`get_in_qty2plus`);
- overall and per seating zone;
- plus the number of active listings.

Nothing from it is ever a purchasable offer or compared with an all-in checkout total. Its sales data is not
used, because `all_in_price` is empty for StubHub rows and some quantities and prices are inferred. It is
not in the seller registry.

**Licence first.** The key alone runs nothing. A licence record (`market_datasets`, fixed id) is created
quarantined on deploy and switched per use on `/admin/market`:
- **tracking**: collect and keep series for events we follow;
- **benchmark**: typical prices from past games;
- **advice**: let it steer buy/wait;
- **customer_display**: show its numbers to customers.

Approving needs a written reference. SeatData's standard licence restricts redistribution and competing
services, so advice and display each need SeatData's written OK for exactly that use. The licence retention
date purges the raw series in the nightly sweep.

**Tracking.**
- Every upcoming event a customer asks about is followed, plus any team or performer in
  `MARKET_TRACK_ENTITIES`, one row per event (`tracked_events`).
- It is matched by the Ticketmaster event id, or by name, date and city. When a customer is waiting,
  SeatData is asked once to add a missing event.
- Polls ask only for snapshots newer than the last one held. Each is a paid request (about $0.04 pay-as-you-go)
  and returns every snapshot since the last poll, so the schedule is sparse: daily beyond a week, every
  12 hours in the last week, every 6 hours in the last two days, twice as often after a 10% move. They stop
  at the start. A customer's request refreshes its event on the spot.
- Research refreshes the event on the spot, so the first reply already has SeatData's history.
- Points are stored in `market_snapshots` with fee basis `listed_price`. The verified-total trend and
  benchmark engines therefore never mix them with all-in group prices.
- Past games of the same team at the same venue (up to 8, refreshed monthly, sampled every 6 hours) go to
  `market_history` for "typical at this point before the game". That needs at least 5 games, one value
  each.
- SeatData rescans an event about every 8 hours on its own (probe: 479-minute median gap). One small sales call a day per followed event puts it on its ~30-minute rescan.
- Calls per UTC day are capped (`SEATDATA_DAILY_CALL_LIMIT`, default 50; set it to the plan's allowance) and logged in `market_fetches`.

**Group size decides what the data can say** (the owner's correction: "prices fell" is not "wait").
- One ticket reads the any-quantity series and two read the 2+ series.
- Three or more get **no price trend**: nothing says five seats together exist. They get only the listing
  count, said to be all listings.
- A falling market can support "wait" only when it is the customer's own series, and only for a customer
  who accepts the risk and has a deadline; otherwise we ask.
- Shrinking listings (25% and 10 fewer within three days) always argue for buying, for any group, even
  while prices fall: `market_listings_shrinking`, never wait.

**Proving it before we lean on it.**
- Twice a day per tracked event the engine records what it would tell a flexible single and a flexible
  pair buyer (`shadow_advice`): wait when their series is falling and listings hold, otherwise buy.
- 24 hours later it scores that against the listed floor.
- `/admin/market` shows how often waiting saved money, what it cost when it did not, how often listings fell
  while waiting, and how often buying was the wrong call. Nothing there is sent.

**In the reply** (with customer_display): the claims `C_MARKET`, `C_MARKET_TYPICAL` and `C_QUOTE_MARKET`.
Each says "listed price, before fees" and names SeatData as market statistics, not tickets we checked.
"Past movement does not predict" still holds.

## 45. Groups of three or more get a price series built from SeatData's listings

**Why.** SeatData's statistics give a price for one ticket and for two or more, nothing larger. A five-ticket
request (the real Rangers one) therefore got no price and no trend: only the count of all listings, which
says nothing about blocks of five. The engine could neither buy nor wait and asked for the listing.

**What.** SeatData's listings endpoint (`/api/v0.1/listings/get`) returns each active listing with its price
and how many tickets it still has. For every group size an open request is asking about (three to twelve;
larger groups read twelve), each read stores one point: the cheapest listed price among active listings with
at least that many tickets, their median, and how many such listings there are (`market_snapshots`, basket
`group:N`, quantity N, fee basis `listed_price`).

- **When.** At each scheduled check of a followed event while such a request is open (the read replaces the
  daily sales call: it also puts the event on SeatData's fast rescan), and when research runs for the request
  if the last read is over 3 hours old. One paid request per read, counted in the daily cap. A failed read is
  logged and the stats poll carries on.
- **What it means.** The series behaves like the single and pair series: trend and supply need four points
  over at least 12 hours, so a new request sees the current floor and count, and the trend follows as checks
  accumulate. The count of listings that can seat the group is the group's supply signal once it has a trend;
  until then the rule uses the all-listings trend.
- **What it doesn't mean.** A listing of six may not sell exactly five, because sellers set split rules. Every
  line says "listings with 5 or more tickets" and adds that a larger listing may not sell exactly that many.
  Groups have no past-game "typical" and are not in the shadow scorecard yet.
- **Same licence gates.** Staff see it with tracking; advice and customer display still need SeatData's
  written OK.

## 46. Neighbourhoods are part of their city; Resident Advisor is where electronic replies point

**The bug.** "What about some of the cooler venues in like bushwick" got "I checked the official listings and
couldn't find any live music in Bushwick". An unrecognised place became a town of that name: the provider was
asked for events in a city called Bushwick (its venues are filed under Brooklyn), and venues were kept by that
city name. Every neighbourhood anywhere failed the same way, and the reply claimed a check that proved nothing.

**The fix.** `src/lib/domain/neighbourhoods.ts` lists the neighbourhoods people name, each with its market.
New York's also have a centre and radius and a borough: the provider is asked around the centre, venues are kept
by distance (their city only says "Brooklyn"), and the list widens to the borough, then the city, when nothing
is on, saying so. A place we still don't know, with nothing found, is asked about ("Which city is it in or
near?") instead of reported as empty. A browse reply with one result says so rather than "two picks".

**Resident Advisor.** Club nights and small venues mostly sell on DICE, Eventbrite and RA, which we can't read
(RA has no public API). Electronic-music browse replies, "we can't find that act" replies for electronic
requests, and neighbourhoods with an independent scene and few official listings link to RA's events page for
the city. Only pages that have been opened and checked are listed (`RA_EVENT_PAGES`, New York for now): a plain
link, not an offer and not an affiliate link.

## 47. A settled game stays settled; a pasted ticket link is read like the customer's words

**What went wrong.** Two live threads for the Rangers: after the game was settled, a reply of "lets do 6
tickets" and a reply that was only a StubHub link each came back "Which game: Thu, Oct 1 or Tue, Oct 13?".
Every reply re-identified the event from scratch from the merged brief. Our own quoted email under the reply
("When: Thu, Oct 1, 7:00 PM EDT") reached the extractor as the customer's words, because a Gmail attribution
wrapped over two lines, and html-only replies, were not cut. The link itself was never read.

**The fix.**
- An event the request has settled is kept when the new message names no other team, show or date, or when
  what it names still fits that event (it is among the candidates). A reply naming another date or team
  still moves it. A settled event that was cancelled or has been played is not kept.
- Quoted threads are cut at a wrapped "On … wrote:" line, an Outlook rule, and, for html-only mail, at the
  Gmail, Apple Mail and Outlook quote markers.
- Links to StubHub, Ticketmaster, SeatGeek, Vivid Seats, Gametime, TickPick and AXS are read from the URL
  alone, never fetched: the date in the path, `quantity`/`qty`, the listing id and the team in the slug. The
  link's date wins over a looser phrase; a quantity or team the customer typed wins over the link.

## 48. Boundaries: off-topic mail and floods

**What went wrong.** "Can you tell me something interesting about New York city? also, are you an idiot?" was
answered as a ticket request: "Two tickets. Got it. Which event…? I've assumed two tickets."

**The rules** (`src/lib/intake/boundaries.ts`).
- A first message counts as off-topic when it names no one and nothing, no kind of event, no quantity, budget,
  price, date or link, asks for no action, and uses none of the words people use for tickets. A city on its own
  doesn't make it a request. Whatever the model calls the intent, the same checks decide. The sender gets one
  short "I only do tickets" reply, at most once every 24 hours, and the request is closed. Nothing is assumed
  and the content is not engaged with. A later real request, in the same thread or a new one, is answered
  as usual. Replies inside an existing request are never treated as off-topic: a bare "Either." or "Thursday!"
  answers our question.
- A sender over 10 inbound emails an hour or 30 a day gets no model call and no reply until the window
  passes. The count covers this email and those stored before it. Staff are alerted once a day (the request
  goes to manual attention). Nothing is sent to the sender.

## 49. Not playing where they asked: offer the nearest shows

**What went wrong.** "Two Metallica tickets soon in NY" got "We checked the official listings and couldn't
find a scheduled Metallica event in NY". The tour wasn't stopping inside the New York market's 35-mile
radius, though there were shows in Connecticut, Philadelphia and Foxborough. The event match and the
provider search were both confined to the market named, and nothing looked beyond it.

**The fix.** When a performer is named with a place and nothing matches there, the performer's other US
shows in the same window are read. The local catalog comes first, then one national provider search if the
catalog has none. They are ranked by distance from that market's centre:
- Shows within 300 miles are offered, up to three, closest first, each with its distance ("Sat, Oct 24 at
  Hartford HealthCare Amphitheater, Bridgeport (about 55 miles from New York)").
- A coast away is offered only when there's nothing closer, and the note then says so ("the nearest shows
  are a trip away").
- When exactly one show fits a date the customer named, or one lies within 60 miles, it is taken as the
  answer, and the reply says where and how far ("… so I've gone with …. Tell me if that's too far.").
- A reply naming one of the offered dates settles on that show.
- The "let me know when there's a date here" offer stays, worded as waiting for a date in their city.

## 50. The deal check: read their listing, check it, compare it, and measure whether it helped

The promise is "send your ticket link or screenshot: I'll check the price, flag important catches, and look for
better options". This entry covers the work that completes it against the gap analysis
(`docs/PRODUCT_GAP_ANALYSIS.md`).

**Wrong advice fixed first.**
- Accessible-only seats are excluded for a buyer who didn't ask for access, as well as the other way round
  (R18). Staff can mark a manual listing as accessible, obstructed or a VIP package; wheelchair, companion,
  parking and suite listings never set a group's floor.
- A quoted price carries its source (typed, pasted listing, screenshot), fee basis and time, and is never a
  verified offer.
- Face value is the original price, not value. Under it is a reason to check the seats, and well above it
  isn't called bad. Under the resale floor is "unusually low", not "a good price".

**Their listing.**
- Screenshots and pasted listing text are read into `listing_evidence`, with the source and the time sent.
  Nothing is inferred and unknown stays null.
- A barcode, card or ID screenshot is deleted unused and the customer is told.
- We never open marketplace pages. A link alone gets a request for a screenshot or the price and section.

**The comparison.**
- The email opens with a server-written recommendation: don't buy it as it stands (and why), look at a
  cheaper verified option first, look at cheaper market listings first, or where its price sits.
- Then comes what it shows, a short list of catches, cheaper market listings (their section first, then their
  area), and either the verified alternative or "none yet". Seller links go last.
- Market listings are prices before fees without links. They're said to be neither their seats nor checked,
  and a listing in their own section and row is never offered, since it may be the same seats.

**Timing.**
- Trend lines need a fresh series for their group size and seats.
- Waiting is suggested only to a buyer who has said they can take the risk and when they must decide.
  Someone travelling, or who must go, is told not to hold out. Otherwise the reply says the evidence doesn't
  settle it and asks those two questions.

**Measurement.**
- Every request carries problem-type tags.
- Outcomes are kept by kind: clicks (via `/go/<id>`, likely bots flagged), what the customer said,
  affiliate-confirmed purchases (staff-entered), and the follow-up.
- "Bought" and "stop" replies close the request and stop watching.
- One follow-up goes out after the event, off until `FOLLOW_UP_ENABLED`.
- `/admin/pilot` counts only real requests toward ten.

**Dependencies, kept separate.**
- Inventory access: a listing partner, for verified alternatives with links.
- Historical and customer-display rights: SeatData's written OK.
- Affiliate approval: needed for commissions and confirmed purchases.
- None of these blocks the deal check itself, which works on the customer's own evidence.

## 51. Geography that works live, and one thread in Gmail

Live, "Two Metallica tickets soon in NY" still got "couldn't find a scheduled Metallica event in NY". The reply "They are playing in Connecticut" got the same email again, and our first reply opened a second Gmail thread. The #49 tests passed only because the shows were already on file. Live, they come from Ticketmaster.

**Causes.**
- The national search (#49) was skipped as fresh. A search with no place counted any recent search for the same name, including the New York one that had just come back empty.
- Freshness also ignored the date window. A fresh October search stood in for March.
- A new place in a reply was merged field by field. City "NY" stayed beside state "CT".
- A state on its own was never searched.
- The customer wrote with no subject, and our reply used a subject of its own. Gmail groups a reply into a thread only when the subjects match, as well as the reply headers.
- Bare Message-IDs from the provider were sent unbracketed and never matched our lookups.

**Now.**
- Freshness is keyed by keyword, place and window. The place is a city, a geo point, `state:XX`, or none for a national search.
- With no date given ("soon"), the national fallback searches six months ahead.
- A reply that names a place replaces the old place as a whole.
- A state as the place ("Connecticut", "CT") filters venues by state and asks Ticketmaster with `stateCode`. "NY", "New York" and "Washington" still mean the metro.
- Replies to a subjectless email are "Re:", so they stay in the customer's thread.
- Message-IDs are bracketed on the way in and on the way out.
