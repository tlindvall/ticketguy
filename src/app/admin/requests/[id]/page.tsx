import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { ActionButton } from '@/components/ActionButton';
import { JsonForm } from '@/components/JsonForm';
import { formatUsd, formatUsdChange } from '@/lib/domain/money';
import type { AdvicePacket } from '@/lib/advice/packet';
import { newIdempotencyKey, nowMs } from '@/lib/util/clock';
import { sourcePlan } from '@/lib/sources/routing';
import { researchLinksFor, type ResearchLink } from '@/lib/catalog/research-links';
import { eventLocalDate } from '@/lib/domain/dates';
import { marketForGroup, marketLicence, marketUses } from '@/lib/market/tracker';
import { env as appEnv } from '@/lib/config/env';
import type { MarketContext } from '@/lib/market/series';
import { ago, briefLines, type Tone, reasonText, sendClassLabel, sendStateInfo, stateInfo, toneClass, whenLocal, whenStaff } from '@/lib/admin/labels';

export const dynamic = 'force-dynamic';

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await guardPage();
  const { id } = await params;
  const { db } = await getDb();
  const [req] = await db.select().from(t.requests).where(eq(t.requests.id, id));
  if (!req) notFound();
  const [contact] = await db.select().from(t.contacts).where(eq(t.contacts.id, req.contactId));
  const messages = await db.select().from(t.messages).where(eq(t.messages.conversationId, req.conversationId)).orderBy(asc(t.messages.receivedAt));
  const versions = await db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, id)).orderBy(desc(t.requestVersions.revision));
  const transitions = await db.select().from(t.requestTransitions).where(eq(t.requestTransitions.requestId, id)).orderBy(asc(t.requestTransitions.createdAt));
  const event = req.eventId ? (await db.select({ e: t.events, v: t.venues }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(eq(t.events.id, req.eventId)))[0] : null;
  const runs = await db.select().from(t.researchRuns).where(eq(t.researchRuns.requestId, id)).orderBy(desc(t.researchRuns.startedAt));
  const latestRun = runs[0];
  const checks = latestRun ? await db.select().from(t.sourceChecks).where(eq(t.sourceChecks.runId, latestRun.id)).orderBy(asc(t.sourceChecks.ordinal)) : [];
  const observations = latestRun ? await db.select({ o: t.offerObservations, off: t.offers }).from(t.offerObservations).innerJoin(t.offers, eq(t.offers.id, t.offerObservations.offerId)).where(eq(t.offerObservations.runId, latestRun.id)) : [];
  const manual = req.eventId ? await db.select({ o: t.offerObservations, off: t.offers }).from(t.offerObservations).innerJoin(t.offers, eq(t.offers.id, t.offerObservations.offerId)).where(eq(t.offerObservations.verificationMethod, 'approved_manual')).then((rows) => rows.filter((r) => r.o.eventId === req.eventId)) : [];
  const recs = await db.select().from(t.recommendations).where(eq(t.recommendations.requestId, id)).orderBy(desc(t.recommendations.createdAt));
  const advice = await db.select().from(t.adviceRuns).where(eq(t.adviceRuns.requestId, id)).orderBy(desc(t.adviceRuns.createdAt)).limit(1);
  const bench = advice[0]?.benchmarkRunId ? (await db.select().from(t.benchmarkRuns).where(eq(t.benchmarkRuns.id, advice[0].benchmarkRunId)))[0] : null;
  const trend = advice[0]?.trendRunId ? (await db.select().from(t.trendRuns).where(eq(t.trendRuns.id, advice[0].trendRunId)))[0] : null;
  const intents = await db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, id)).orderBy(desc(t.sendIntents.createdAt));
  const attachments = messages.length ? await db.select().from(t.attachments).where(inArray(t.attachments.messageId, messages.map((m) => m.id))) : [];
  const spend = await db.select().from(t.usageLedger).where(eq(t.usageLedger.requestId, id));
  const spendUsd = spend.reduce((s, r) => s + (r.kind === 'released' ? -r.estimatedUsdMicros : r.estimatedUsdMicros), 0) / 1e6;
  const packet = advice[0]?.packet as unknown as AdvicePacket | undefined;
  // Sources the routing policy requires for this event that have no enabled adapter: those are a person's job
  // until approved access exists, so they are listed with a link to check by hand.
  const adapterRows = event ? await db.select().from(t.adapterConfigs) : [];
  const enabledSources = new Set(adapterRows.filter((a) => a.enabled && a.implementation !== 'not_integrated').map((a) => a.sourceId));
  const mappings = event ? await db.select().from(t.eventSourceMappings).where(eq(t.eventSourceMappings.eventId, event.e.id)) : [];
  const officialUrls = Object.fromEntries(mappings.filter((m) => m.authoritativeUrl).map((m) => [m.sourceId, m.authoritativeUrl!]));
  const plan = event ? sourcePlan(event.e.category) : { required: [], conditional: [] };
  const manualSources = plan.required.filter((sid) => !enabledSources.has(sid));
  const conditionalSources = plan.conditional.filter((sid) => !enabledSources.has(sid));
  const researchLinks = event ? researchLinksFor({ sourceIds: manualSources, conditionalSourceIds: conditionalSources, eventName: event.e.name, localDate: eventLocalDate(event.e.localStartAt, event.v.timezone), officialUrls }) : [];
  const requiredLinks = researchLinks.filter((l) => l.role === 'required');
  const conditionalLinks = researchLinks.filter((l) => l.role === 'conditional');
  const brief = versions[0]?.brief as Record<string, unknown> | undefined;
  const now = nowMs();
  const s = stateInfo(req.state);
  const [lastMove] = [...transitions].reverse();
  const why = reasonText(lastMove?.reason, req.state);
  const pending = recs.find((r) => r.reviewStatus === 'pending' && r.revision === req.currentRevision);
  const earlierDrafts = recs.filter((r) => r !== pending);
  const firstSubject = messages.find((m) => m.direction === 'inbound' && m.subject)?.subject;
  const offers = [...observations, ...manual];
  // Checking sellers by hand is the job when nothing was found automatically, or a person has the request.
  const handCheckOpen = req.state === 'manual_attention' || (req.state === 'awaiting_review' && offers.length === 0);
  const eventUrl = event ? (officialUrls.ticketmaster ?? Object.values(officialUrls)[0]) : undefined;
  const lines = brief ? briefLines(brief) : [];
  // Resale market statistics for this event (DECISION_LOG #44): staff see them whenever tracking is licensed.
  const licence = await marketLicence(db);
  const [tracked] = event ? await db.select().from(t.trackedEvents).where(eq(t.trackedEvents.eventId, event.e.id)) : [];
  const market = event && licence.allows('tracking') ? await marketForGroup(db, { eventId: event.e.id, quantity: Number(brief?.quantity ?? 2), eventStartAt: event.e.localStartAt, now: new Date(now) }) : null;
  // The conversation is what was actually sent and received, plus our emails that are queued or were held
  // back (those never become messages), so a reviewer sees every reply the customer got or is about to get.
  const sentIds = new Set(messages.map((m) => m.providerEmailId).filter(Boolean));
  const timeline = [
    ...messages.map((m) => ({ key: m.id, mine: m.direction === 'outbound', who: m.direction === 'outbound' ? 'Ticket Guy' : m.fromAddress, at: m.receivedAt, text: m.sanitizedText ?? '', status: null as null | [string, Tone], auto: m.autoSubmitted, messageId: m.id })),
    ...intents.filter((i) => !i.providerMessageId || !sentIds.has(i.providerMessageId)).map((i) => ({ key: i.id, mine: true, who: `Ticket Guy · ${sendClassLabel(i.messageClass)}`, at: i.createdAt, text: i.bodyText, status: sendStateInfo(i.state), auto: false, messageId: null as string | null })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <main className="space-y-6">
      <p className="text-sm"><Link className="text-gray-600 hover:underline" href="/admin/inbox">&larr; All requests</Link></p>

      <header className="space-y-2">
        <h1 className="text-2xl font-bold">{event ? event.e.name : (typeof brief?.performerOrTeam === 'string' && brief.performerOrTeam) || firstSubject || 'New request'}</h1>
        <p className="text-sm text-gray-600">
          From <Link className="underline" href={`/admin/contacts/${contact!.id}`}>{contact!.emailOriginal}</Link> · started {ago(req.createdAt.getTime(), now)} · last change {ago(req.updatedAt.getTime(), now)}
          {!contact!.countryConfirmed ? <> · <span className="tg-badge tg-badge-warn">US not confirmed</span></> : null}
        </p>
        {req.state !== 'closed' ? <ActionButton url="/api/admin/requests/remove" body={{ requestIds: [req.id] }} label="Remove from the board" confirm="Remove this request? Nothing more will be sent for it, and it moves to Closed." /> : null}
        {pending ? null : <div className={`rounded-lg border p-3 ${s.tone === 'danger' ? 'border-rose-300 bg-rose-50' : s.tone === 'warn' ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
          <p className="text-sm"><span className={`tg-badge ${toneClass[s.tone]}`}>{s.label}</span> <span className="ml-1">{s.next}</span></p>
          {why ? <p className="mt-1 text-sm text-gray-700"><strong>Why:</strong> {why}</p> : null}
        </div>}
      </header>

      {pending ? (
        <section className="rounded-lg border-2 border-amber-300 p-4">
          <h2 className="text-lg font-semibold">Reply waiting for your approval</h2>
          <p className="mt-1 text-sm text-gray-600">This is exactly what the customer will get. Approving sends it now.</p>
          <div className="mt-3 rounded-md border border-gray-200 bg-white">
            <p className="border-b border-gray-200 px-3 py-2 text-sm"><span className="text-gray-500">Subject:</span> {pending.subject}</p>
            <pre className="whitespace-pre-wrap px-3 py-3 font-sans text-sm leading-relaxed">{pending.bodyText}</pre>
          </div>
          {pending.reviewNote ? <p className="mt-2 text-sm text-rose-900"><strong>Note:</strong> {pending.reviewNote}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ActionButton url={`/api/admin/recommendations/${pending.id}/approve`} body={{ expectedRevision: req.currentRevision, draftHash: pending.draftHash, note: null }} label="Approve and send" variant="primary" confirm="Send this reply to the customer now?" />
            {offers.length ? <ActionButton url={`/api/admin/recommendations/${pending.id}/revalidate`} label="Re-check the listing first" /> : null}
            <span className="text-xs text-gray-500">Not right? Check sellers by hand below and add what you find, then re-run the check.</span>
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="text-lg font-semibold">Conversation</h2>
          <ol className="mt-2 space-y-3">
            {timeline.map((m) => (
              <li key={m.key} className={`rounded-lg border p-3 text-sm ${m.mine ? 'ml-6 border-teal-200 bg-teal-50' : 'mr-6 border-gray-200 bg-white'}`}>
                <p className="text-xs text-gray-500">
                  <strong className="text-gray-800">{m.who}</strong> · {whenStaff(m.at)}
                  {m.status ? <> · <span className={`tg-badge ${toneClass[m.status[1]]}`}>{m.status[0]}</span></> : null}
                  {m.auto ? <> · <span className="tg-badge tg-badge-warn">auto-reply</span></> : null}
                </p>
                <pre className="mt-1 whitespace-pre-wrap font-sans">{m.text}</pre>
                {m.messageId ? attachments.filter((a) => a.messageId === m.messageId).map((a) => (
                  <p key={a.id} className="mt-1 text-xs">Attachment: {a.filename ?? 'file'} {a.validationState !== 'accepted' ? <span className="tg-badge tg-badge-warn">{a.validationState}</span> : null} {a.mediaId ? <a className="underline" href={`/api/admin/media/${a.mediaId}`}>download</a> : null}</p>
                )) : null}
              </li>
            ))}
          </ol>
          {!timeline.length ? <p className="mt-2 text-sm text-gray-500">No messages.</p> : null}
        </section>

        <aside className="space-y-4">
          <div className="rounded-lg border border-gray-200 p-3">
            <h2 className="font-semibold">What they want</h2>
            {lines.length ? (
              <dl className="mt-2 space-y-1 text-sm">
                {lines.map(([k, v]) => (
                  <div key={k} className="flex gap-2"><dt className="w-28 shrink-0 text-gray-500">{k}</dt><dd>{v}</dd></div>
                ))}
              </dl>
            ) : <p className="mt-1 text-sm text-gray-500">Not read yet.</p>}
          </div>
          <div className="rounded-lg border border-gray-200 p-3">
            <h2 className="font-semibold">Event</h2>
            {event ? (
              <div className="mt-1 space-y-0.5 text-sm">
                <p>{event.e.name}</p>
                <p className="text-gray-600">{whenLocal(event.e.localStartAt, event.v.timezone)}</p>
                <p className="text-gray-600">{event.v.name}, {event.v.city}</p>
                {event.e.faceMinCents != null && event.e.faceMaxCents != null ? <p className="text-gray-600">Face value {formatUsd(event.e.faceMinCents)}–{formatUsd(event.e.faceMaxCents)} before fees</p> : null}
                {eventUrl ? <p><a className="text-blue-700 underline" href={eventUrl} target="_blank" rel="noopener noreferrer">Official event page</a></p> : null}
              </div>
            ) : <p className="mt-1 text-sm text-gray-500">Not matched to an event yet, so no prices can be checked.</p>}
          </div>
          {event ? <MarketCard market={market} tracked={tracked ?? null} licensed={licence.allows('tracking')} shown={marketUses(licence, appEnv()).display} quantity={Number(brief?.quantity ?? 2)} now={now} /> : null}
        </aside>
      </div>

      {req.eventId ? (
        <details className="rounded-lg border border-gray-200 p-4" open={handCheckOpen}>
          <summary className="cursor-pointer text-lg font-semibold">Check sellers by hand</summary>
          <p className="mt-2 text-sm text-gray-600">We can&rsquo;t read these sellers automatically yet. Open them, find seats that fit, and add what you see below: the exact listing link and the total with every fee. Then re-run the check to rebuild the reply.</p>
          {researchLinks.length ? (
            <>
              <ResearchLinkList links={requiredLinks} />
              {conditionalLinks.length ? (
                <>
                  <h3 className="mt-3 text-sm font-semibold text-gray-700">Also worth a look for this kind of event</h3>
                  <ResearchLinkList links={conditionalLinks} />
                </>
              ) : null}
            </>
          ) : null}
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">Add a listing you found</summary>
            <div className="mt-2">
              <JsonForm url={`/api/admin/requests/${id}/manual-offers`} submitLabel="Save listing" fields={[{ name: 'sourceId', label: 'Seller (e.g. stubhub, seatgeek, vividseats)', required: true, placeholder: 'stubhub' }, { name: 'sourceUrl', label: 'Listing link (https)', required: true }, { name: 'observedAt', label: 'When you saw it', type: 'datetime', required: true }, { name: 'quantity', label: 'Tickets', type: 'number', required: true, defaultValue: Number(brief?.quantity ?? 2) }, { name: 'section', label: 'Section' }, { name: 'row', label: 'Row' }, { name: 'seatClass', label: 'Seat area (upper, lower, floor…)' }, { name: 'baseTotalCents', label: 'Price before fees, in cents (e.g. 25000 = $250)', type: 'number' }, { name: 'payableTotalCents', label: 'Total with all fees, in cents', type: 'number' }, { name: 'seatsTogether', label: 'Seats are together', type: 'checkbox' }, { name: 'feesKnown', label: 'I saw every mandatory fee', type: 'checkbox' }, { name: 'taxKnown', label: 'Tax was shown', type: 'checkbox' }, { name: 'deliveryMethod', label: 'Delivery (mobile, transfer…)' }, { name: 'evidenceNote', label: 'What you saw and exactly what you selected', type: 'textarea', required: true }]} extra={{ restrictions: [] }} nullableCheckboxes={['seatsTogether']} />
            </div>
          </details>
          <div className="mt-4"><ActionButton url={`/api/admin/requests/${id}/research`} body={{ expectedRevision: req.currentRevision, idempotencyKey: newIdempotencyKey() }} label="Re-run the check" /></div>
        </details>
      ) : null}

      <details className="rounded-lg border border-gray-200 p-4">
        <summary className="cursor-pointer text-lg font-semibold">Behind the scenes</summary>
        <p className="mt-1 text-xs text-gray-500">For troubleshooting. Nothing here needs doing day to day.</p>

        <h3 className="mt-4 font-semibold">Listings found ({offers.length})</h3>
        {offers.length ? (
          <table className="tg-table mt-2">
            <thead><tr><th>Seller</th><th>Tickets</th><th>Section / row</th><th>Together</th><th>Total</th><th>Price</th><th>How we got it</th><th>Seen</th></tr></thead>
            <tbody>
              {offers.map(({ o, off }) => (
                <tr key={o.id}>
                  <td>{off.sourceId}</td><td>{o.quantity}</td><td>{o.section ?? '—'} / {o.rowLabel ?? '—'}</td>
                  <td>{o.seatsTogether === null ? 'unknown' : o.seatsTogether ? 'yes' : 'no'}</td>
                  <td>{o.payableTotalCents === null ? 'unknown' : formatUsd(o.payableTotalCents)}</td>
                  <td>{o.priceCompleteness === 'verified_total' ? 'all-in' : o.priceCompleteness === 'estimated_total' ? 'estimated' : 'incomplete'}</td>
                  <td>{o.verificationMethod === 'approved_manual' ? 'added by staff' : o.verificationMethod === 'fixture' ? <span className="tg-badge tg-badge-danger">test data</span> : 'automatic'}</td>
                  <td>{whenStaff(o.fetchedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="mt-1 text-sm text-gray-500">None.</p>}

        <h3 className="mt-4 font-semibold">Sellers checked {latestRun ? <span className="text-xs font-normal text-gray-500">({latestRun.mode}, {latestRun.status})</span> : null}</h3>
        {checks.length ? (
          <table className="tg-table mt-2">
            <thead><tr><th>Seller</th><th>Result</th><th>Listings</th><th>Checked</th><th>Notes</th></tr></thead>
            <tbody>{checks.map((k) => <tr key={k.id}><td>{k.sourceId}</td><td>{k.status.replace(/_/g, ' ')}</td><td>{k.resultCount}</td><td>{whenStaff(k.observedAt)}</td><td className="text-xs text-gray-600">{k.limitations.join('; ')}</td></tr>)}</tbody>
          </table>
        ) : <p className="mt-1 text-sm text-gray-500">Not checked yet.</p>}

        {advice[0] ? (
          <>
            <h3 className="mt-4 font-semibold">How the reply was decided</h3>
            <p className="mt-1 text-sm">Decision <strong>{advice[0].decision.replace(/_/g, ' ')}</strong> · reasons: {advice[0].reasonCodes.join(', ') || 'none'} · held back: {advice[0].abstentions.join(', ') || 'nothing'} · policy {advice[0].policyVersion}</p>
            <p className="mt-1 text-xs text-gray-600">
              Price history: {bench ? `${bench.adequacy}, ${bench.independentEventCount} past events${bench.medianCents !== null ? `, median ${formatUsd(bench.medianCents)}` : ''}` : 'none'} · Trend: {trend ? `${trend.direction} (${trend.adequacy})` : 'none'}
            </p>
            {packet ? (
              <details className="mt-2 text-sm"><summary className="cursor-pointer">Facts the reply may use ({packet.claimRecords.length})</summary>
                <ul className="mt-1 space-y-1">{packet.claimRecords.map((c) => <li key={c.id}><code className="text-xs">{c.id}</code> {c.customerVisible ? '' : <span className="tg-badge tg-badge-warn">staff only</span>} {c.text}</li>)}</ul>
              </details>
            ) : null}
          </>
        ) : null}

        <h3 className="mt-4 font-semibold">Emails</h3>
        {intents.length ? (
          <table className="tg-table mt-2">
            <thead><tr><th>Kind</th><th>Status</th><th>Subject</th><th>Problem</th></tr></thead>
            <tbody>{intents.map((i) => { const [label, tone] = sendStateInfo(i.state); return <tr key={i.id}><td>{sendClassLabel(i.messageClass)}</td><td><span className={`tg-badge ${toneClass[tone]}`}>{label}</span></td><td>{i.subject}</td><td className="text-xs text-gray-600">{i.lastError ?? ''}</td></tr>; })}</tbody>
          </table>
        ) : <p className="mt-1 text-sm text-gray-500">None.</p>}

        {earlierDrafts.length ? (
          <>
            <h3 className="mt-4 font-semibold">Earlier drafts</h3>
            {earlierDrafts.map((r) => (
              <details key={r.id} className="mt-2 text-sm">
                <summary className="cursor-pointer">{r.subject} <span className="tg-badge tg-badge-muted">{DRAFT_STATUS[r.reviewStatus] ?? r.reviewStatus}</span> <span className="text-xs text-gray-500">{whenStaff(r.createdAt)}</span></summary>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 font-sans">{r.bodyText}</pre>
              </details>
            ))}
          </>
        ) : null}

        <h3 className="mt-4 font-semibold">History</h3>
        <ul className="mt-1 space-y-0.5 text-xs text-gray-600">{transitions.map((x) => <li key={x.id}>{whenStaff(x.createdAt)} · {stateInfo(x.toState).label} · {reasonText(x.reason, x.toState) || '—'} · {x.actor}</li>)}</ul>
        {versions[0]?.unresolvedFields.length ? <p className="mt-2 text-xs text-gray-600">Still unclear: {versions[0].unresolvedFields.join(', ')}</p> : null}
        <p className="mt-2 text-xs text-gray-500">AI cost ${spendUsd.toFixed(3)} · request {id} · version {req.currentRevision} · viewing as {staff.email} ({staff.role})</p>
      </details>
    </main>
  );
}

const DRAFT_STATUS: Record<string, string> = { pending: 'waiting', approved: 'approved', sent: 'sent', auto_sent: 'sent automatically', rejected: 'rejected', invalidated: 'replaced by a newer version' };

const ACCESS_BADGE: Record<ResearchLink['access'], string | null> = {
  catalog_api: null,
  listing_api_partner: null,
  listing_no_api: null,
  primary_platform: 'official seller',
  routing_reference: 'shows who sells it',
  context_rule: 'a policy to mention, not a price',
};

function ResearchLinkList({ links }: { links: ResearchLink[] }) {
  return (
    <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
      {links.map((l) => (
        <li key={l.sourceId}>
          <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">{l.name}</a>
          {' '}<span className={`tg-badge ${l.kind === 'official_event_page' ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{l.kind === 'official_event_page' ? 'official event page' : 'search'}</span>
          {ACCESS_BADGE[l.access] ? <span className="tg-badge tg-badge-muted ml-1">{ACCESS_BADGE[l.access]}</span> : null}
          {l.note ? <span className="ml-1 text-xs text-gray-600">{l.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function MarketCard({ market, tracked, licensed, shown, quantity, now }: { market: Awaited<ReturnType<typeof marketForGroup>> | null; tracked: typeof t.trackedEvents.$inferSelect | null; licensed: boolean; shown: boolean; quantity: number; now: number }) {
  const line = (label: string, c: MarketContext | null) => {
    if (!c?.current) return <p className="text-gray-500">{label}: no data yet</p>;
    const w = c.h72 ?? c.h24;
    return (
      <p>
        {label}: from <strong>{formatUsd(c.current.priceCents)}</strong> a ticket
        {w ? <span className={w.changeCents < 0 ? 'text-emerald-700' : w.changeCents > 0 ? 'text-rose-700' : ''}> ({formatUsdChange(w.changeCents)} in {w.hours}h)</span> : null}
        {c.adequacy !== 'sufficient' ? <span className="text-gray-500"> · not enough data for a trend</span> : c.direction !== 'flat' ? <span> · {c.direction === 'down' ? 'falling' : 'rising'}</span> : <span> · flat</span>}
      </p>
    );
  };
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <h2 className="font-semibold">Resale market</h2>
      {!licensed ? (
        <p className="mt-1 text-sm text-gray-500">Not switched on. See <a className="underline" href="/admin/market">Resale market</a>.</p>
      ) : !market || (!market.single.current && !tracked?.lastObservedAt) ? (
        <p className="mt-1 text-sm text-gray-500">{tracked ? (tracked.state === 'unmatched' ? 'SeatData does not have this event.' : tracked.state === 'requested' ? 'Asked SeatData to start tracking it.' : 'No market data yet.') : 'Not tracked yet.'}</p>
      ) : (
        <div className="mt-1 space-y-1 text-sm">
          {line('One ticket', market.single)}
          {line('Two together', market.pair)}
          {quantity > 2 ? line(`${Math.min(quantity, 12)} or more on one listing`, market.context) : null}
          {quantity > 2 ? <p className="text-xs text-gray-500">From SeatData&rsquo;s listings, read at each check while this request is open. A listing with more tickets may not sell exactly {quantity}.</p> : null}
          {market.supply.now !== null ? <p>{market.supplyScope === 'group' ? `Listings with ${Math.min(quantity, 12)} or more tickets` : 'Listings'}: {market.supply.now}{market.supply.before !== null ? ` (was ${market.supply.before}${market.supply.hours ? ` ${market.supply.hours}h ago` : ''})` : ''}{market.supply.trend === 'shrinking' ? <span className="tg-badge tg-badge-warn ml-1">shrinking</span> : null}</p> : null}
          {market.single.typical ? <p className="text-gray-600">Past games here at this point: {formatUsd(market.single.typical.p25Cents)}–{formatUsd(market.single.typical.p75Cents)} a ticket ({market.single.typical.events} games)</p> : null}
          <p className="text-xs text-gray-500">Listed prices before fees{market.single.current ? `, as of ${ago(market.single.current.at.getTime(), now)}` : ''}. {shown ? 'In the reply emails.' : 'Staff only: not in customer emails until customer display is licensed.'}</p>
        </div>
      )}
    </div>
  );
}
