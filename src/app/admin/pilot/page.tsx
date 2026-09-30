import { desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { env } from '@/lib/config/env';
import { PROBLEM_TYPES } from '@/lib/domain/problem-types';
import { whenStaff } from '@/lib/admin/labels';
import { isCapturedSendId, testConversationIds } from '@/lib/email/test-mode';

export const dynamic = 'force-dynamic';

/** The pilot is ten real requests: from customers, not staff, on real events, that we answered. */
const PILOT_TARGET = 10;

/**
 * Whether Ticket Guy helped, request by request: what each buyer needed, whether we answered, and what
 * happened after, each kept as the evidence it is (their word, an affiliate confirmation, a click). Staff
 * addresses, fixture data and test-mode customers never count; tests are not customer validation.
 */
export default async function Pilot() {
  await guardPage();
  const e = env();
  const { db } = await getDb();
  const staff = new Set(e.STAFF_EMAIL_ALLOWLIST.map((x) => x.toLowerCase()));
  const rows = await db.select({ r: t.requests, email: t.contacts.emailLookup }).from(t.requests).innerJoin(t.contacts, eq(t.contacts.id, t.requests.contactId)).orderBy(desc(t.requests.createdAt)).limit(300);
  const ids = rows.map((x) => x.r.id);
  const outs = ids.length ? await db.select().from(t.requestOutcomes).where(inArray(t.requestOutcomes.requestId, ids)) : [];
  const sends = ids.length ? await db.select({ requestId: t.sendIntents.requestId, cls: t.sendIntents.messageClass, state: t.sendIntents.state, providerId: t.sendIntents.providerMessageId }).from(t.sendIntents).where(inArray(t.sendIntents.requestId, ids)) : [];
  const tests = await testConversationIds(db, [...new Set(rows.map((x) => x.r.conversationId))]);
  const evs = [...new Set(rows.map((x) => x.r.eventId).filter((x): x is string => !!x))];
  const fixtureEvents = new Set(evs.length ? (await db.select({ id: t.events.id, f: t.events.isFixture }).from(t.events).where(inArray(t.events.id, evs))).filter((x) => x.f).map((x) => x.id) : []);
  const real = rows.filter(({ r, email }) => !staff.has(email) && !tests.has(r.conversationId) && !(r.eventId && fixtureEvents.has(r.eventId)) && e.APP_MODE !== 'fixture' && (r.problemTypes ?? []).length > 0);
  const answered = (id: string) => sends.some((s) => s.requestId === id && ['recommendation', 'no_result', 'acknowledgment'].includes(s.cls) && ['provider_accepted', 'delivered'].includes(s.state) && !isCapturedSendId(s.providerId));
  const of = (id: string, kind: string) => outs.filter((o) => o.requestId === id && o.kind === kind);
  const table = real.map(({ r }) => {
    const reply = of(r.id, 'follow_up_reply')[0]?.details as { changedWhat?: boolean | null; changedWhen?: boolean | null } | undefined;
    return {
      r,
      answered: answered(r.id),
      followUp: of(r.id, 'follow_up_reply').length ? 'answered' : of(r.id, 'follow_up_sent').length ? 'sent' : '',
      changed: reply ? [reply.changedWhat ? 'what' : null, reply.changedWhen ? 'when' : null].filter(Boolean).join(' + ') || (reply.changedWhat === false || reply.changedWhen === false ? 'no' : 'not said') : '',
      reported: of(r.id, 'user_reported_purchase').length ? 'bought' : of(r.id, 'user_reported_no_purchase').length ? 'didn’t buy' : '',
      confirmed: of(r.id, 'affiliate_confirmed_purchase').length > 0,
      clicks: of(r.id, 'link_click').filter((o) => !(o.details as { likelyBot?: boolean }).likelyBot).length,
    };
  });
  const answeredCount = table.filter((x) => x.answered).length;
  const withOutcome = table.filter((x) => x.followUp === 'answered' || x.reported || x.confirmed).length;
  // The staffed comparison pilot (DECISION_LOG #54): what was promised, what was answered, how fast, and which
  // sellers staff had to check by hand, which is the list automation would need.
  const offered = outs.filter((o) => o.kind === 'staff_comparison_offered' && (o.details as { counted?: boolean }).counted);
  const answeredCmp = outs.filter((o) => o.kind === 'staff_comparison_answered' && offered.some((x) => x.requestId === o.requestId));
  const minutes = answeredCmp.map((o) => Number((o.details as { minutes?: number }).minutes ?? 0)).sort((a, b) => a - b);
  const medianMinutes = minutes.length ? minutes[Math.floor(minutes.length / 2)]! : null;
  const sourcesUsed = [...new Set(answeredCmp.map((o) => String((o.details as { sourceId?: string }).sourceId ?? '')).filter(Boolean))];
  const byType = PROBLEM_TYPES.map((p) => [p, table.filter((x) => (x.r.problemTypes ?? []).includes(p)).length] as const).filter(([, n]) => n > 0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Pilot</h1>
        <p className="mt-1 text-sm text-gray-600">Real requests only: staff addresses, fixture data and test-mode customers are left out. {e.FOLLOW_UP_ENABLED ? 'Follow-ups are on.' : 'Follow-ups are off (FOLLOW_UP_ENABLED); they are recorded but not sent.'}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 p-3"><p className="text-sm text-gray-500">Answered</p><p className="text-2xl font-semibold">{answeredCount} / {PILOT_TARGET}</p></div>
        <div className="rounded-lg border border-gray-200 p-3"><p className="text-sm text-gray-500">With an outcome</p><p className="text-2xl font-semibold">{withOutcome}</p></div>
        <div className="rounded-lg border border-gray-200 p-3"><p className="text-sm text-gray-500">Advice changed what or when</p><p className="text-2xl font-semibold">{table.filter((x) => x.changed && x.changed !== 'no' && x.changed !== 'not said').length}</p></div>
      </div>
      <div className="rounded-lg border border-gray-200 p-3 text-sm">
        <p className="font-medium">Staffed comparisons</p>
        {e.STAFF_COMPARISON_OWNER && staff.has(e.STAFF_COMPARISON_OWNER) ? (
          <p className="mt-1 text-gray-700">
            Owner {e.STAFF_COMPARISON_OWNER}. Offered {offered.length} / {e.STAFF_COMPARISON_LIMIT}, answered {answeredCmp.length}, still open {offered.length - answeredCmp.length}
            {medianMinutes !== null ? `, median ${medianMinutes < 120 ? `${medianMinutes} min` : `${Math.round(medianMinutes / 60)} h`} to a verified option` : ''}.
            {sourcesUsed.length ? ` Sellers checked by hand: ${sourcesUsed.join(', ')}.` : ''}
          </p>
        ) : (
          <p className="mt-1 text-gray-500">Off: no owner. Set STAFF_COMPARISON_OWNER to a staff address to offer customers a person-found comparison when nothing verified meets their request.</p>
        )}
      </div>
      {byType.length ? <p className="text-sm text-gray-700">{byType.map(([p, n]) => `${p.replace(/_/g, ' ')} ${n}`).join(' · ')}</p> : null}
      <table className="w-full text-left text-sm">
        <thead className="text-gray-500"><tr><th className="py-1">Request</th><th>Needed</th><th>Answered</th><th>Follow-up</th><th>Changed</th><th>Said</th><th>Affiliate</th><th>Clicks</th></tr></thead>
        <tbody>
          {table.map((x) => (
            <tr key={x.r.id} className="border-t border-gray-100">
              <td className="py-1"><Link className="text-blue-700 underline" href={`/admin/requests/${x.r.id}`}>{whenStaff(x.r.createdAt)}</Link></td>
              <td>{(x.r.problemTypes ?? []).map((p) => p.replace(/_/g, ' ')).join(', ')}</td>
              <td>{x.answered ? 'yes' : ''}</td>
              <td>{x.followUp}</td>
              <td>{x.changed}</td>
              <td>{x.reported}</td>
              <td>{x.confirmed ? 'confirmed' : ''}</td>
              <td>{x.clicks || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!table.length ? <p className="text-sm text-gray-500">No real requests yet.</p> : null}
    </div>
  );
}
