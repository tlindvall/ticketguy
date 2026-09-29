import Link from 'next/link';
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { env } from '@/lib/config/env';
import { JsonForm } from '@/components/JsonForm';
import { formatUsd } from '@/lib/domain/money';
import { nowMs } from '@/lib/util/clock';
import { ago, whenStaff } from '@/lib/admin/labels';
import { SEATDATA_PROVIDER } from '@/lib/market/series';
import { ensureMarketDatasets, marketLicence } from '@/lib/market/tracker';

export const dynamic = 'force-dynamic';

const USE_LABEL: Record<string, string> = {
  tracking: 'Collect and keep market data for events we follow',
  benchmark: 'Compute typical prices from past games',
  advice: 'Let it steer buy / wait advice',
  customer_display: 'Show numbers from it to customers',
};

const TRACK_STATE: Record<string, string> = { pending_match: 'Finding it on SeatData', requested: 'Asked SeatData to add it', active: 'Tracking', unmatched: 'Not on SeatData', ended: 'Event over' };

/**
 * Resale market data (SeatData, DECISION_LOG #44): the licence switches, what is being tracked and what it
 * costs, and whether the buy/wait rule would have been right (shadow advice, scored after the fact).
 */
export default async function Market() {
  const staff = await guardPage();
  const e = env();
  const { db } = await getDb();
  await ensureMarketDatasets(db);
  const lic = await marketLicence(db);
  const now = nowMs();
  const day = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()));
  const [calls] = await db.select({ n: sql<number>`coalesce(sum(${t.marketFetches.calls}), 0)::int` }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), gte(t.marketFetches.at, day)));
  const byState = await db.select({ state: t.trackedEvents.state, n: sql<number>`count(*)::int` }).from(t.trackedEvents).where(eq(t.trackedEvents.provider, SEATDATA_PROVIDER)).groupBy(t.trackedEvents.state);
  const tracked = await db.select({ tr: t.trackedEvents, name: t.events.name, at: t.events.localStartAt }).from(t.trackedEvents).innerJoin(t.events, eq(t.events.id, t.trackedEvents.eventId)).where(eq(t.trackedEvents.provider, SEATDATA_PROVIDER)).orderBy(t.events.localStartAt).limit(60);
  const errors = await db.select().from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), eq(t.marketFetches.status, 'error'))).orderBy(desc(t.marketFetches.at)).limit(5);
  const [history] = await db.select({ events: sql<number>`count(distinct ${t.marketHistory.providerEventId})::int`, points: sql<number>`count(*)::int` }).from(t.marketHistory);
  const [own] = await db.select({ points: sql<number>`count(*)::int` }).from(t.marketSnapshots).where(eq(t.marketSnapshots.sourceIds, sql`'["seatdata"]'::jsonb`));

  const scored = await db.select().from(t.shadowAdvice).where(isNotNull(t.shadowAdvice.scoredAt));
  const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(t.shadowAdvice).where(sql`${t.shadowAdvice.scoredAt} is null`);
  const card = (profile: string) => {
    const rows = scored.filter((s) => s.profile === profile && s.verdict !== 'no_data');
    const waits = rows.filter((r) => r.decision === 'wait');
    const buys = rows.filter((r) => r.decision === 'buy');
    const saved = waits.filter((r) => r.verdict === 'wait_saved');
    const cost = waits.filter((r) => r.verdict === 'wait_cost');
    const regret = buys.filter((r) => r.verdict === 'buy_regret');
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
    const lostSupply = waits.filter((r) => r.activeListings && r.outcomeActiveListings !== null && r.outcomeActiveListings! < r.activeListings * 0.75).length;
    return { total: rows.length, waits: waits.length, saved: saved.length, cost: cost.length, medianSaved: median(saved.map((r) => r.deltaCents!)), medianCost: median(cost.map((r) => -r.deltaCents!)), buys: buys.length, regret: regret.length, medianRegret: median(regret.map((r) => r.deltaCents!)), lostSupply };
  };
  const cards = [{ profile: 'single_flexible', label: 'One ticket, flexible' }, { profile: 'pair_flexible', label: 'Two tickets together, flexible' }].map((c) => ({ ...c, ...card(c.profile) }));
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

  return (
    <main className="space-y-10">
      <header>
        <h1 className="text-2xl font-bold">Resale market</h1>
        <p className="mt-1 text-sm text-gray-600">SeatData market statistics for the events customers ask about: the cheapest and median listed prices (before fees) for one ticket and for two or more, by seating area, and how many listings are up. It is evidence for buy / wait advice, never a ticket to buy.</p>
      </header>

      <section className="rounded-lg border border-gray-200 p-4">
        <h2 className="text-lg font-semibold">Licence</h2>
        <p className="mt-1 text-sm">
          Status <span className={`tg-badge ${lic.status === 'approved' ? 'tg-badge-ok' : 'tg-badge-warn'}`}>{lic.status}</span> · API key {e.SEATDATA_API_KEY ? <span className="tg-badge tg-badge-ok">set</span> : <span className="tg-badge tg-badge-warn">not set</span>} · calls today {calls?.n ?? 0} of {e.SEATDATA_DAILY_CALL_LIMIT} (about ${((calls?.n ?? 0) * 0.04).toFixed(2)} at SeatData’s pay-as-you-go $0.04 a request; searches may be free)
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          {Object.entries(USE_LABEL).map(([k, label]) => (
            <li key={k}>{lic.allows(k as never) ? '✓' : '✗'} {label}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-gray-600">
          SeatData&rsquo;s standard licence restricts redistributing its data. Collecting and using it internally is the first switch; letting it steer advice and showing its numbers in emails each need SeatData&rsquo;s written OK for exactly that use. Record the reference (email date, who, what was allowed) before approving.
        </p>
        {staff.role === 'admin' ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">Change licence</summary>
            <div className="mt-2">
              <JsonForm
                url="/api/admin/market-licence"
                submitLabel="Save licence"
                fields={[
                  { name: 'status', label: 'Status', type: 'select', required: true, defaultValue: lic.status === 'missing' ? 'quarantined' : lic.status, options: [{ value: 'quarantined', label: 'Quarantined (nothing runs)' }, { value: 'approved', label: 'Approved for the uses ticked below' }, { value: 'revoked', label: 'Revoked' }] },
                  { name: 'tracking', label: USE_LABEL.tracking!, type: 'checkbox', defaultValue: lic.uses.includes('tracking') },
                  { name: 'benchmark', label: USE_LABEL.benchmark!, type: 'checkbox', defaultValue: lic.uses.includes('benchmark') },
                  { name: 'advice', label: USE_LABEL.advice!, type: 'checkbox', defaultValue: lic.uses.includes('advice') },
                  { name: 'customerDisplay', label: USE_LABEL.customer_display!, type: 'checkbox', defaultValue: lic.uses.includes('customer_display') },
                  { name: 'licenseReference', label: 'What allows it (licence version, SeatData email date and sender, exact uses granted)', type: 'textarea', defaultValue: lic.row?.licenseReference ?? '' },
                  { name: 'rawRetentionUntil', label: 'Keep data until (blank = no end date in the licence)', type: 'datetime' },
                ]}
              />
            </div>
          </details>
        ) : <p className="mt-2 text-sm text-gray-500">Admin role required to change the licence.</p>}
      </section>

      <section>
        <h2 className="text-lg font-semibold">What we follow</h2>
        <p className="mt-1 text-sm text-gray-600">
          Every upcoming event a customer asks about{e.MARKET_TRACK_ENTITIES.length ? `, and every game of: ${e.MARKET_TRACK_ENTITIES.join(', ')}` : ''}. One check per event serves every customer following it; checks run daily beyond a week, twice a day in the last week and every 6 hours in the last two days; a customer's request refreshes its event on the spot. Each check is a paid SeatData request.
          {' '}{byState.map((s) => `${TRACK_STATE[s.state] ?? s.state}: ${s.n}`).join(' · ') || 'Nothing yet.'}
        </p>
        <p className="mt-1 text-sm text-gray-600">Our own history: {own?.points ?? 0} market points on tracked events · {history?.events ?? 0} past comparable games ({history?.points ?? 0} points).</p>
        {tracked.length ? (
          <table className="tg-table mt-3">
            <thead><tr><th>Event</th><th>Status</th><th>Latest data</th><th>Next check</th><th>Why</th></tr></thead>
            <tbody>{tracked.map(({ tr, name, at }) => (
              <tr key={tr.id}>
                <td>{name}<div className="text-xs text-gray-500">{whenStaff(at)}</div></td>
                <td>{TRACK_STATE[tr.state] ?? tr.state}{tr.lastError ? <div className="text-xs text-rose-700">{tr.lastError}</div> : null}</td>
                <td>{tr.lastObservedAt ? ago(tr.lastObservedAt.getTime(), now) : '—'}</td>
                <td>{tr.state === 'active' || tr.state === 'pending_match' || tr.state === 'requested' ? whenStaff(tr.nextPollAt) : '—'}</td>
                <td className="text-xs">{tr.reasons.join(', ')}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
        {errors.length ? <p className="mt-2 text-xs text-rose-700">Recent errors: {errors.map((x) => `${whenStaff(x.at)} ${x.kind} ${x.detail ?? ''}`).join(' · ')}</p> : null}
      </section>

      <section>
        <h2 className="text-lg font-semibold">Would &ldquo;wait&rdquo; have been right?</h2>
        <p className="mt-1 text-sm text-gray-600">
          Twice a day for every tracked event, the engine decides what it would tell a flexible buyer from market data alone — <strong>wait</strong> when prices for that group size are falling and listings are holding up, otherwise <strong>buy</strong> — and 24 hours later checks what the cheapest listed price did. Nothing here is sent to anyone. Groups of three or more are not scored: the data has no price for that many seats together. {pending?.n ?? 0} decisions still waiting for their 24 hours.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {cards.map((c) => (
            <div key={c.profile} className="rounded-lg border border-gray-200 p-3 text-sm">
              <h3 className="font-semibold">{c.label}</h3>
              <p className="mt-1 text-gray-600">{c.total} scored decisions</p>
              <p className="mt-2"><strong>Wait</strong> {c.waits}× — price was lower 24h later {pct(c.saved, c.waits)}{c.medianSaved !== null ? ` (median ${formatUsd(c.medianSaved)} a ticket)` : ''}; higher {pct(c.cost, c.waits)}{c.medianCost !== null ? ` (median ${formatUsd(c.medianCost)})` : ''}; listings fell by a quarter or more {c.lostSupply}×.</p>
              <p className="mt-1"><strong>Buy</strong> {c.buys}× — price was lower 24h later (waiting would have paid) {pct(c.regret, c.buys)}{c.medianRegret !== null ? ` (median ${formatUsd(c.medianRegret)})` : ''}.</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500">Prices are cheapest listed prices before fees. A lower price later is not proof a specific ticket was cheaper; it is the market floor. <Link className="underline" href="/admin/watches">Price watches</Link> use verified listings instead, once a seller source is connected.</p>
      </section>
    </main>
  );
}
