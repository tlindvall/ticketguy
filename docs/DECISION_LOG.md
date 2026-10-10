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

## 52. The Sep 29 live-email audit (TGQA-0929): answer their question, keep their requirements

A black-box audit sent 16 test emails. Each fix below is covered by the acceptance test named in `tests/unit/audit-0929.test.ts`.

- **TG-B01 (Hamilton, A05).**
  - An open official sale no longer stands in for seats. Seats together, a budget, access needs or a seat preference turn "that's where I'd buy" into a neutral event link, with each need listed as still to check.
  - Any quantity other than 2 comes with a line saying the seller's page may start at 2 tickets.
- **TG-B03/B04.**
  - `C_READ` called the venue-wide floor × 1.15 "a fair price" (confirmed in code: `packet.ts` `fairUpTo`). That is gone.
  - With a budget, the reply sets the cheapest price for the whole group, before fees and with its age, against the whole-party budget.
  - Without a budget, it says where the market starts, not what seats are worth.
- **TG-B02 (A08, A03).**
  - A delivery-against-travel question gets `C_DELIVERY` first. It says a refund is not admission and promises nothing.
  - A question about wheelchair spaces gets `C_ACCESS`: they are not a cheaper version of ordinary seats.
- **TG-B08.** A detail missing from a pasted summary is "You haven't included …", and from a screenshot "The screenshot doesn't show …". It is never a claim about what the seller shows.
- **TG-B10 (A07).**
  - A watch request is answered with the stored watch's status. It counts as running only when a stored watch is active and `WATCH_SEND_ENABLED` is on.
  - A cancellation is always acknowledged, from what was actually stopped.
  - It is scoped to the thread's requests: other requests and email preferences are untouched.
- **TG-B06.**
  - The first rate-limited email gets one holding reply.
  - The staff alert states what the customer was actually sent, read from the send record.
  - Cancellations and opt-outs skip the inbound limit, up to 3 times a day.

**Already fixed before this audit's findings were read:** B05 (Connecticut), B09 (US-only), B11 (no-subject threading) and B12 (unfinished template lines), in #51 and #52.

**Still open:**
- B05: the quantity change that reopened a settled date, and the Bushwick window reset. Both predate #45 and #51 and need a retest.
- B07: discovery exclusions.
- Verified purchasable offers: a listing partner is still needed.

## 53. Audit round 2: exact replay, no value bands, their offers compared

The remediation review and the live retest after #53 found remaining floor-markup verdicts and a missed two-offer question. Replaying the exact audit emails also turned up cases the reconstructed tests had missed.

- **No price band decides a verdict or a filter.** The ×1.15 and ×1.30 bands are gone from `verdictClaim` and `C_QUOTE_MARKET`, and the 1/1.3 fee allowance is gone from alternatives. The email states the observed gap and its basis.
- **Budget framing.** "Five at that price would be $X, which leaves $Y for fees; unconfirmed" replaces "under your budget". Over budget: "that doesn't prove nothing cheaper exists now".
- **Offers the customer writes out** are kept separate (`offersInText`) and compared as the question (`C_OFFERS`). Wheelchair spaces nobody needs are not the one to buy.
- **Deterministic guards after any extractor:**
  - an explicit watch cancel is a cancellation, but "stop this watch on <date>" is an expiry;
  - "neither of us needs wheelchair seating" means no access need;
  - "in London, UK" is out of scope.
- **Watches.** None is stored while watch alerts are off. A cancel is scoped to its thread and closes the request.
- **Other additions:**
  - `C_REQS`: hard requirements are said as unchecked when nothing verified meets them.
  - `C_LEFT_OUT`: rejected cheaper listings are named, with the reason.
  - `C_SALES`: "asking prices, not sales".
  - The official-sale reply is deduplicated per revision.
  - The headline shows the budget.

## 54. A person finds the seats, once a person owns it; cancellation proven in the database; London is not the event

Response to the review of round 2.

**Accuracy is not usefulness.** "I haven't checked those requirements" is honest, but it leaves the customer to do the shopping. The staffed comparison pilot closes that gap for up to 20 customer requests. The next section covers how it works.

**Staffed comparison pilot.**
- **When it runs:** nothing verified meets the request's requirements (or the customer asked to compare) and a named owner exists (`STAFF_COMPARISON_OWNER`, a staff address).
- **What the customer sees:** the email says a person is looking, checking sellers by hand, and will reply in the thread with options and all-in totals, or say plainly that nothing fits. It doesn't ask the customer to go and find seats.
- **Handoff:** once the email is sent, the request waits on the owner. The owner's alert says what the customer was told and what to record.
- **How staff answer:** staff record what they checked as manual offers and re-run research. The existing comparison engine then sends the answer: requirements applied, whole-party totals, rejected options named with the reason.
- **Measurement:**
  - `staff_comparison_offered` records the promise.
  - `staff_comparison_answered` records the time to a verified option and the seller used.
  - `/admin/pilot` shows both.
- **Limits:** the limit counts customer requests only. With no owner, nothing is promised.

**Cancellation, backend.** Two gaps were found by testing stored state rather than the reply email:
- A customer's cancellation left already-approved watch alert sends queued. Every cancellation path now invalidates pending alerts and blocks queued alert sends (`stopWatchAlerts`).
- Dispatch looked a watch alert's approval up in the recommendations table. That would have blocked even valid alerts ("not approved"), and ignored a cancelled watch. It now reads the alert's own approval and the watch's state and generation.

`tests/acceptance/cancellation-isolation.test.ts` proves it: two threads, queued alerts on both, an event alert, and a repeated cancel on the closed thread.

**Abroad vs. residence.**
- The "in London, UK" guard now fires only when the event is there. The city the extractor chose must be negated ("not New York") or not a US place, and the place must not follow "I live in", "my sister in", "visiting from" or similar.
- "I live in London, UK, but want Hamilton in New York" is declined by the residence rule (US customers only, ENGINEERING_SPEC §1), with the residence reason. It is not refused as an event abroad.
- "My sister in London, UK recommended…" is a New York request.

## 55. Their offers, one record each; the screenshot that never arrived (post-#54 QA)

**Their offers.** When a customer copies two or more offers, each becomes one record: quantity, can't-split, view, access, together, fee basis and a per-order fee. The comparison then:
- works each whole-party total out once, with a per-order fee added once;
- applies the hard requirements before comparing prices: the quantity they can actually buy, a view they ruled out, access, together, and the budget;
- names each left-out offer with its reason;
- measures the pick against the offer they asked about.

That comparison is the whole answer. The same email is not also read as one listing, and there is no quote, market read or "send me a link" ask. An offer's price is never taken as their budget.

**Screenshots.**
- Resend's received email lists attachments without download URLs, so signed URLs are fetched from the attachments endpoint.
- An attachment that can't be fetched is recorded on the message.
- An image that isn't read is said plainly, and nothing is assumed in its place.

**Other wording fixes.**
- Market floors always carry their check time and scope, and never read as a minimum for every seat.
- Discovery honours "no pop / tribute / kids".
- A delivery or offer question gets no buy-or-wait passage.
- A no-match with a date and place already given offers a next step instead of re-asking.

## 56. Every hard requirement before any price; the same offers across the thread; entry help

**Their offers.** Each supplied offer is judged on every requirement the customer gave before any price comparison:
- attendees versus tickets bought, extra tickets refused or allowed (the latest word wins), and a block that won't split;
- view, access and together;
- the time the tickets must arrive, which a late or unstated delivery fails;
- the budget.

An offer with unknown fees is compared by break-even, never called a fit. When nothing fits, the one change that would make an offer work is named. A follow-up that changes a requirement re-judges the same offers.

**The listing we read.** One price object: a total that carries fees over a before-fees ticket price is compared as its all-in share. A typed correction overrides the read and is acknowledged first.

**Other changes.**
- Discovery enforces start-time windows and flags an unverified age policy.
- "I already bought, will this barcode get us in?" gets sourced official-transfer guidance, not intake.
- Doors are stored and shown apart from the start.
- Writing: the decision comes first and is the only emphasis, and comparisons carry nothing that doesn't change the choice.

## 57. Test mode: everything runs as live, and email is recorded instead of sent

**Why.** Testing hit Resend's daily quota. Resend counts received mail against it as well as sent mail, so a tester writing in from Gmail uses it up from both sides.

**What changes.** An admin turns test mode on at `/admin/test`. It is a `test_mode` row in the switch table: read at every dispatch, audited, and off when the row is missing.

- The dispatcher runs as normal: claim, then the gate, then everything after a send (state changes, the staffed-comparison hand-off). The one step that changes is the provider call, which is replaced by a record:
  - the send is marked `provider_accepted` with a `test_…` id;
  - the email becomes an outbound message with provider `test` and its own Message-ID, so a reply can thread on it;
  - the audit log gets `send.captured_test_mode`.
- Staff alert emails are skipped with `test_mode`.
- The tester allowlist does not apply to a recorded send, since it reaches nobody. Every other gate check still applies.

**Test customers.** Test customers write in without real mail. They use the admin board, or `POST /api/test/inbound` with a bearer `TEST_AGENT_TOKEN`, so an agent needs neither an inbox nor a staff login. The message enters through the ordinary intake:

- a reply carries the In-Reply-To and References a mail client would set for our latest email;
- by default it quotes that email the way Gmail does, so the quote stripper is exercised;
- screenshots go through the same image checks.

**Safety.**
- Writes are refused while test mode is off.
- The API reads only conversations a test customer wrote in.
- Such a conversation stays test-only when test mode is turned off: nothing in it is ever emailed, so an invented address never gets real mail.
- Test mode stops real customers' replies too. The banner on every admin page is there so nobody forgets it is on.

## 58. A spent or refused AI budget still answers; customer work that keeps failing goes to a person, saying why

**Budget.** Spend is what calls actually cost: a settled call at its tokens times the configured rate, and a reservation only while its call is running. Every finished call counts toward the per-revision call cap. The operations page shows the model's configured price, or a red badge when it is costed at the high fallback.

**What happens when the model can't be used.**
- **Budget used up:** the email is read by the deterministic rules reader and answered from what the customer wrote. The stop is audited and counted.
- **Provider refuses the call** (unknown model, bad key, no quota or billing, invalid request): the same, with a red count on /admin/operations, because the setting is wrong for every email, not this one.
- **Timeouts and rate limits:** retried, but customer work gets four tries. After that the request goes to a person with the provider's error in the staff alert, and the customer gets the holding reply once.
- **A refusal, malformed or truncated output:** about this message, so it still goes to a person.

A parked request can be re-read from its admin page ("Read the latest email again"), and dead events can be replayed from /admin/operations. Both are idempotent.

**Holding reply.** It says the request needs a manual check and that the answer will come in the thread. It gives no hours or reply time that nothing enforces.

**Offers.**
- A follow-up that keeps one offer from an earlier comparison ("ignore A, only B") is judged alone, and the reply says so.
- Named offers ("the green listing", "the first seller"), per-ticket fees, "$X all-in for both" totals and seller time zones are read.
- Offer lines give the reason, not a status label.

**Synthetic examples** get what they show and the arithmetic, never market, checkout or availability advice. A hypothetical price comparison is answered from the customer's own two numbers.

## 59. Event constraints come from the thread, and a broken constraint is said, never swapped silently

**Rules.** The thread's own words give the rules for which event, with the latest message winning each dimension:

- venue;
- home only;
- time, strict or not;
- weekdays;
- a window;
- "the next one";
- the ticket link's event.

Every place that picks an event applies them: resolution, the settled-event check, browse and the nearest-city fallback.

**When nothing fits.** The reply names the dates it found and why each fails. It offers the next event that keeps every rule, and goes ahead with that event only when the latest message named no date. A fenced window ("November ONLY") or a named venue is never widened.

**Quantity.** An unstated quantity is unknown and asked once (TGQA-R6 1008). A per-ticket price check is the one exception: it goes ahead on two and says so, because the verdict doesn't depend on party size.

**Preference and deletion flows.** An opt-out gets one acknowledgment built from the stored suppressions. An exact CONFIRM verifies a pending deletion before any other reading of the email.

**Test API.** It exposes the trace, the stops, the deletion status, the kept offers with where each came from, and each email's HTML, for test conversations only.

## 60. Hard rules are checked on every path, whatever the model left out

TGQA-R8 showed the model path leaving fields empty that the rules path fills: no city, no resolved day, a budget without budget words. Every hard rule is therefore read again from the customer's own words and checked before anything is ranked or linked.

**Budget.** The comparison keeps the budget they gave however it was worded ("$500 TOTAL"). It drops it only when the amount is one of their offers' own prices.

**Seating.** How the party must sit is its own requirement: all together, adjacent pairs with each child beside an adult, or anywhere. The latest message wins. Adjacent pairs pass the pairs rule, and scattered singles don't.

**Deadline.** Their deadline is read wherever they state it, in any of these forms:
- "my deadline is 1pm New York";
- "need them by 12pm Pacific";
- "can accept delivery until 3pm", even in a sentence that also mentions an offer.

It is stored with its zone and compared with each offer's promised transfer, and the reply shows both clocks. A promised time is never called a completed transfer.

**Home and venue.**
- A game outside the team's home market is away, whatever the synced name implies ("Knicks v 76ers" in Philadelphia). The sync, the resolver and settled events all apply this.
- Well-known venue nicknames are built in ("MSG", "the Garden", "Barclays", "UBS", "Prudential").
- A venue they exclude is never searched.
- A date that breaks a rule is named with the reason. The alternatives are offered as another date, and the reply never claims they fit everything.
- "Weekend" means Saturday and Sunday for a game. For a concert, club night, comedy or theatre it includes Friday night, as the date window always did (audit gap 15, Oct 10).

**Dates.** When the model leaves the day unresolved, the deterministic reader fills it in from the model's own date phrase or the email ("Monday October 5", "this coming Friday", "fri"). The timezone comes from the venue, else the team's market, else the pilot market's. The reader never pins one weekday out of "Saturday or Sunday".

**Offers.**
- Offers are one record each across the thread. A later mention updates only what it states, a renamed offer ("Offer A (Gold)") is the same offer, and a follow-up that changes a requirement is judged on the same offers.
- Labels can be letters, names, sellers or "Name:".

**Routing.** A buy-or-wait question is answered before the official-sale pointer. The following are answered and the request closed, with no ticket intake:
- a capability-only question about on-sale alerts;
- a food-only follow-up;
- a question about the stops on file.

**One email.** An answer that goes out unreviewed (testing auto-approval, or an auto-sent price check) is not preceded by a "checking your options" acknowledgment unless that acknowledgment carries an assumption or a pick.

## 61. Service depth: a category sets investment, evidence sets what can be said

**Decision.** One typed, deterministic policy decides how much work each request gets (`src/lib/domain/service-depth.ts`, policy `sd-1`). There are four internal levels: Core, Compare, Guide and Outside. The levels are never named to customers.
- **Concerts in touring formats and major-league sports** are Core: live comparison, history, buy/wait, tracking, price watches and the staffed pilot, where rights and data allow.
- **Adjacent categories** are Compare: the offers we can see or the customer sends, plus official alternatives. No tracking, history or watches.
- **Long-tail admission** is Guide: the official route, the checks that matter, and arithmetic on what they send.
- **Classes, tours, permits, travel and online-only/betting** are Outside: a short scope reply, with a known official pointer where there is one.

**Every route is mapped on purpose.** All 29 routing keys plus `food_drink`, `unknown` and the five Outside intents have a depth. Adding a key without one is a compile error.

**Format, not genre, decides.** The format is read from the venue and the event name. Electronic music at an arena is a touring concert; at a club it is a club night. A concert whose format can't be read is Compare at most. An unknown category is Guide and never Core. The catalog now files unrecognised provider classifications as `unknown`, not `concert`, and keeps the provider's taxonomy on the event.

**Policy and capability are separate questions.** An operation runs only when the depth allows it AND current rights, configuration and coverage allow it. Unknown is never available.
- A price watch needs a monitoring source that covers this event, not just one that exists.
- Live comparison needs an integrated, approved quote source.
- Tracking needs the SeatData key and the licence.
- An operator block (`BLOCKED_CATEGORIES`) allows the official route only, and no override lifts it.
- A promotion is a staff-approved, expiring override for named events or entities (`SERVICE_DEPTH_OVERRIDES`). It raises depth only, and never on category, price, genre, city or payout.

**Every entry point checks at the moment it runs:**
- **Source planning.** The source plan keeps integrated, approved, covering sources, within the depth's budget. An empty plan stays empty, with no generic Ticketmaster/SeatGeek/StubHub fallback.
- **Research.** Benchmarks, trends, tracker refreshes, listings reads and the staffed pilot run only where allowed.
- **Market tracker.** Enrolment, direct refresh and due polls are all gated. A row is kept only while a reason still holds: the named cohort, or an open request whose depth tracks.
- **Watches.** Watch creation, evaluation, alert approval and dispatch each recheck the depth and rights. Human approval is not a capability override.
- **Drafts.** A draft whose claims rely on an operation that has since been withdrawn is blocked at send (`policy_changed`).

**Watches keep every hard requirement (F04, a correctness fix in every mode).**
- A watch stores the full constraint basket of its own revision: accessibility, together or pairs, delivery deadline and anything no listing can show, such as an age policy.
- Evaluation searches with the basket and judges with the same eligibility as the first comparison.
- An unverifiable requirement means no actionable alert.
- A watch that can no longer run is paused with its reason, and anything unsent is invalidated.

**Stopping price watches leaves event alerts alone.** "Stop monitoring the prices" stops price watches only. An on-sale or announcement alert stays on, and the reply says so.

**Rollout.**
- `SERVICE_POLICY_MODE=off|shadow|enforce`, defaulting to `shadow`. Shadow records each decision and every "would block" without changing a reply or adding a provider call.
- `pnpm service-depth:reconcile` lists what enforcing would pause or invalidate in existing work; `--apply` does it.
- Off never disables consent, evidence, source-access, suppression or safety checks.
- The watch-constraint and event-specific coverage fixes, and the removed empty-plan fallback, apply in every mode.

**Why.** Equal effort everywhere either spends money on categories we can't serve well, or promises history and alerts we can't deliver. Depth by category with capability by evidence keeps the deep work where it pays, and the honest answer everywhere else.

## GPT-6.1 Sol replaces gpt-5.5 for extraction, listing reads and drafts (owner-directed, Oct 1 2026)

- **Model.** `OPENAI_BASE_MODEL` defaults to `gpt-6.1-sol`, and the Render blueprint now pins it, so production runs the model this repository names. The SDK moves to `openai@7.25.0`, the first release that lists `gpt-6.1-sol`.
- **Effort.** It stays at `low`, following the GPT-6 migration guide's advice to keep the current effective effort. The model's own default is `medium`. It rejects `none` and `minimal`, and the env schema never offered either.
- **Request shape.** The rest of each request already matches the guide:
  - the Responses API, with a strict Structured Outputs schema;
  - no tools;
  - no `temperature`, `top_p`, `top_logprobs` or logprobs `include`;
  - no `prompt_cache_retention` to migrate.
- **`store: false` is now set.** Every call is self-contained and nothing reads a stored response back. Leaving the default meant each customer email and screenshot stayed on OpenAI's side for at least 30 days.
- **Still open: pricing.** The model page with pricing was not readable from this environment. Until `MODEL_PRICES_USD_PER_MTOKEN` is set, spend is counted at the conservative fallback rate.
- **Still open: token caps.** The output-token caps (4,000 and 8,000, which include reasoning) are unchanged and should be checked against the model page.
- **Still open: `safety_identifier`.** The GPT-5.6 guide recommends it for apps that serve end users, and we don't send it yet.

## 62. SeatData's resale listings can run a price watch, as a heads-up on listed prices

**Why.** A customer asks "4 Knicks tickets together under $400 for next week's game, alert me if you find them". Before this, nothing could watch it. A price watch needs a source we may check on a schedule, and no seller feed is connected. SeatData already reads every listing for followed events (#45), so it can see "a listing for four or more is now $75 a ticket". What it can't give is a verified offer:
- prices are before fees;
- there is no link;
- nothing checks the seats are adjacent, or that the seller will sell exactly four.

**What.**
- **Where it runs.** `price_watch` can use SeatData (source `seatdata`) when no seller covers the event. It needs all of these:
  - the SeatData key;
  - the licence's new **alerts** use (on `/admin/market`, written reference required, tracking required too);
  - the event followed on SeatData.

  While email is limited to the test allowlist, tracking alone is enough, as for market numbers in replies (internal use). A seller that covers the event is still preferred.
- **Creating the watch.** It follows the event on SeatData first. It refuses a watch whose requirements listings can't show, and audits why (`market_unverifiable:<reason>`): accessible seating, sections, a delivery deadline, or an age or entry rule. The constraints carry `monitor: 'market'`.
- **Checking it.** The first look is 5 minutes after the request, then no more often than every 3 hours. Each look is one paid listings read, under the daily cap.
- **When it alerts.** It takes the cheapest listed price among active ordinary listings with at least the party's count. It alerts only when the listed total plus `MARKET_WATCH_FEE_ALLOWANCE_PCT` (default 30) fits the all-in target. Example: $75 × 4 = $300, so about $390, which is inside $400.
- **Repeats.** Dedupe, the daily cap of 2 and the re-alert rule apply to that estimate. A repeat must be at least $10 AND at least 5% below the lowest total already alerted (the larger of the two; corrected in #63, which also replaced the band key).
- **The alert record.** It carries what it saw (`watch_alerts.market`: listed price, totals, allowance, listing count, read time), not an offer observation. Migration 0018 makes `observation_id` nullable, with exactly one of the two set. The evidence is kept on the alert because the licence retention sweep deletes market rows.
- **A watch keeps its kind of source.** A watch created on a seller's verified totals is paused when the seller goes, and never continues on SeatData estimates. A seller alert is also never approved or sent on SeatData's rights.
- **Approval and sending.** Staff approve it like any alert, and the staff page shows that it's an estimate. It is "now" for 3 hours from the read: approval and dispatch both refuse an older one (`stale_observation` / `evidence_stale`). Policy, the licence and rights are re-checked at approval and at send.
- **What the customer is told.**
  - **When the watch starts:** "I'm watching resale listings for this: if listings with 4 or more tickets show up at a price that, with fees of up to 30%, fits your $400 in total, I'll email you a heads-up." It adds that there's no link, and no promise of seats together or of exactly four.
  - **The alert itself** (`watch_alert_market`) gives the listed price and the estimate with the allowance named. It says it's market data from StubHub and Vivid Seats listings, not a ticket we checked, and that the customer should check the all-in price at checkout. It never says "found", never gives a link, and never names SeatData.

**Still needed before customers get these.**
- SeatData's written OK for alerts that show their listing prices to customers. The standard licence restricts redistribution.
- `WATCH_SEND_ENABLED=true`, the watch scheduler (Inngest, or `POST /api/internal/watches` from a cron, added here because no fallback existed), and staff approval of each alert.

**Not proven.**
- **Fee allowance.** The 30% is an assumption, said as one. Actual StubHub and Vivid Seats fees vary, so an alert can still be over budget at checkout.
- **Speed.** A 3-hour cadence and SeatData's own rescan (about 8 hours, about 30 minutes after a sales call) mean a cheap listing can come and go between looks.

## 63. Price watch repeats: exact-price keys, an all-time baseline, and a claimed check

**Why.** QA wave 1 on #78 (`docs/qa/PRICE_WATCH_QA_WAVE1.md`) found these problems:
- the band dedupe key put every total above $200 in one band, so a $390 → $260 drop never alerted;
- sections and late-entry rules never reached the market-watch guard;
- overlapping ticks paid for two reads and over-counted alerts;
- the brief said "$10 or 5%", but the code needed both.

**What.**
- **Repeats.**
  - The dedupe key is the exact total, so the same price never alerts twice.
  - A repeat must be at least $10 **and** at least 5% (the larger) below the lowest total already alerted in that watch generation, at any time. An alert the system invalidated never reached the customer, so it is no baseline.
  - The daily cap still counts every alert in the rolling 24 hours.
- **Hard requirements.**
  - Section rules (`sectionsRequired`) and entry rules (`entryNeed`) are read from the thread and the model's fields into the basket.
  - A market watch with either is refused (`market_unverifiable:sections` / `entry_rule`).
  - When the late-entry reply answers first, it records `unverifiable:entry_rule` and says no watch was set up.
- **Claiming.**
  - A due watch is claimed by moving `next_check_at` on, while it is still due, before any read.
  - A crash waits a cadence rather than retrying a paid read.
  - Alerts are counted from the rows actually inserted.
- **Copy.**
  - The creation reply says once that it's monitoring, not checked seats, and calls the fee allowance an assumption.
  - The alert leads with the bold estimate, and its footer doesn't promise a link.

**Not decided here.** Whether a stale-invalidated alert should free its exact price for a later alert. It doesn't today.

## 64. Every SeatData attempt counts against the day; a requirement listings can't show is the watch's stated reason

**Why.** The retest on the deployed `a80744b` found four problems:
- a retried 503 with one call left made three attempts;
- a relative late-entry need ("after the show starts") vanished from the reply;
- a stop email's question went unanswered;
- the replies buried the blocker under repeated price maths and three questions (`docs/qa/PRICE_WATCH_RETEST.md`).

**What.**
- **Call cap.** `SeatDataClient.callCap` is checked before every HTTP attempt, retries included. The tracker sets it from the remaining daily allowance before each paid operation.
- **Hard-requirement check first.** With no seller that may be monitored, a requirement a market watch can't honour (sections, accessible seating, a delivery time, an age or entry rule) is checked before the switch, licence and capability gates. A missing budget or quantity is audited too.
- **Reason-specific replies.** The research reply names the recorded reason for no watch.
- **Late entry with no clock time.** It gets the late-entry answer: unverified, nothing on file, don't buy on the start time, no ticket suggested.
- **A stop with a question.** The stop is done first, and then the late-entry question is answered from what's on file.
- **Watch requests.** They get one next step (the budget when missing), and an open sale is shown as an event page, not "where I'd buy". "My read" no longer repeats the floor the market lines already give. An event page is never called a listing.

**Not done.** A shared atomic quota across overlapping evaluations of different watches. Each operation is capped, but two at once can each spend what's left.

## 65. A listing's own age rule, a negated city and an expired recommendation are hard stops

**Why.** The Research 2 retest on `a80744b` found these failures (`docs/qa/R2_DISCOVERY_LINK_RETEST.md`):
- a 21+ night was offered to a group with a 20-year-old;
- "skip Constellation Room" made it the venue to search;
- a "$300 TOTAL including fees" cap was dropped;
- "prefer Elsewhere, another venue is fine" fenced the search;
- Franklin was offered after "not Franklin";
- expired advice still redirected;
- a buy link pointing somewhere else still redirected.

**What.**
- **Age.** A minimum age comes only from the listing's own title. A group member under it, or the group's own "no 21+", drops the listing before any pick, link or reply branch, and the reply says why first.
- **Venue cues.** Skip, leave out and don't include are exclusions. A venue named as a preference is not a fence; "only" still is.
- **Cities.** A negated city among the candidate venues' cities is out wherever the metro reaches, but never the city being searched. A later "is fine" lifts it.
- **Budget.** A "$X total including fees" cap in a sentence without offer words is their budget.
- **Buy links.** A link stops when its recommendation's `expiresAt` has passed. It also stops when its destination isn't one stored with the advice's chosen offer (direct or affiliate), and `?current=1` doesn't override that.

**Not decided here.** Where venue age and entry policies would come from. Until a source exists, they are said as unknown.

## 66. The advice email's header is two lines, the official sale opens when nothing else does, and a count is not a price

**Why.** A live email (Red Wings vs. Rangers, five tickets, from a StubHub event link, on sale on Ticketmaster, the game that evening) was hard to read and partly wrong:
- the whole brief ran together as one bold line that wrapped into a block;
- Ticketmaster came up three times: the model's opener ("the place I'd start"), the official-sale line, and the link;
- a listing count was footnoted as "StubHub and Vivid Seats resale prices before fees", but no price was shown;
- 1928 and 2584 were printed without commas;
- it asked for "the link" (we can't open marketplace pages, and they had sent one) and a per-ticket budget for five;
- nothing said the game was that night.

**What.**
- **Header.** The event in bold, then a lighter line: where · when · the party · the budget. "Tonight" or "Today" goes before the date for a game later that local day. That is a day word, not "in 3 hours", so it stays true while a draft waits for review. "From the StubHub link you sent" is only said for a listing, not an event page. Packets from before the change keep their one-line `headline`.
- **Opening.** With no answer to their own question to lead with, no listing of theirs and no verified offer, the official-sale line opens the email in the server's words, and the model's opener is dropped. Its link stays at the end.
- **Market.** A count-only market is footnoted as a count ("That count is from StubHub and Vivid Seats…"). Listing counts get thousands separators.
- **Questions.** The seats question asks for the price, section and row (a screenshot works), never a link. The budget question asks for the total with fees, as the watch question already does.

**Tests.** `tests/acceptance/email-layout-0102.test.ts` replays that email's shape. The header assertions in the R6, R8 and market-tracking replays are updated to the two-line form.

## 67. A listing link is looked up by its listing number in the resale feed, never fetched

**Why.** A live reply to a StubHub listing link (Rangers vs. Islanders, Oct 6) said "I can't open StubHub listings myself" and gave the venue-wide floor instead. We do hold that listing. SeatData's current-listings read for the event carries each listing's price, section and row, and research was already making that read for cheaper alternatives. It was just dropping the listing number.

**What.**
- A StubHub or Vivid Seats link with a listing id is looked up in one current-listings read. The read happens only where the licence allows tracking and customer display, and only when there's no screenshot or pasted listing.
- **A match** needs the same number, plus the same marketplace when the feed names one. When the feed names no marketplace, the number must be the only one of its kind. A near match is never used: no guess from the section, row or price.
- **On a match**, the listing becomes the subject (`source: 'link_match'`). Its listed price before fees, section and row are said as found in resale data. The catches name what the feed doesn't carry: delivery, seat numbers, and whether the seats are together. Cheaper alternatives come from the same read, so it costs one paid call, not two.
- **With no match**, the reply is the same as before.
- Each attempt is audited as `listing.link_matched` or `listing.link_unmatched`.
- The marketplace page itself is still never fetched (#47). StubHub's terms and its bot protection make a scraper both against the rules and brittle.

**Not verified.** Whether SeatData's `listing_id` is StubHub's own listing number. The item shape is undocumented, and the tests use a stand-in feed. The audit rows will show the live match rate. If it is near zero, the ids are different and this path stays silent.

## 68. Raw SQL never binds a Date; a hand-off answers follow-ups; a full Discovery page isn't a whole window

**Why.** The Final Human QA (`docs/qa/FINAL_HUMAN_QA_2026-10-02.md`) found three problems:
- A real StubHub listing link went to "manual check". The cause was a raw-SQL `Date` parameter that production's driver rejects and the embedded test database accepts, so every SeatData listings read in production was crashing.
- The follow-up to that request got no reply.
- Hamilton was "not scheduled" after a search whose page had likely run out.

**What.**
- **Raw SQL.** A value interpolated into raw SQL is an ISO string cast to its type, never a `Date`. The embedded test database rejects a raw `Date`, as production's driver does.
- **Market reads.** A failed market read costs the reply its market lines, never the reply.
- **Hand-offs.** A message on a request already with a person gets one short acknowledgment (at most one a day) and a staff alert. The holding reply says when the team checks.
- **Discovery.** A full page records only the dates it reached. Event lookup asks for 100 results. A cached miss is re-asked once. "Not found" is said as what we searched.

**Not decided here.** Whether SeatData's listing ids are StubHub's. `scripts/probe-seatdata-link.ts` answers that with one paid read. The concert items (screenshot rows, passes, standing room, buy-or-wait) are in #88.

## 69. A StubHub link is read by StubHub's own event id; an unfound listing gets a price first and one ask

**Why.** After #89, the live Rangers reply no longer crashed, but it read as three "I can't" lines: can't open the listing, can't see seats on Ticketmaster, can't see resale listings. The game wasn't matched to SeatData through its Ticketmaster id. The link already named StubHub's own event id, which SeatData reads directly (`listings/get?event_id_sh=`, SDK 1.2).

**What.**
- **Lookup.** When the event isn't tracked through Ticketmaster, a StubHub link's event id is used for the one listings read. It's the same licence gate, reservation and call cap as before.
- **Listing found by its number.** The reply answers about that listing, as before (#67).
- **Listing not found.** The reply leads with the cheapest listing for their party at that game: price before fees, the total for the party, section and row, and how many listings fit. Then it makes one ask: the price with fees, the section and the row, or a screenshot. When the market block is shown, the lead uses its floor instead, so one email never carries two "cheapest" prices.
- **Removed from that reply:** the separate "I can't open StubHub listings" question, the budget question, "I can't see live resale listings", and the model's closer.
- **Ticketmaster's open sale under a resale link** is a price to compare against ("check its total for two there against the one you found"), not "that's where I'd buy".
- **Checkout links.** A StubHub checkout link (`ID=<session>|<listingId>|<qty>|0`) gives the listing and the quantity. `scripts/probe-seatdata-link.ts` also takes an event link with no listing; it prints rows to open and compare.

## 70. Listings are read on v0.1.1; a doors-time heading is the same show; what #91 left in the jigitz and Rangers replies

**Why.** The deployed fix verification (Oct 2) found the selected StubHub listing still unread (FV-R1-01). The jigitz screenshot replies are fixed in #91; their first reply still ended with filler, and their follow-up kept a source line for a market section it no longer showed (FV-R2-03). The old Rangers thread got a requirement line about seats we were never shown (FV-R1-03). And a Ticketmaster page heads with the doors time, so once the catalog stores the show time (#88), a screenshot of the right show was ruled out.

**What.**
- **Listings path.** `listings()` now calls `/api/v0.1.1/listings/get`, the path SDK 1.2 uses, the same one the StubHub event-id read already used. The v0.1 path is the one every live read went through, and it likely explains both the unread link and group prices never appearing. That is not proven until the probe or a live reply shows rows.
- **Doors and show.** A screenshot that shows "Doors: 8PM Show: 9PM" is that performance at either time, so a catalog that holds it at 9pm (synced with doors) or at 8pm (before) both match. A typed time still rules.
- **Results page from the official seller's own page.** The open-sale line ("Ticketmaster also lists it as on general sale…") goes; its link stays as the last line. Rows from another seller keep the comparison. "I haven't found a verified alternative…" goes too: the other rows are the alternatives.
- **Buy-or-wait follow-up on rows.** The "Those figures are StubHub and Vivid Seats…" line goes with the market section it describes.
- **Listing link.** No "I haven't been able to check this against any seats yet" line under a listing link: the one ask for its price and seats covers it.
- **`scripts/probe-discovery.ts`** is read-only, for FV-R1-02 (Hamilton). For a keyword, city and day, it prints:
  - what the catalog holds;
  - the recent syncs and the windows they recorded;
  - the intake's discovery audits;
  - one live Discovery call, asked as the intake asks, with which events are and aren't in the catalog.

  It upserts nothing and records no sync.

**Not done.** Hamilton's cause stays unknown until the probe runs against production. The selected StubHub listing is still unproven until SeatData returns rows for it.

## 71. A name is looked up by how well it matches, not by the first ten in alphabetical order

**Why.** Hamilton's Sunday matinee was still "couldn't find a Hamilton performance in New York on Sun, Oct 4" after #89 and #92. The search reached the provider, but the step after it, finding the show in our own catalog by name, took the first ten entities whose names contain the word, in alphabetical order. Hamilton is a surname, so every sync adds artists like Anthony Hamilton and Bethany Hamilton, and they sort ahead of "Hamilton (NY)". Once ten of them were on file, the show was never looked at. An entity billed exactly "Hamilton" would also have hidden it, because an exact name ended the search even when it had nothing that fit.

**What.**
- **Order.** Exact names and nicknames are tried first, as before ("rangers" is the two Rangers teams, not their alumni). The rest come after, in this order:
  - a name that starts with the word ("Hamilton (NY)") before one that merely contains it;
  - then a name with something scheduled before one without;
  - up to ten.
- **Fallback.** An exact name with no event that fits no longer ends the search; the rest are tried.

**Not certain.** This is the bug that matches the live symptom, and both new tests fail without the fix. The production catalog hasn't been read to confirm it holds ten or more such names. `scripts/probe-discovery.ts` shows it.

## 72. A misread name isn't another show; a follow-up's own questions are answered; skipped reads say why

**Why.** The post-deploy QA of #92 (Oct 2, build b31b3fc) found four problems:
- **PD-R2-01.** The later jigitz screenshot was read as "jיגitz", a name mixing Latin and Hebrew letters. The reply then advised against the very show it showed: "it's for jיגitz, not jigitz".
- **PD-R1-02.** The Rangers follow-up asked for a cheaper pair and whether prices were rising or falling. It got the first reply's ask again and neither answer. The trend pattern missed "are prices generally going down", and nothing read "find a cheaper pair".
- **PD-R2-02.** The first reply to a results page still carried a 21-hour-old, venue-wide market block, plus "I couldn't read everything (Only 3 of the 7 results are visible.)".
- **PD-R1-01.** The selected listing link was never read, and nothing recorded why.

**What.**
- **Identity.** A listing's name in two alphabets at once is a misread. So is a one- or two-letter slip on the event's own date at its own venue. A different name in full still raises "make sure it's the right show".
- **Follow-up questions.**
  - "Are prices … going down", "is the price going up" now count as asking about the trend, and get the trend answer.
  - "Find a cheaper pair" is read as its own question. With no listings to look through, the reply says it can't look for one, and makes one ask: any pair they find, or the one they picked.
- **Results page.** A venue-wide market with no zone isn't shown under a screenshot's rows, first reply or follow-up; the page's own rows are the comparison. "Only N of M results are visible" is how much of the page they captured, not a misread, so it no longer prompts "check those details yourself".
- **Diagnostics.**
  - A listing link the pipeline doesn't look up is audited as `listing.link_skipped`, with the gate that stopped it: licence, service depth, or display rights.
  - A listings read the tracker skips writes a `skipped` row: no key, licence, untracked event, no StubHub id.
  - `scripts/probe-request.ts <request id>` prints one request's links, listing audits, tracking row, 48 hours of SeatData reads, and licence state. It shows no message text and makes no provider call.

**Not done.** Why the Rangers listing wasn't read is still unknown until `probe-request` runs on the production request. Hamilton is #71, which this QA didn't test.

## 73. A trend is dated by the provider, repeated reads add nothing, mixed stays mixed, and the floor answers for the floor

**Why.** The Oct 2 root-cause review (RC08) found four ways the buy-or-wait read could say more than its data:
- **Timestamps.** Group series (three or more) were dated by when we fetched SeatData's listings, not by when SeatData last refreshed them. So a cached read fetched twice became two "observations", and any read looked fresh.
- **Mixed.** A rise over three days with a fall over the last day came out "flat", and the reply said "about the same".
- **Scope.** A floor-only request was decided on the venue's cheapest seats. A venue-wide fall could argue for waiting on floor seats whose prices were rising.
- **Diagnostics.** Nothing recorded which observations, windows or scope a decision was read from.

**What.**
- **Two times per row.** `market_snapshots.observed_at` is the provider's time (the stats snapshot, or the listings' `last_refresh_timestamp`). `provider_as_of` holds that time, or null when the provider gave none. New `retrieved_at` is when we fetched. A row without a provider time is flagged `provider_time_unknown`. Migration 0021 adds the column and marks existing group rows that way, because their times were fetch times.
- **Repeated reads.** The same refresh time lands on the same row (unique index), so fetching again adds nothing and keeps the first fetch time. An unchanged price with a new provider time is a new observation. Nothing is de-duplicated by price.
- **Undated reads.** These never date a series, its freshness or its span. Alone, they give the price "when I checked", saying the data doesn't say how recent it is: never "currently", never a trend.
- **Mixed.** When the day and the three days disagree, or the last day moved and the three days didn't, the direction is `mixed`.
  - The decision never waits on it (`market_mixed_no_clear_direction`); shadow advice says buy.
  - The reply gives both windows and "no clear direction".
- **Scope.**
  - A seating preference naming an area ("floor") reads that area's zone series: stats zones for one or two tickets, listing zones for groups. Several matching zones are merged at their cheapest per provider time.
  - The venue figure follows, labelled "across every seat in the venue … includes seats away from the floor".
  - With a preference but no series for it, the venue's direction is context only: `basisMatchesGroup` is false and `market_scope_broader_than_request` is recorded. The reply labels it and says not to decide on it.
- **Buy or wait.** With no verified-total trend, a fresh, dated, sufficient series for their seats answers the question.
  - Not falling: the verdict comes first ("I'd buy rather than wait once you find seats…"), then the window, the prices and the before-fees basis.
  - Falling: the fall, then that it doesn't promise more.
  - Stale, undated or broader-scope data gets its own reason line.
- **Trace.** `market.trend_assessed` is audited per research revision. It records the basis, the zone wanted and matched, and the scope. For the context and the venue, it records the newest 12 observations (with provider and fetch times), the 24- and 72-hour windows, direction and the rule that set it, adequacy, reasons and supply. It also records the signal given to the policy, the decision and its market reason codes. It holds no customer text and no keys.

**Not done.**
- An area is matched only through `areaOf` (floor, balcony, mezzanine, orchestra, loge, lawn, terrace). "Lower level" or "100s" still read the venue, labelled.
- Listing counts stay venue-wide even when prices are the zone's, and say so.
- Listing fetches for a customer's link (`currentListings`) are unchanged.

## 74. A choice of game on price is a ranked list; a sports browse ranks by prominence; "the best tickets" is one question; a pack is recommended first

**Why.** Live emails on Oct 9 showed three failures of shape, not wording:
- **One request, one event.** "What upcoming New York Rangers game would be good to take my son to with the lowest prices. Before Christmas." The request holds one `eventId` and research only ever writes a single-game brief, so the comparison was done as an input step: `cheapestGame` picked one game, wrote the comparison into an acknowledgement line ("… Sun, Oct 11 vs. Vancouver Canucks is the only one I have current prices for …"), and research sent a buy-or-wait essay about that game. Only one of twelve games had a price: a game is priced from its stored series or a listings read, and a listings read needs the game already tracked and matched, which only happens once a customer has settled on it or the cohort names its team. The games nobody had asked about were never priced.
- **Date order as ranking.** "My family is coming to New York next week. What sports games are on?" offered "St. John's Red Storm Men's Basketball v. Drexel (Exhibition)" as pick three while Knicks and Yankees games were in the window: the picks were the first three by date.
- **Three asks for one goal.** "Find me the best Metallica tickets" got a menu of dates and three questions. The goal (view or value) and the party are what decide that answer.

**What.**
- **Ranked games (`compareGames`, pipeline).** "Which game is cheapest?" over two or more candidate games (home games when two or more are home) sends one email: the verdict ("Cheapest before Christmas: Tue, Nov 3 vs. Ottawa Senators, from $74 a ticket before fees for two."), the games ranked cheapest first (up to five, each "from $X a ticket before fees"), the unpriced ones in one line ("I don't have prices yet for one more (Sat, Dec 5 vs. Boston Bruins); I've started tracking them."), then one next action ("Reply with the date and I'll find seats for two."). New template `games_ranked`, the browse picks' list mechanics, plain text and HTML in step.
  - Every game is priced: the stored series when fresh (36 hours, the party's basis: single, or the pair series, which is SeatData's "2 or more" price; a group of three or more is compared on pairs and told so), otherwise `tracker.refreshEvent` (enrol, match, poll, monthly history backfill) and the series read again. Refreshing stops at the first `budget` answer and at twelve per request; the daily allowance is the real cap and is unchanged. No comparison listings reads.
  - Audit `request.games_compared`: quantity, basis, licence uses, refresh count, and per game the cents and the refresh reason (`refreshed`, `budget`, `unmatched`, `fresh`, `policy`, …).
  - Prices only where the licence allows display. With no right to steer advice, or nothing priced, the games are listed in date order without prices and the customer is asked which.
  - The request is left as a browse leaves it: `browseShown` holds the listed games, `eventId` is null, state `needs_clarification` (`games_ranked`), no acknowledgement, no `research.requested`. The reply ("Nov 3, 2 tickets") resolves to that game through the ordinary path and goes to research.
  - The refreshed games stay tracked: `validReasons` now counts an open request whose `browseShown` lists the game, so the enforce-mode pass doesn't pause them before the customer picks.
- **Prominence (`prominenceTier`, browse.ts).** A sports browse sorts its candidates by tier before date, the "more" continuation included: 0 the major leagues (nhl, nba, mlb, nfl, soccer, wnba); 1 other pro and college seasons; 2 exhibitions, preseason, friendlies and anything `isNonGameName`. Stable, so each tier keeps its date order; nothing is dropped.
- **A held price on a pick.** A sports pick whose pair (or single) series is fresh carries "from $X a ticket before fees" when the licence allows display. Stored data only; a browse never pays for a read.
- **One question (`BEST_OPEN_ASK`).** An act on file, no count, no date, and "best tickets/seats" with no goal word: the reply asks "Are you after the best view or the best value, and how many tickets?" and nothing else; the answer goes on as an ordinary request. A team still takes its next home game; an act with nothing scheduled still hears that first, with the old asks.
- **A pack for the group (`productChoiceAnswer`).** "Which MRAK ticket should four of us buy?" with a four-pack named: the pack recommended first "provided its entry conditions suit you"; cheaper per person said only on the customer's own figures (and the other way round when their figures say so); the pack's admission terms and the checkout fees to confirm. The route is the product-choice acknowledgement, which carries no resale trend. Under enforce, a Guide-depth event (a club night) no longer answers a product question with the official seller alone: the product answer reads nothing and runs no research, so it comes first.

**Not verified.**
- Live SeatData: how many of twelve Rangers games match by Ticketmaster id, and what twelve refreshes cost against the 50-a-day allowance alongside the hourly pass (match 1, poll 1 to 2, history up to 9 once a month per team and venue). The reply degrades to "I don't have prices yet for N more" either way.
- The production catalog's exhibition naming: `(Exhibition)`, `Preseason`, `Friendly` and the non-game words are matched; a differently worded exhibition ranks as tier 1.
- A pack is recognised from its words ("four-pack", "4-pack", "pack of four", "group tickets"); a page the customer doesn't describe isn't read.

## 75. One thread keeps its facts, a clarification is one question, every link and screenshot sent is judged, and a reply says what was actually done (Oct 10 audit)

**Why.** The production audit of Oct 10 (docs/AUDIT_2026-10-10.md) walked the brief's seven requests and six follow-ups through the code at fecbc59. It found 45 gaps. These are the ones a customer meets first:
- **Repeating.** After a side question, a capability question or "thanks, bought them", the request closed and the next reply started from nothing.
  - A follow-up that resolved on its own lost the game the customer had chosen.
  - "Actually make it Dua Lipa" kept the hockey game's name and date.
  - "$220 for both", answering our own question, became a budget.
- **Questions.** A clarification could ask three questions. The counter never reset, so a fourth question in a request's life parked it with a person.
- **Evidence.** Only the first link ever sent was judged. Two links or two screenshots were never compared. "I couldn't match the listing" was said when no lookup had run. Hrefs in HTML-only mail were lost, wrapper and short links said nothing, and skipped images went unmentioned.
- **The brief.** A budget's fee basis, a decision deadline and a ranking goal ("best view", "cheapest is fine") had no field, and the model was never told about seven preference fields.
- **Timing.**
  - An over-budget party on a falling market could never be told to hold off without a watch.
  - The recheck time was an ISO timestamp.
  - A customer who wrote while a draft waited heard nothing, and an expired draft could still be approved and sent.
- **Scope.** Auto-approved replies never said we don't buy, hold or resell tickets.
- **Operations.** /api/health could not see the scheduler. Failed SeatData reads under-counted the daily allowance. A dead-lettered inbound email reached no one.

**What.** Six branches merged into integ-r2, followed by an end-to-end journey test and a review pass. Gap numbers are the audit's.
- **One thread, one memory** (gaps 4, 9, 11, 15; tests/acceptance/conversation-state-1010.test.ts).
  - A capability or outside-tickets question inside an open request is answered with "Nothing about your ticket request has changed". There is no new version, no revision bump and no state change, and the audit records request.side_question_answered.
  - A new request in a thread merges onto the last closed request's brief and settled event (carriedFromThread). It carries the event, party, budget, seating, access, deadline and preferences. Links, evidence, quoted prices and flags are not carried. Nothing is carried after a stop, opt-out, off-topic message or staff removal, and a decision deadline that has passed is not carried.
  - keepSettledEvent keeps the chosen game when the message names no act, event or date and the resolver found the next game itself.
  - A different act clears eventName, dateExpression, resolvedLocalDate, categoryHint, genreHint, submittedUrls and the quoted price, and the settled event cannot hold it.
  - "$220 for both" after a quote or an unknown-basis screenshot is the quote's basis. "We can spend $220 for both" stays a budget.
  - "This weekend" is Friday to Sunday except for sports, where it stays Saturday and Sunday (the weekend line under #60 now says so).
  - "Did you check Saturday too?" is answered on the research route.
- **One question** (gaps 14, 16; tests/acceptance/one-question-1010.test.ts, tests/acceptance/guide-null-quantity.test.ts).
  - Exactly one question, in a fixed priority order, with the count folded into it. The subject is "One quick question".
  - questionRound restarts the count when a round settled what it asked. The "asked twice, assume two" default counts only rounds that asked for the count.
  - "Best tickets" with no goal asks the goal once. If unanswered, it says it will go by the lowest price, which is how picks rank.
  - A Guide-depth event with an open official sale gets the official-sale reply regardless of the resale key. Research without a party size is skipped and audited, and the admin research route answers 422 party_size_unknown.
- **Evidence** (gaps 5, 6, 8, 17, 19, 20, 30, 39, 41; tests/acceptance/links-evidence-1010.test.ts, tests/unit/links-evidence-1010.test.ts).
  - The newest link is the subject, and each link keeps its own facts. A typed party size survives a later link's count.
  - Two to five links in one message are each priced and compared as offers.
  - Two or more priced screenshots of one game in one message are compared. A follow-up compares the pair from the newest message that sent listings.
  - The link claim records evidence 'url_text' or 'api_lookup' and the lookup status. The customer reads "I can't check individual listings for this game right now", "I can only look listings up by number on StubHub and Vivid Seats", "the listing data wasn't available when I tried", "looks gone", or, only after a lookup missed, "couldn't match".
  - stripHtml keeps hrefs. Google, Outlook and Facebook wrappers are unwrapped from the URL alone, and short or app links are named with one ask.
  - Skipped, HEIC and PDF images are named, with why.
  - A subject alone no longer suppresses mail as an auto-reply.
  - beat_offer mode and the official-sale bypass key on a parsed marketplace link.
  - Text inside a screenshot is data. packet.ts drops restriction notes addressed to the reader, after a test showed an injected line reaching the customer.
- **The brief** (gaps 10, 12, 13, 28, 43; tests/unit/brief-fields-1010.test.ts, tests/acceptance/brief-goal-fees-1010.test.ts).
  - New fields budgetFeeBasis ('all_in' | 'before_fees' | null) and rankingGoal ('view' | 'value' | 'price' | null), learned by the model and the rules.
  - pickListings ranks by the goal. 'view' ranks by zone or section tier and says when the data can't support it.
  - decisionDeadline is described to the model, read by rules ("decide by Friday", "before the 20th"), and kept out of the event date. A date-only answer becomes an instant, and a malformed model output goes to staff instead of retrying.
  - Every preference field has one prompt line.
- **Deviation.** The audit's fix shape said to skip the fee allowance when the customer says all-in. That would compare a checkout-total budget with prices before fees and call seats "within budget" that are over it at checkout. So the allowance is skipped when the budget is **before** fees, and all-in or unstated budgets keep the fee estimate. No hold-and-watch is offered against a before-fees budget. Owner question 13 in the audit asks for confirmation.
- **Answer timing** (gaps 3, 21, 22, 36, 37; tests/unit/brief-verdict-1009.test.ts, tests/unit/reply-voice-1010.test.ts, tests/acceptance/review-path-1010.test.ts, tests/acceptance/pilot-outcomes.test.ts).
  - A new 'hold' outcome needs all of: over budget, the party's own series falling, 3 or more days to go, the deadline 2 or more days out, and no watch offer. It reads "I'd hold off for now" and names a check-back day in the venue's time.
  - C_CHECKPOINT reads "Look again on Thursday, Oct 15, around 6pm".
  - A message that arrives while research or review is pending gets one note ("Got your update: 4 tickets. I'm rechecking with that...").
  - An expired recommendation is refused at approval (409) and at dispatch, invalidated and researched again. After three expiries on one revision it goes to manual_attention. Nothing is researched again for a closed, referred, unsupported or suppressed request, or when a kill switch, a stale revision or a policy change also blocked the send.
  - The follow-up cron runs the send gate before it records anything.
  - watch_alert and unsupported are rewritten in the house voice.
  - AUTOMATED_FOOTER is "AI-assisted ticket advice. We never buy, hold or resell tickets."
- **Market and operations** (gaps 18 part, 26, 34, 42; tests/acceptance/market-budget-1010.test.ts, tests/acceptance/operations-signals-1010.test.ts).
  - The history backfill is bounded by the calls left, game by game, and resumes on a later refresh.
  - Error rows log the calls actually made.
  - A comparison reuses any tracker's read of the event from the last 10 minutes; watch reads stay fresh.
  - /api/health adds outboxLagSeconds and lastDispatchAt and never 503s on them. /admin/operations shows the deployed commit and a lag badge.
  - A dead-lettered email.received raises one staff alert with no customer words.
  - Gap 35 was not reproduced: the depth gate makes historyOk equal trackingOk at every depth. A pinning test records why.
- **Brief journeys** (tests/acceptance/brief-journeys-1010.test.ts, 20 cases, both policy modes). These are the seven requests and six follow-ups plus J8, J9 and J3c, through dispatch. They found and fixed:
  - a typed quote with no resale comparison;
  - a one-ask Dua Lipa case that named picks;
  - "admission tier" not routed to product choice;
  - a false "I can't see live resale listings" line;
  - "St. John'S";
  - "Do you charge for this?" resending the brief.
  
  The review pass (tests/acceptance/review-fixes-1010b.test.ts):
  - "Are the seats together?" is answered from the listing data (C_TOGETHER).
  - "Buy now or wait?" after picks names the seats.
  - A reply to a watch request that asks to buy now becomes a search.
- **Expectations changed, none weakened:**
  - launch-evidence-1002 Q01, live-final-qa LIVE-07, metallica-thread-1004, team-month-1004 and unit elsewhere-note: one question;
  - clarification-email: the footer;
  - pilot-outcomes: no record in fixture mode;
  - guide-null-quantity: research without a party size resolves and audits instead of throwing;
  - unit audit-0929: questionsAsked has a together field.
  
  Plain mode passes 1882 tests. Enforce mode has one failure, the known concert-noun-1005 Mind Enterprises case.

**Not verified live.** Nothing here has run on real mail or against the real model or SeatData. The branch is not merged or deployed, and the deployed commit is unknown.
- The model's reading of the new fields and prompt lines has no real-model eval, and the journeys use recorded model fields.
- The 'view' ranking depends on the feed's zone and section words.
- A shared 10-minute read assumes one process; several Render instances would each keep their own.
- The holding note, the expiry re-research and the hold outcome are fixture-tested only.
- Still open from the audit: the launch cliff, test-mode capture, the listing-id equivalence, model pricing, the open-web finder, enforce mode, the 256 KB webhook cap, the screenshot-reader eval, and journey residues 48 to 56 in the audit's gap list.
