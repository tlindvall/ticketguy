# Link and evidence interfaces between the two launch workstreams

Final launch spec, Oct 2 2026. Ownership was split so the two agents don't edit the same code at once:

| Workstream | Owner | Modules |
|---|---|---|
| B links, D provider clocks, G diagnostics | trend/links agent (branch `claude/relaxed-faraday-x955vr`) | `src/lib/domain/ticket-links.ts`, `src/lib/market/*`, watch evaluation, `src/lib/admin/test-inbox.ts`, `src/inngest/functions.ts` retry rules |
| A evidence, C questions, E reply quality | intake agent | `src/lib/ai/listing-evidence.ts`, `src/lib/ai/extraction.ts`, `src/lib/advice/packet.ts`, `src/lib/advice/product-choice.ts`, `src/lib/email/templates.ts` copy |

`src/lib/intake/pipeline.ts` is shared. Changes there land one PR at a time, each rebased on the last merge.

## What the links side provides

### `TicketLink` (`parseTicketLink`, `ticketLinksIn`): available now

```ts
type TicketLink = {
  url: string;
  marketplace: 'stubhub' | 'ticketmaster' | 'seatgeek' | 'vividseats' | 'gametime' | 'tickpick' | 'axs';
  localDate: string | null;   // from the path, YYYY-MM-DD
  quantity: number | null;
  listingId: string | null;
  eventId: string | null;     // the marketplace's own event id
  slugText: string | null;
  malformed: boolean;         // broken percent-encoding; the decodable parts are still read
};
```

The parser never throws. A broken escape is kept as typed and sets `malformed`. `garbledLinkNote(urls)` returns the one line the reply uses. `URIError` and `InvalidInputError` (in `src/lib/intake/outbox.ts`) are dead-lettered on the first failure, not retried.

### `LinkResolution`: planned, one per submitted URL (PR 3)

```ts
type LinkResolution = {
  url: string;                       // as sent, never logged with tokens or signed parts
  host: string | null;
  parse: 'ok' | 'malformed' | 'unsupported_host' | 'not_a_url';
  link: TicketLink | null;
  event: { status: 'resolved' | 'ambiguous' | 'not_found' | 'not_attempted'; eventId: string | null; via: 'marketplace_event_id' | 'slug_date' | 'listing_sighting' | 'typed' | null };
  listing: { status: 'matched' | 'unmatched' | 'skipped' | 'unavailable' | 'not_requested'; reason: string | null; providerAsOf: string | null; retrievedAt: string | null };
  destination: { url: string; kind: 'event_page' | 'verified_offer' | 'official_reference' } | null;
};
```

The intake side reads `event` and `listing.status` to word replies. For example, an unmatched listing is "I couldn't match that listing in the resale feed", not "StubHub doesn't pass me the price" (LAUNCH-08). The intake side doesn't re-parse URLs.

### Provider clocks (PR 2)

Every listing price handed to a reply or a watch carries `providerAsOf: Date | null` and `retrievedAt: Date`. `null` means undated:
- usable as "when I checked"
- never "currently"
- never a fresh alert

## What the links side needs from intake

- Screenshot evidence that keeps unpriced rows, with an `evidenceId` per fact. Diagnostics (PR 3) show whatever `listing_evidence.fields` holds. New fields should go into that JSON so they appear without a schema change.
- The question plan (`AnswerPlan`), if it is stored. Diagnostics then show coverage per question.

## LAUNCH-07, split between the two sides

- **Intake (E):** the "Buy tickets" label becomes "Event page" in `templates.ts`.
- **Links (B):** a supplied official reference, such as BroadwayDirect, is kept as a validated link and not replaced by the Ticketmaster mapping.
