import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { ActionButton } from '@/components/ActionButton';
import { TestMessageForm } from '@/components/TestMessageForm';
import { recentTestRequests, TEST_MODE_KEY } from '@/lib/email/test-mode';
import { ago, stateInfo, toneClass } from '@/lib/admin/labels';
import { nowMs } from '@/lib/util/clock';

export const dynamic = 'force-dynamic';

/**
 * Test mode: the whole service runs as live, and emails are recorded here instead of being sent. Test
 * customers write in from this page or through the agent API, since receiving mail costs Resend quota too.
 */
export default async function TestMode() {
  const staff = await guardPage();
  const e = env();
  const { db } = await getDb();
  const [row] = await db.select().from(t.killSwitches).where(eq(t.killSwitches.key, TEST_MODE_KEY));
  const on = row?.enabled === true;
  const recent = await recentTestRequests(db, 30);
  const now = nowMs();
  const base = e.APP_URL.replace(/\/$/, '');

  return (
    <main className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-xl font-bold">Test mode</h1>
        <p className="max-w-3xl text-sm text-gray-700">
          Everything runs as it does live: the model reads each email, research runs, replies are written and approved, and the send checks are applied. The one difference is the last step: each email is <strong>recorded on the request page instead of being sent</strong>. Staff alert emails are skipped too. Nothing reaches Resend, so nothing uses the daily quota.
        </p>
      </header>

      <section className={`rounded-lg border-2 p-4 ${on ? 'border-amber-400 bg-amber-50' : 'border-gray-200'}`}>
        <p className="text-sm">
          <span className={`tg-badge ${on ? 'tg-badge-warn' : 'tg-badge-muted'}`}>{on ? 'TEST MODE ON — no emails are sent' : 'Off — emails are sent for real'}</span>
          {row ? <span className="ml-2 text-xs text-gray-600">last changed {ago(row.changedAt.getTime(), now)}{row.reason ? ` · ${row.reason}` : ''}</span> : null}
        </p>
        <p className="mt-2 text-sm text-gray-700">
          {on
            ? 'Real customers who email in are still answered by the system, but their replies are recorded here, not sent. Turn this off before anyone real writes in.'
            : 'Turning it on stops every email at the last step, for every conversation, until it is turned off.'}
        </p>
        <div className="mt-3">
          {staff.role === 'admin' ? (
            <ActionButton url="/api/admin/switches" body={{ key: TEST_MODE_KEY, enabled: !on, reason: on ? 'test mode off' : 'test mode on' }} label={on ? 'Turn test mode off' : 'Turn test mode on'} variant={on ? 'secondary' : 'primary'} confirm={on ? 'Turn test mode off? Emails will be sent for real again.' : undefined} />
          ) : (
            <p className="text-xs text-gray-500">Only an admin can change this.</p>
          )}
        </div>
        <p className="mt-3 text-xs text-gray-600">A thread a test customer wrote in stays test-only after test mode is turned off: nothing in it is ever emailed.</p>
      </section>

      <section>
        <h2 className="font-semibold">Write in as a customer</h2>
        {on ? (
          <>
            <p className="mt-1 text-sm text-gray-600">Arrives exactly as an email to {e.CONCIERGE_INBOUND_ADDRESS} would. Use a different address per scenario so each starts as a new customer. To reply, open the request and use “Reply as the customer”.</p>
            <div className="mt-3"><TestMessageForm /></div>
          </>
        ) : (
          <p className="mt-1 text-sm text-gray-600">Turn test mode on to write in as a test customer.</p>
        )}
      </section>

      <section>
        <h2 className="font-semibold">Test requests</h2>
        {recent.length ? (
          <table className="tg-table mt-2">
            <thead><tr><th>Customer</th><th>Subject</th><th>Where it is</th><th>Last message</th></tr></thead>
            <tbody>
              {recent.map((r) => {
                const s = stateInfo(r.state);
                return (
                  <tr key={r.requestId}>
                    <td><Link className="underline" href={`/admin/requests/${r.requestId}`}>{r.from}</Link></td>
                    <td>{r.subject ?? '—'}</td>
                    <td><span className={`tg-badge ${toneClass[s.tone]}`}>{s.label}</span></td>
                    <td>{ago(r.at.getTime(), now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="mt-1 text-sm text-gray-600">None yet.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">For a testing agent</h2>
        <p className="text-sm text-gray-700">
          An agent can write in and read the replies without a browser or a staff login. It is on when <code>TEST_AGENT_TOKEN</code> is set (32+ characters) and only works while test mode is on. It can only read test conversations.
          {e.TEST_AGENT_TOKEN ? <span className="ml-1 tg-badge tg-badge-ok">token set</span> : <span className="ml-1 tg-badge tg-badge-muted">no token: the API is off</span>}
        </p>
        <pre className="overflow-x-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs">{`# New request (use a fresh address per scenario)
curl -sX POST ${base}/api/test/inbound \\
  -H "Authorization: Bearer $TEST_AGENT_TOKEN" -H 'content-type: application/json' \\
  -d '{"from":"alex+s1@example.com","name":"Alex Rivera","subject":"Knicks tickets","text":"Two Knicks tickets next Friday, under $300 total"}'
# → {"requestId":"…","statusUrl":"…"}

# Read the thread; poll until "settled": true
curl -s ${base}/api/test/requests/REQUEST_ID -H "Authorization: Bearer $TEST_AGENT_TOKEN"

# Reply in the thread (threads on our last email and quotes it, as Gmail does)
curl -sX POST ${base}/api/test/inbound \\
  -H "Authorization: Bearer $TEST_AGENT_TOKEN" -H 'content-type: application/json' \\
  -d '{"replyToRequestId":"REQUEST_ID","text":"Section 200s, and we need to sit together"}'

# Screenshots: "attachments":[{"filename":"listing.png","contentType":"image/png","base64":"…"}] (up to 3)
# List recent test requests and whether test mode is on
curl -s ${base}/api/test/requests -H "Authorization: Bearer $TEST_AGENT_TOKEN"`}</pre>
        <p className="text-xs text-gray-600">Full instructions for the agent: docs/TEST_MODE.md.</p>
      </section>
    </main>
  );
}
