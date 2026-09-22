import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { ActionButton } from '@/components/ActionButton';
import { JsonForm } from '@/components/JsonForm';
import { formatUsd } from '@/lib/domain/money';
import type { AdvicePacket } from '@/lib/advice/packet';
import { newIdempotencyKey } from '@/lib/util/clock';

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
  const brief = versions[0]?.brief as Record<string, unknown> | undefined;

  return (
    <main className="space-y-8">
      <header>
        <p className="text-xs text-gray-500"><Link href="/admin/inbox">Inbox</Link> / request {id.slice(0, 8)}</p>
        <h1 className="text-xl font-bold">
          {event ? event.e.name : 'Event unresolved'} <span className="tg-badge tg-badge-muted">{req.state}</span> <span className="tg-badge tg-badge-muted">rev {req.currentRevision}</span>
        </h1>
        <p className="text-sm text-gray-600">
          {event ? `${event.v.name}, ${event.v.city} · ${event.e.localStartAt.toISOString()} (${event.v.timezone})` : 'No canonical event attached; no offers can be compared.'} · contact <Link className="underline" href={`/admin/contacts/${contact!.id}`}>{contact!.emailOriginal}</Link> · country {contact!.countryConfirmed ?? <span className="tg-badge tg-badge-warn">unconfirmed</span>} · AI spend ${spendUsd.toFixed(3)}
        </p>
      </header>

      <section>
        <h2 className="font-semibold">Buying brief (revision {versions[0]?.revision ?? '—'})</h2>
        {brief ? (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            {['intent', 'performerOrTeam', 'city', 'dateExpression', 'resolvedLocalDate', 'quantity', 'budgetCents', 'budgetBasis', 'togetherRequired', 'mustAttend', 'waitRiskTolerance', 'decisionDeadline', 'splitGroupAllowed', 'forSelf', 'accessibilityNeeds', 'seatingPreference'].map((k) => (
              <div key={k}><dt className="text-gray-500">{k}</dt><dd>{k === 'budgetCents' && typeof brief[k] === 'number' ? formatUsd(brief[k] as number) : String(brief[k] ?? '—')}</dd></div>
            ))}
          </dl>
        ) : <p className="text-sm text-gray-600">Not interpreted yet.</p>}
        {versions[0]?.unresolvedFields.length ? <p className="mt-2 text-sm"><span className="tg-badge tg-badge-warn">unresolved</span> {versions[0].unresolvedFields.join(', ')}</p> : null}
      </section>

      <section>
        <h2 className="font-semibold">Conversation</h2>
        <ul className="mt-2 space-y-2">
          {messages.map((m) => (
            <li key={m.id} className={`rounded border p-2 text-sm ${m.direction === 'inbound' ? 'border-gray-200' : 'border-teal-200 bg-teal-50'}`}>
              <div className="text-xs text-gray-500">{m.direction} · {m.fromAddress} · {m.receivedAt.toISOString()} {m.autoSubmitted ? <span className="tg-badge tg-badge-warn">auto-response</span> : null}</div>
              <pre className="mt-1 whitespace-pre-wrap font-sans">{m.sanitizedText}</pre>
              {attachments.filter((a) => a.messageId === m.id).map((a) => (
                <div key={a.id} className="mt-1 text-xs">attachment {a.filename ?? a.id.slice(0, 8)} · <span className={`tg-badge ${a.validationState === 'accepted' ? 'tg-badge-ok' : 'tg-badge-warn'}`}>{a.validationState}</span> {a.validationReason ?? ''} {a.mediaId ? <a className="underline" href={`/api/admin/media/${a.mediaId}`}>download</a> : null}</div>
              ))}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="font-semibold">Source coverage {latestRun ? <span className="tg-badge tg-badge-muted">{latestRun.mode} run · {latestRun.status}</span> : null}</h2>
        {checks.length ? (
          <table className="tg-table mt-2">
            <thead><tr><th>Source</th><th>Status</th><th>Results</th><th>Observed</th><th>Limitations</th></tr></thead>
            <tbody>{checks.map((k) => <tr key={k.id}><td>{k.sourceId}</td><td><span className={`tg-badge ${k.status === 'success' ? 'tg-badge-ok' : k.status === 'no_matching_inventory' ? 'tg-badge-muted' : 'tg-badge-warn'}`}>{k.status}</span></td><td>{k.resultCount}</td><td>{k.observedAt.toISOString().slice(11, 19)}</td><td className="text-xs text-gray-600">{k.limitations.join('; ')}</td></tr>)}</tbody>
          </table>
        ) : <p className="text-sm text-gray-600">No research run yet.</p>}
        {req.eventId ? <div className="mt-2"><ActionButton url={`/api/admin/requests/${id}/research`} body={{ expectedRevision: req.currentRevision, idempotencyKey: newIdempotencyKey() }} label="Re-run research" /></div> : null}
      </section>

      <section>
        <h2 className="font-semibold">Offer observations</h2>
        <table className="tg-table mt-2">
          <thead><tr><th>Source</th><th>Qty</th><th>Section/Row</th><th>Together</th><th>Total</th><th>Completeness</th><th>Restrictions</th><th>Method</th><th>Fetched</th></tr></thead>
          <tbody>
            {[...observations, ...manual].map(({ o, off }) => (
              <tr key={o.id}>
                <td>{off.sourceId}</td><td>{o.quantity}</td><td>{o.section ?? '—'}/{o.rowLabel ?? '—'}</td>
                <td>{o.seatsTogether === null ? <span className="tg-badge tg-badge-warn">unknown</span> : o.seatsTogether ? 'yes' : 'no'}</td>
                <td>{o.payableTotalCents === null ? <span className="tg-badge tg-badge-warn">unknown</span> : formatUsd(o.payableTotalCents)}</td>
                <td><span className={`tg-badge ${o.priceCompleteness === 'verified_total' ? 'tg-badge-ok' : 'tg-badge-warn'}`}>{o.priceCompleteness}</span></td>
                <td className="text-xs">{o.restrictions.join(', ') || '—'}</td>
                <td><span className={`tg-badge ${o.verificationMethod === 'fixture' ? 'tg-badge-danger' : 'tg-badge-muted'}`}>{o.verificationMethod}</span></td>
                <td>{o.fetchedAt.toISOString().slice(11, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {req.eventId ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">Add manual evidence (staff-checked offer)</summary>
            <div className="mt-2">
              <JsonForm url={`/api/admin/requests/${id}/manual-offers`} submitLabel="Record manual observation" fields={[{ name: 'sourceId', label: 'Registry source id', required: true, placeholder: 'stubhub' }, { name: 'sourceUrl', label: 'Listing URL (https)', required: true }, { name: 'observedAt', label: 'Observed at', type: 'datetime', required: true }, { name: 'quantity', label: 'Quantity', type: 'number', required: true, defaultValue: Number(brief?.quantity ?? 2) }, { name: 'section', label: 'Section' }, { name: 'row', label: 'Row' }, { name: 'seatClass', label: 'Seat class (upper/lower/floor…)' }, { name: 'baseTotalCents', label: 'Base total (cents)', type: 'number' }, { name: 'payableTotalCents', label: 'Payable total incl. fees (cents)', type: 'number' }, { name: 'seatsTogether', label: 'Seats together verified', type: 'checkbox' }, { name: 'feesKnown', label: 'All mandatory fees known', type: 'checkbox' }, { name: 'taxKnown', label: 'Tax known', type: 'checkbox' }, { name: 'deliveryMethod', label: 'Delivery method' }, { name: 'evidenceNote', label: 'Evidence note (what you saw, exact selection)', type: 'textarea', required: true }]} extra={{ restrictions: [] }} nullableCheckboxes={['seatsTogether']} />
            </div>
          </details>
        ) : null}
      </section>

      {advice[0] ? (
        <section>
          <h2 className="font-semibold">Advice run <span className="tg-badge tg-badge-muted">{advice[0].policyVersion}</span></h2>
          <p className="mt-1 text-sm">Decision <strong>{advice[0].decision}</strong> · reasons: {advice[0].reasonCodes.join(', ')} · abstentions: {advice[0].abstentions.join(', ') || 'none'}</p>
          <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded border border-gray-200 p-2">
              <h3 className="font-medium">Historical benchmark {bench ? <span className={`tg-badge ${bench.adequacy === 'sufficient' ? 'tg-badge-ok' : 'tg-badge-warn'}`}>{bench.adequacy}</span> : <span className="tg-badge tg-badge-warn">history unavailable</span>}</h3>
              {bench ? <p className="text-xs text-gray-700">{bench.independentEventCount} independent events · median {bench.medianCents !== null ? formatUsd(bench.medianCents) : '—'} · P25 {bench.p25Cents !== null ? formatUsd(bench.p25Cents) : '—'} · P75 {bench.p75Cents !== null ? formatUsd(bench.p75Cents) : '—'} · {bench.methodVersion} · exclusions {bench.exclusions.length} · {bench.adequacyReasons.join('; ')}</p> : null}
            </div>
            <div className="rounded border border-gray-200 p-2">
              <h3 className="font-medium">Trend {trend ? <span className={`tg-badge ${trend.adequacy === 'sufficient' ? 'tg-badge-ok' : 'tg-badge-warn'}`}>{trend.direction}</span> : <span className="tg-badge tg-badge-warn">no observations</span>}</h3>
              {trend ? <p className="text-xs text-gray-700">sources {trend.sourceIntersection.join(', ')} · flags {trend.qualityFlags.join(', ') || 'none'} · {trend.methodVersion}</p> : null}
            </div>
          </div>
          {packet ? (
            <details className="mt-2 text-sm"><summary className="cursor-pointer font-medium">Claim packet ({packet.claimRecords.length} claims, hash {advice[0].packetHash.slice(0, 12)})</summary>
              <ul className="mt-1 space-y-1">{packet.claimRecords.map((c) => <li key={c.id}><code>{c.id}</code> {c.customerVisible ? '' : <span className="tg-badge tg-badge-warn">not customer-visible</span>} {c.text} <span className="text-xs text-gray-500">[{c.limitations.join(', ')}]</span></li>)}</ul>
            </details>
          ) : null}
        </section>
      ) : null}

      <section>
        <h2 className="font-semibold">Recommendation drafts</h2>
        {recs.map((r) => (
          <div key={r.id} className="mt-2 rounded border border-gray-200 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`tg-badge ${r.reviewStatus === 'pending' ? 'tg-badge-warn' : r.reviewStatus === 'approved' || r.reviewStatus === 'sent' ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{r.reviewStatus}</span>
              <span>rev {r.revision}</span><span>hash {r.draftHash.slice(0, 12)}</span><span>created {r.createdAt.toISOString().slice(0, 16)}</span>
              {r.reviewNote ? <span className="tg-badge tg-badge-danger">{r.reviewNote}</span> : null}
            </div>
            <p className="mt-2 text-sm font-medium">Subject: {r.subject}</p>
            <pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 text-sm">{r.bodyText}</pre>
            {r.reviewStatus === 'pending' && r.revision === req.currentRevision ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <ActionButton url={`/api/admin/recommendations/${r.id}/revalidate`} label="Revalidate offers" />
                <ActionButton url={`/api/admin/recommendations/${r.id}/approve`} body={{ expectedRevision: req.currentRevision, draftHash: r.draftHash, note: null }} label="Approve and queue send" variant="primary" confirm="Approve this exact draft for the current revision?" />
              </div>
            ) : null}
          </div>
        ))}
        {!recs.length ? <p className="text-sm text-gray-600">No drafts yet.</p> : null}
      </section>

      <section>
        <h2 className="font-semibold">Outbound send intents</h2>
        <table className="tg-table mt-2">
          <thead><tr><th>Class</th><th>State</th><th>Subject</th><th>Attempts</th><th>Provider id</th><th>Reason</th></tr></thead>
          <tbody>{intents.map((i) => <tr key={i.id}><td>{i.messageClass}</td><td><span className={`tg-badge ${i.state === 'delivered' || i.state === 'provider_accepted' ? 'tg-badge-ok' : i.state === 'blocked' || i.state === 'suppressed' ? 'tg-badge-warn' : 'tg-badge-muted'}`}>{i.state}</span></td><td>{i.subject}</td><td>{i.attempts}</td><td className="text-xs">{i.providerMessageId ?? '—'}</td><td className="text-xs text-gray-600">{i.lastError ?? ''}</td></tr>)}</tbody>
        </table>
      </section>

      <section>
        <h2 className="font-semibold">State history</h2>
        <ul className="mt-1 text-xs text-gray-600">{transitions.map((x) => <li key={x.id}>{x.createdAt.toISOString().slice(0, 19)} · {x.fromState ?? '∅'} → {x.toState} · rev {x.revision} · {x.actor} · {x.reason}</li>)}</ul>
        <p className="mt-2 text-xs text-gray-500">Viewing as {staff.email} ({staff.role}).</p>
      </section>
    </main>
  );
}
