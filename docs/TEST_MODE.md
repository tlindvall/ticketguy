# Test mode

Test mode runs the whole service as it runs live: the model reads each email, research runs, replies are written and approved, and the send gate is checked. The only difference is the last step. Each email is **recorded on the request page instead of being sent**, and staff alert emails are skipped. Nothing reaches Resend, so no email counts against the daily quota. DECISION_LOG #57 has the reasoning.

Resend counts **received** mail against the same quota as sent mail. That is why test customers don't email my@ticketguy.now. They write in through the admin board or through the agent API below. Their messages go through the same intake as real email (same threading and participant checks, and the quoted reply is stripped the same way).

## Turning it on

An admin opens **/admin/test** and clicks **Turn test mode on**. While it is on, every admin page shows a yellow banner.

- It stops sending for **every** conversation, including real customers who email in. Their replies are recorded, not sent. Turn it off before anyone real writes in.
- A conversation that a test customer wrote in stays test-only after test mode is turned off. Nothing in it is ever emailed, so an invented address never gets real mail.
- The tester allowlist (`EMAIL_TEST_RECIPIENT_ALLOWLIST`) does not apply to recorded sends, because a recorded send reaches nobody. Test customers can use any address.
- Every other check still applies: approval, revision, freshness, fixture content, kill switches and suppressions.

## Writing in from the admin board

- **New request:** /admin/test → *Write in as a customer*. Use a new address for each scenario, for example `alex+s1@example.com`. Screenshots can be attached (up to 3 images).
- **Reply:** open the request → *Reply as the customer*, under the conversation. The reply threads on our latest email and, by default, quotes it the way Gmail does.
- Recorded emails show a **Test mode: recorded, not sent** badge. The test customer's messages show **Test customer**.

## Agent API

This is for a testing agent that should not need a browser or a staff login.

**Setup:** set `TEST_AGENT_TOKEN` (32+ random characters, e.g. `openssl rand -hex 32`) in the Render dashboard and give the same value to the agent. The API behaves as follows:

- returns 404 while no token is set;
- returns 401 for a wrong token;
- returns 409 `test_mode_off` for writes while test mode is off;
- only ever reads test conversations.

The base URL is the app's public URL (`https://ticketguy.now` or the Render URL). Every call sends `Authorization: Bearer $TEST_AGENT_TOKEN`.

| Call | What it does |
|---|---|
| `POST /api/test/inbound` | Write in as a customer. Body: `from`, `name` (optional), `subject` (optional), `text`, `replyToRequestId` (to reply in a thread), `quote` (default `true`), `attachments: [{filename, contentType, base64}]` (up to 3 images). Returns `requestId`, `newThread`, `statusUrl` and `adminUrl`. |
| `GET /api/test/requests/{requestId}` | The thread as the customer would have seen it (details below). |
| `GET /api/test/requests` | Whether test mode is on, and the 50 latest test requests. |

**What the thread read returns:**

- `messages`: every email, in order, quotes stripped.
- `notSent`: emails that were not sent, with the gate's reasons.
- `draftAwaitingApproval`: a draft still waiting for approval, when auto-approval is off.
- `state`, `stateLabel`, `why`.
- `settled`: `true` once the system has finished with the latest message.

```bash
BASE=https://ticketguy.now
AUTH="Authorization: Bearer $TEST_AGENT_TOKEN"

# 1. New request
curl -sX POST $BASE/api/test/inbound -H "$AUTH" -H 'content-type: application/json' \
  -d '{"from":"alex+s1@example.com","name":"Alex Rivera","subject":"Knicks tickets","text":"Two Knicks tickets next Friday, under $300 total"}'

# 2. Poll until "settled": true (the model and research take from a few seconds to a minute)
curl -s $BASE/api/test/requests/REQUEST_ID -H "$AUTH"

# 3. Reply in the thread
curl -sX POST $BASE/api/test/inbound -H "$AUTH" -H 'content-type: application/json' \
  -d '{"replyToRequestId":"REQUEST_ID","text":"Section 200s, and we need to sit together"}'

# Screenshot: base64 of the image file
IMG=$(base64 -w0 listing.png)
curl -sX POST $BASE/api/test/inbound -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"from\":\"alex+s2@example.com\",\"text\":\"Is this a good deal?\",\"attachments\":[{\"filename\":\"listing.png\",\"contentType\":\"image/png\",\"base64\":\"$IMG\"}]}"
```

## Instructions to give a testing agent

> You are testing Ticket Guy, an email ticket concierge, as its customers. Test mode is on, so nothing you trigger emails anyone.
>
> **How to work:**
> - Write in with `POST /api/test/inbound`, then poll `GET /api/test/requests/{id}` every 10 seconds until `settled` is true.
> - Read every message in `messages`, and anything in `notSent`.
> - Reply with `replyToRequestId` the way a real customer would, for example answering a question it asked or changing a requirement.
> - Use a new `from` address for each scenario (`yourname+s1@example.com`, `+s2`, …). Reuse an address only when the scenario is about a returning customer.
> - Never turn test mode off, and never email my@ticketguy.now.
>
> **For each reply, report:**
> - Did it answer what the customer asked?
> - Did it keep every requirement they gave (quantity, together, budget and whether it is per ticket or in total, date, section, delivery time)?
> - Is every price and claim supported, with nothing invented?
> - Is it clear what to do next?
> - Quote the exact sentence that is wrong, and include the request's `adminUrl`.

## Limits

- The AI daily budget (`AI_GLOBAL_DAILY_BUDGET_USD`, $10 by default) still applies, and heavy testing is what will hit it next. The spend so far today is shown on /admin/operations. Raise the budget for the testing period if needed.
- Drafts are approved automatically while `AUTO_APPROVE_WHILE_TESTING` is on and the tester allowlist is non-empty, or for everyone when `AUTO_SEND_RECOMMENDATIONS=true`. Otherwise they wait on the request page, and the API reports them as `draftAwaitingApproval`.
- Delivery events (delivered, bounced) never arrive for recorded sends. Their send state stays `provider_accepted`, with a provider id starting `test_`.
