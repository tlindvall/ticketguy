import Link from 'next/link';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { nowMs } from '@/lib/util/clock';
import { GROUPS, STATE, ago, reasonText, stateInfo, toneClass, whenLocal, type InboxGroup } from '@/lib/admin/labels';

export const dynamic = 'force-dynamic';

const OPEN = ['received', 'interpreting', 'needs_clarification', 'resolving_event', 'researching', 'awaiting_review', 'manual_attention', 'recommendation_sent', 'monitoring', 'referred'];

type Row = {
  id: string;
  state: string;
  updatedAt: Date;
  /** The customer wrote last, after we had already replied: there is something new to read. */
  newReply: boolean;
  customer: string;
  headline: string;
  when: string | null;
  snippet: string | null;
  why: string;
};

/**
 * The staff inbox, grouped by what a person has to do: "Needs you" first (a draft to approve, or a request
 * the system could not handle), then requests waiting on the customer, in progress, and answered. Each row
 * says who wrote, what they asked for and why it is where it is, in words rather than state names.
 */
export default async function Inbox({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  await guardPage();
  const { state } = await searchParams;
  const { db } = await getDb();
  const reqs = await db
    .select({ id: t.requests.id, state: t.requests.state, updatedAt: t.requests.updatedAt, contactId: t.requests.contactId, conversationId: t.requests.conversationId, eventId: t.requests.eventId })
    .from(t.requests)
    .where(state ? eq(t.requests.state, state) : inArray(t.requests.state, OPEN))
    .orderBy(desc(t.requests.updatedAt))
    .limit(200);

  const ids = reqs.map((r) => r.id);
  const contactIds = [...new Set(reqs.map((r) => r.contactId))];
  const convIds = [...new Set(reqs.map((r) => r.conversationId))];
  const eventIds = [...new Set(reqs.map((r) => r.eventId).filter((x): x is string => !!x))];
  const [contacts, inbound, events, transitions, versions] = await Promise.all([
    contactIds.length ? db.select({ id: t.contacts.id, email: t.contacts.emailOriginal }).from(t.contacts).where(inArray(t.contacts.id, contactIds)) : [],
    convIds.length ? db.select({ conversationId: t.messages.conversationId, direction: t.messages.direction, subject: t.messages.subject, text: t.messages.sanitizedText, at: t.messages.receivedAt }).from(t.messages).where(inArray(t.messages.conversationId, convIds)).orderBy(desc(t.messages.receivedAt)) : [],
    eventIds.length ? db.select({ id: t.events.id, name: t.events.name, at: t.events.localStartAt, tz: t.venues.timezone }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(inArray(t.events.id, eventIds)) : [],
    ids.length ? db.select({ requestId: t.requestTransitions.requestId, toState: t.requestTransitions.toState, reason: t.requestTransitions.reason, at: t.requestTransitions.createdAt }).from(t.requestTransitions).where(inArray(t.requestTransitions.requestId, ids)).orderBy(desc(t.requestTransitions.createdAt)) : [],
    ids.length ? db.select({ requestId: t.requestVersions.requestId, revision: t.requestVersions.revision, brief: t.requestVersions.brief }).from(t.requestVersions).where(inArray(t.requestVersions.requestId, ids)).orderBy(desc(t.requestVersions.revision)) : [],
  ]);
  const emailOf = new Map(contacts.map((c) => [c.id, c.email]));
  const lastInbound = new Map<string, (typeof inbound)[number]>();
  const firstSubject = new Map<string, string>();
  const newest = new Map<string, string>();
  const replied = new Set<string>();
  for (const m of inbound) {
    if (!newest.has(m.conversationId)) newest.set(m.conversationId, m.direction);
    if (m.direction === 'outbound') { replied.add(m.conversationId); continue; }
    if (!lastInbound.has(m.conversationId)) lastInbound.set(m.conversationId, m);
    if (m.subject) firstSubject.set(m.conversationId, m.subject); // ordered newest first, so the last write is the oldest
  }
  const eventOf = new Map(events.map((e) => [e.id, e]));
  // Before an event is matched, name the request by who they asked about ("Dua Lipa"), not the subject line.
  const askedAbout = new Map<string, string>();
  for (const v of versions) {
    const who = (v.brief as { performerOrTeam?: unknown } | null)?.performerOrTeam;
    if (!askedAbout.has(v.requestId) && typeof who === 'string' && who.trim()) askedAbout.set(v.requestId, who.trim());
  }
  const reasonOf = new Map<string, string | null>();
  for (const x of transitions) if (!reasonOf.has(x.requestId)) reasonOf.set(x.requestId, x.reason);

  const now = nowMs();
  const rows: Row[] = reqs.map((r) => {
    const ev = r.eventId ? eventOf.get(r.eventId) : undefined;
    const msg = lastInbound.get(r.conversationId);
    return {
      id: r.id,
      state: r.state,
      updatedAt: r.updatedAt,
      newReply: newest.get(r.conversationId) === 'inbound' && replied.has(r.conversationId),
      customer: emailOf.get(r.contactId) ?? 'unknown sender',
      headline: ev?.name ?? askedAbout.get(r.id) ?? firstSubject.get(r.conversationId) ?? '(no subject)',
      when: ev ? whenLocal(ev.at, ev.tz) : null,
      snippet: msg?.text ? firstLine(msg.text) : null,
      why: reasonText(reasonOf.get(r.id), r.state),
    };
  });

  const [waiting] = await db.select({ n: sql<number>`count(*)::int` }).from(t.requests).where(inArray(t.requests.state, ['awaiting_review', 'manual_attention']));
  const needsYou = waiting?.n ?? 0;

  return (
    <main className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Requests</h1>
          <p className="mt-1 text-sm text-gray-600">
            {needsYou > 0 ? <strong className="text-gray-900">{needsYou} need{needsYou === 1 ? 's' : ''} you.</strong> : 'Nothing needs you right now.'} Open one to see the conversation and what to do.
          </p>
        </div>
        <nav aria-label="Other requests" className="flex gap-3 text-sm">
          {state ? <Link className="underline" href="/admin/inbox">All open requests</Link> : null}
          <Link className="text-gray-600 underline" href="/admin/inbox?state=closed">Closed</Link>
          <Link className="text-gray-600 underline" href="/admin/inbox?state=unsupported">Outside what we cover</Link>
        </nav>
      </header>

      {state ? (
        <section>
          <h2 className="text-lg font-semibold">{STATE[state]?.label ?? state}</h2>
          <RequestList rows={rows} now={now} empty="None." />
        </section>
      ) : (
        GROUPS.map((g) => <Group key={g.id} id={g.id} title={g.title} empty={g.empty} rows={rows.filter((r) => stateInfo(r.state).group === g.id)} now={now} />)
      )}
    </main>
  );
}

function Group({ id, title, empty, rows, now }: { id: InboxGroup; title: string; empty: string; rows: Row[]; now: number }) {
  // What needs a person goes oldest first (who has waited longest); everything else newest first.
  const sorted = id === 'needs_you' ? [...rows].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime()) : rows;
  return (
    <section>
      <h2 className={`flex items-center gap-2 text-lg font-semibold ${id === 'needs_you' && rows.length ? 'text-rose-900' : ''}`}>
        {title} <span className="tg-badge tg-badge-muted">{rows.length}</span>
      </h2>
      <RequestList rows={sorted} now={now} empty={empty} />
    </section>
  );
}

function RequestList({ rows, now, empty }: { rows: Row[]; now: number; empty: string }) {
  if (!rows.length) return <p className="mt-2 text-sm text-gray-500">{empty}</p>;
  return (
    <ul className="mt-2 divide-y divide-gray-200 rounded-lg border border-gray-200">
      {rows.map((r) => {
        const s = stateInfo(r.state);
        return (
          <li key={r.id}>
            <Link href={`/admin/requests/${r.id}`} className="block px-4 py-3 hover:bg-gray-50">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`tg-badge ${toneClass[s.tone]}`}>{s.label}</span>
                {r.newReply ? <span className="tg-badge tg-badge-warn">New reply</span> : null}
                <span className="text-gray-600">{r.customer}</span>
                <span className="ml-auto text-xs text-gray-500">{ago(r.updatedAt.getTime(), now)}</span>
              </div>
              <p className="mt-1 font-medium text-gray-900">
                {r.headline}
                {r.when ? <span className="font-normal text-gray-600"> · {r.when}</span> : null}
              </p>
              {r.snippet ? <p className="mt-0.5 truncate text-sm text-gray-600">&ldquo;{r.snippet}&rdquo;</p> : null}
              {r.why ? <p className="mt-0.5 text-xs text-gray-500">{r.why}</p> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The customer's own words, without quoted history or signatures: the first non-empty line, capped. */
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('>')) ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
