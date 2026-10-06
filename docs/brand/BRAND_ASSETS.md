# Brand assets in the ticket brief

The recommendation email ("I'd buy Section 217, Row 6…") is a ticket brief: the event's artwork on top, the event as a ticket, then the pick. The artwork comes from the `brand_assets` table (`src/lib/brand/assets.ts`).

## What shows

| Event | Artwork |
| --- | --- |
| A game | Both teams side by side in their colours, with short names ("NYR vs NJD") and logos when approved |
| A show | The performer's or production's image, else the venue's, else a band in the show's colours, else our concert artwork (`public/email/concert-artwork.jpg`) |
| Nothing known | No artwork. Never a stand-in |

The artwork is decoration. It never stands for the seats' location.

## Rows

One row per `(kind, key)`:

- `team`, `performer`, `production`: `key` is the entity's slug (`new-york-rangers`). A row can exist before the entity does.
- `venue`: `key` is the provider id, `ticketmaster:KovZpZA7AAEA`.
- `category`: `concert`, `sports`, `theater`, `comedy`.

Seeded in migration `0022`: 28 teams (NHL, NBA, WNBA, MLB, NFL), 10 Broadway shows, and the category defaults. Catalog sync adds each Ticketmaster attraction's and venue's image as it meets them (`source = 'ticketmaster'`). It refreshes only its own rows and never overwrites a seeded or staff row.

## Rights: what may go into a sent email

`rights` decides whether an image goes into a sent email. Colours and names are always used.

- `unreviewed`: preview only. Seeded logos and Ticketmaster images start here.
- `licensed`: staff confirmed we may use this image.
- `provider_terms`: staff confirmed the provider's terms cover showing it in our email.

See both views at `/preview/ticket-brief` (as sent) and `/preview/ticket-brief?images=all` (with unreviewed images).

Approve one logo once its use is cleared:

```sql
UPDATE brand_assets SET rights = 'licensed', updated_at = now() WHERE kind = 'team' AND key = 'new-york-rangers';
```

Approve every Ticketmaster image once their terms are confirmed for email:

```sql
UPDATE brand_assets SET rights = 'provider_terms', updated_at = now() WHERE source = 'ticketmaster';
```

The seeded logo URLs point at ESPN's image CDN. They are placeholders to see the design with, not a licence. Before approving a logo, replace `image_url` with an image we host or are permitted to link to.
