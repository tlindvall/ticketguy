# Brand assets in the ticket brief

The first recommendation in a conversation is a ticket brief (`src/lib/email/ticket-brief.ts`) with one 3:1 image on top. That image comes from `brand_assets` (`src/lib/brand/assets.ts`):

| Event | Artwork |
| --- | --- |
| A game | A banner we draw for the sport with both teams' colours and logos (`src/lib/brand/banner.ts`) |
| A show | The performer's or production's approved image, else the venue's, else a stage in a show's colours, else our concert artwork |
| Nothing known | No artwork. Never a stand-in |

The artwork is decoration, never the seats' location. Every fact stays as text under it, so the email reads the same with images off.

Previews (staff only outside development):
- `/preview/ticket-brief`: one sample per template.
- `/preview/teams`: every team in the database.

## Teams

Teams live in `src/lib/brand/teams/<league>.json`, with logos in `public/brand/logos/<league>/`:

- NFL, NBA, WNBA, NHL, MLB, MLS and NWSL: 185 teams.
- NCAA: 79 schools. That's ACC, Big 12, Big Ten and SEC football, Notre Dame, and Big East basketball.

Each team has:
- colours
- a short name ("NYR")
- other names a provider may use (`aliases`, as slugs)
- a 256px logo that we host

`pnpm brand:build` (`scripts/build-team-brands.ts`) rebuilds the files from ESPN's public team lists. Review the diff before committing. Nothing reads ESPN at run time.

`pnpm db:migrate`, which runs on every deploy, copies the files into `brand_assets` (`syncTeamBrands`). A row with `source = 'staff'` is never overwritten.

Logos are self-hosted and used to name the teams in a game: the owner's decision of 2026-10-06, `rights = 'approved'`.

**A team isn't matched.** Find the name the provider uses (it's the entity's name in the catalog). Add it under `KNOWN_AS` in the build script, or to that team's `aliases` in the JSON. A school's sport suffix ("Michigan Wolverines Football") is stripped automatically.

**A colour is wrong.** Edit the JSON and deploy. When two teams' first colours would read as one (Rangers and Islanders blue), the banner draws the opponent in its second colour.

## Banner templates

Each banner is 1200×400 JPEG, served at `/brief-art/v1/<template>/<team>/<opponent or _>.jpg` and cached for a week:

- `hockey`
- `basketball`
- `baseball`
- `football`
- `soccer`
- `theater` (a stage in a show's colours)

The sport comes from the league, or from the provider's genre for a college game. With no known sport there is no banner.

**After changing a design**, bump `BANNER_VERSION` in `assets.ts`. Mail clients cache the image by its URL.

On the card, a game's start is said the sport's way: "Tonight · puck drop 7:30 p.m.", "tip-off", "first pitch", "kickoff".

## Rights: what may go into a sent email

`rights` decides whether an image goes into a sent email. Colours and names are always used.

- `approved`: owner's decision (the team logos).
- `licensed`: staff confirmed we may use this image.
- `provider_terms`: staff confirmed the provider's terms cover showing it in email.
- `unreviewed`: never in a sent email. Ticketmaster images start here; catalog sync stores them as it meets them.

Approve every Ticketmaster image once their terms are confirmed for email:

```sql
UPDATE brand_assets SET rights = 'provider_terms', updated_at = now() WHERE source = 'ticketmaster';
```
