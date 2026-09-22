# Demo script (fixture mode, ~10 minutes)

Everything below runs locally with no credentials. Synthetic data only; every outbound email is created and then **blocked** by the send gate — the point of the demo is to show the gate, not to send.

```bash
pnpm install && pnpm db:reset-local
STAFF_INITIAL_PASSWORD='correct-horse-battery-staple-2026' pnpm tsx scripts/create-staff.ts demo@ticketguy.now admin
DEV_ALLOW_STAFF_WITHOUT_MFA=true pnpm dev
```
Sign in at http://localhost:3000/admin/login. In production every staff route also requires TOTP (`/admin/setup-mfa`).

## 1. Request → clarification
`/admin/operations` → Inbound simulator: from `carol@customer.example`, body `Two tickets for the New York Rangers on Oct 3, budget $300.`
Open the request from `/admin/inbox`: state `needs_clarification`; the queued clarification asks whether $300 is per ticket or combined **and** confirms the customer is US-based. No prices were looked up (event resolved, but the brief is incomplete). Note the send intent is `blocked (app_mode_fixture, email_send_disabled)`.

Show A02 too: body `2 tickets to Dua Lipa tomorrow in New York, $300 total` → "We couldn't find a verified Dua Lipa event…" — no show is invented.

## 2. Reply → verified comparison → advice
Simulator again, same `from`, **In-Reply-To** = the `rfcMessageId` returned by the first call, body `$300 total for both of us, together please.`
The request is now revision 2, `awaiting_review`. On the request page walk through:
- **Buying brief**: quantity 2, budget 30000 cents whole-party (A01).
- **Source coverage**: fixture sources `success`; all real sources `not_integrated` — recorded, not hidden (A11/A13).
- **Offer observations**: the cheaper obstructed-view listing is present but excluded; the estimated-fee listing is `incomplete` (A07/A08); two sources show section 208/D → possible duplicate, so no "N options" claim (A10).
- **Advice run**: decision, reasons, benchmark adequacy (history unavailable for this basket), trend, and the **claim packet**.
- **Draft**: "$240 total ($120 each)", coverage footer, no invented numbers.

## 3. Five together — history and trend
Simulator: from `alice@customer.example`, body from `tests/fixtures/emails/rangers-five.txt`.
Draft shows: $425 total ($85 each); "Across 12 comparable past events … typically $80–$90 per person (median $85)"; "fallen from $475 to $425 over the last 24 hours"; single-seat $35 labeled as an entry-price reference; decision `buy_now` with reason `trend_down_but_certainty_prioritized` because the customer said they must attend (A56).

## 4. Approval → gated send
Click **Revalidate offers**, then **Approve and queue send**. The approval binds revision + draft hash (try a stale tab later: 409). The send intent appears as `blocked` with `content_contains_fixture_data` — fixture data cannot be emailed even if sends were enabled (A13/A65). In live mode with fresh verified evidence, the same click would send once via Resend with an idempotency key.

## 5. Correction invalidates prior work
Reply in Alice's thread: `Actually make that four tickets, still $450 total.` Revision 3; the previous draft is `invalidated`; no 4-seat inventory → an honest "could not verify a suitable option" draft (A05).

## 6. Watch → alert → cancel
Simulator: from `bob@customer.example`, body `Keep looking for 2 New York Rangers tickets on Oct 3 under $250 total, let me know if something comes up.` Intent `watch_request` with a stated budget → a watch is created (consent message recorded). `/admin/watches` shows cadence/expiry. Run `pnpm watches:evaluate` (stop the dev server first — PGlite is single-process; under Inngest the 5-minute cron does this); a qualifying fixture offer ($240 < $250) creates an alert **pending approval**. Approve it → send intent → blocked in fixture mode. Cancel the watch → queued alert sends become `blocked (watch_cancelled)`; already-accepted sends would be recorded, not recalled (A26).

## 7. Unsubscribe and deletion
Simulator from Alice: `Please unsubscribe me from promotions.` → `/admin/contacts/:id` shows a `marketing` suppression and **no** marketing permission ever existed (A28/A31). `stop all emails` also cancels watches. Then `delete all my data please` → verification email queued, request `manual_attention`; admin **Delete** on the contact page redacts content, cancels watches, blocks queued sends, adds a `global` suppression and writes the deletion ledger (A36).

## 8. Operations
`/admin/operations`: outbox lag, dead letters with replay, AI spend vs cap, media budget, sends by state, kill switches. Flip `all_outbound` → Stop and dispatch anything: `blocked (kill_switch_all_outbound)` (A38).
