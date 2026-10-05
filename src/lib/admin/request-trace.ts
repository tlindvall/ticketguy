import { and, asc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import * as t from '@/lib/db/schema';

/**
 * Everything one request touched outside our own code, in the order it happened (live Oct 5: "for each request,
 * which sources did we use? did we use seatdata api? any other apis? any browsing, which urls?"). Staff only: it
 * names models, providers and URLs, never keys, tokens or message bodies.
 */
export type TraceSource = 'ai' | 'ticketmaster' | 'web' | 'seatdata' | 'seller' | 'link' | 'system';
export type TraceStep = {
  at: Date;
  source: TraceSource;
  /** What happened, in a line: "Searched the web (2 searches, 14 pages)". */
  title: string;
  /** Status in a word: ok, none, skipped, error. */
  status: 'ok' | 'none' | 'skipped' | 'error';
  /** Supporting facts, one per line. */
  details: string[];
  urls: string[];
};

export const TRACE_SOURCE_LABEL: Record<TraceSource, string> = {
  ai: 'AI model',
  ticketmaster: 'Ticketmaster Discovery API',
  web: 'Web search',
  seatdata: 'SeatData API',
  seller: 'Seller check',
  link: 'Link sent',
  system: 'Pipeline',
};

const JOB_LABEL: Record<string, string> = {
  extract: 'Read the customer’s email',
  draft: 'Wrote the reply',
  listing_read: 'Read the screenshot',
  web_event_search: 'Searched the web for the event',
};

const SEATDATA_KIND: Record<string, string> = {
  match: 'Matched the event to SeatData',
  request_event: 'Asked SeatData to start tracking the event',
  listings: 'Read current listings',
  listings_compare: 'Read current listings for the reply',
  listings_watch: 'Read current listings for a price watch',
  stats: 'Read price statistics',
  history_search: 'Looked for past events to compare',
  history_stats: 'Read a past event’s prices',
  prioritize: 'Asked SeatData to refresh the event sooner',
  listing_sightings: 'Recorded listing numbers seen',
};

/** Audit actions worth a line in the trace, by what they mean; the rest stay in the raw history. */
const AUDIT_LABEL: Record<string, { source: TraceSource; title: string }> = {
  'web.event_search': { source: 'web', title: 'Searched the web for the event' },
  'web.event_found': { source: 'web', title: 'Found the event on the web' },
  'web.event_search_skipped': { source: 'web', title: 'Skipped the web search' },
  'listing.read_failed': { source: 'ai', title: 'Couldn’t read the screenshot' },
  'listing.image_unreadable': { source: 'ai', title: 'Screenshot unreadable' },
  'listing.link_skipped': { source: 'seller', title: 'Didn’t open the listing link' },
  'market.read_failed': { source: 'seatdata', title: 'Couldn’t read the resale market' },
  'market.trend_assessed': { source: 'seatdata', title: 'Assessed the price trend' },
  'ai.provider_rules_fallback': { source: 'ai', title: 'AI unavailable: read the email with rules instead' },
  'ai.budget_rules_fallback': { source: 'ai', title: 'AI budget reached: read the email with rules instead' },
  'service_policy.would_block': { source: 'system', title: 'Service depth would have blocked a step' },
  'answer.coverage': { source: 'system', title: 'Checked the reply answers every question' },
};

const usd = (micros: number) => `$${(micros / 1e6).toFixed(micros < 10_000 ? 4 : 3)}`;
const httpsOnly = (u: unknown): u is string => typeof u === 'string' && /^https:\/\//.test(u);

export async function requestTrace(db: Db, req: { id: string; conversationId: string; createdAt: Date; updatedAt: Date; eventId: string | null }, opts: { performer?: string | null; eventIds?: string[] } = {}): Promise<TraceStep[]> {
  const steps: TraceStep[] = [];
  // The request's own span, from its first email, with a margin: SeatData and Ticketmaster calls are logged by event or
  // keyword, not request.
  const [first] = await db.select({ at: sql<Date>`min(${t.messages.receivedAt})` }).from(t.messages).where(eq(t.messages.conversationId, req.conversationId));
  const firstAt = first?.at ? new Date(first.at) : req.createdAt;
  const from = new Date(Math.min(req.createdAt.getTime(), firstAt.getTime()) - 60_000);
  const to = new Date(Math.max(req.updatedAt.getTime(), Date.now()) + 60_000);

  // AI calls, from the spend ledger: what each was for, the model, tokens and cost.
  for (const r of await db.select().from(t.usageLedger).where(eq(t.usageLedger.requestId, req.id)).orderBy(asc(t.usageLedger.createdAt))) {
    if (r.kind === 'released') continue;
    const cost = r.actualUsdMicros ?? r.estimatedUsdMicros;
    steps.push({
      at: r.createdAt,
      source: 'ai',
      title: JOB_LABEL[r.jobName ?? ''] ?? (r.jobName ?? 'AI call'),
      status: r.kind === 'settled' ? 'ok' : 'none',
      details: [
        `${r.model ?? 'model unknown'}${r.kind === 'reservation' ? ' (reserved; no result recorded)' : ''}`,
        `${r.inputTokens.toLocaleString('en-US')} tokens in, ${r.outputTokens.toLocaleString('en-US')} out${r.toolCalls ? `, ${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'}` : ''} · ${usd(cost)}${r.actualUsdMicros == null ? ' estimated' : ''}`,
      ],
      urls: [],
    });
  }

  // Ticketmaster Discovery lookups: tagged with the request since Oct 5; earlier ones by keyword inside the span.
  const kw = opts.performer?.trim().toLowerCase() || null;
  const syncs = await db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'catalog.discovery_synced'), gte(t.auditLog.createdAt, from), lte(t.auditLog.createdAt, to), or(sql`${t.auditLog.diff}->>'requestId' = ${req.id}`, kw ? and(eq(t.auditLog.entityId, kw), sql`${t.auditLog.diff}->>'requestId' is null`) : sql`false`)));
  for (const a of syncs) {
    const d = (a.diff ?? {}) as { status?: string; eventsSeen?: number; eventsUpserted?: number; window?: { start?: string; end?: string }; retry?: string };
    const ok = d.status === 'success';
    steps.push({
      at: a.createdAt,
      source: 'ticketmaster',
      title: `Searched Ticketmaster for “${a.entityId}”${d.retry ? ' again, fresh' : ''}`,
      status: d.status === 'skipped_fresh' ? 'skipped' : ok ? ((d.eventsSeen ?? 0) > 0 ? 'ok' : 'none') : 'error',
      details: [
        d.status === 'skipped_fresh' ? 'Recently searched: used what was already on file' : `${d.eventsSeen ?? 0} events returned, ${d.eventsUpserted ?? 0} saved to the catalog`,
        d.window?.start ? `Dates ${d.window.start.slice(0, 10)} to ${(d.window.end ?? '').slice(0, 10)}` : '',
        ok || d.status === 'skipped_fresh' ? '' : `Status: ${d.status ?? 'unknown'}`,
      ].filter(Boolean),
      urls: [],
    });
  }

  // Audit lines on the request itself: web searches with their queries and pages, screenshot and market problems.
  for (const a of await db.select().from(t.auditLog).where(and(eq(t.auditLog.entityKind, 'request'), eq(t.auditLog.entityId, req.id))).orderBy(asc(t.auditLog.createdAt))) {
    const label = AUDIT_LABEL[a.action];
    if (!label) continue;
    const d = (a.diff ?? {}) as Record<string, unknown>;
    if (a.action === 'web.event_search') {
      const found = Array.isArray(d.found) ? (d.found as Array<{ name?: string; date?: string | null; url?: string }>) : [];
      const queries = Array.isArray(d.queries) ? (d.queries as unknown[]).filter((q): q is string => typeof q === 'string') : [];
      steps.push({
        at: a.createdAt,
        source: 'web',
        title: d.error ? 'Web search failed' : `Searched the web (${Number(d.searches ?? 0)} search${Number(d.searches ?? 0) === 1 ? '' : 'es'}, ${Number(d.resultUrls ?? 0)} pages)`,
        status: d.error ? 'error' : found.length ? 'ok' : 'none',
        details: [
          ...queries.map((q) => `Query: ${q}`),
          ...(found.length ? found.map((f) => `Found: ${f.name ?? '?'}${f.date ? ` on ${f.date}` : ''}`) : d.error ? [`Error: ${String(d.error)}`] : ['Nothing that matched was found']),
        ],
        urls: Array.isArray(d.urls) ? (d.urls as unknown[]).filter(httpsOnly) : found.map((f) => f.url).filter(httpsOnly),
      });
      continue;
    }
    if (a.action === 'web.event_found') continue; // the search line above already names what was found
    steps.push({
      at: a.createdAt,
      source: label.source,
      title: label.title,
      status: /fail|unreadable|skipped|fallback|block/.test(a.action) ? (/skipped/.test(a.action) ? 'skipped' : 'error') : 'ok',
      details: Object.entries(d).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').slice(0, 6).map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`),
      urls: [],
    });
  }

  // SeatData API calls for the request's events inside its span (the tracker logs every call, with skips and errors).
  const eventIds = [...new Set([...(opts.eventIds ?? []), ...(req.eventId ? [req.eventId] : [])])];
  if (eventIds.length) {
    for (const f of await db.select().from(t.marketFetches).where(and(inArray(t.marketFetches.eventId, eventIds), gte(t.marketFetches.at, from), lte(t.marketFetches.at, to))).orderBy(asc(t.marketFetches.at))) {
      steps.push({
        at: f.at,
        source: 'seatdata',
        title: SEATDATA_KIND[f.kind] ?? f.kind,
        status: f.status === 'success' ? (f.points > 0 || f.kind !== 'listings' ? 'ok' : 'none') : /skip/.test(f.status) ? 'skipped' : f.status === 'not_found' ? 'none' : 'error',
        details: [`${f.calls} API call${f.calls === 1 ? '' : 's'}${f.points ? ` · ${f.points} rows` : ''} · ${f.status.replace(/_/g, ' ')}`, ...(f.detail ? [f.detail.slice(0, 300)] : [])],
        urls: [],
      });
    }
  }

  // Sellers checked by each research run: which source, the outcome and how many listings came back.
  const runs = await db.select().from(t.researchRuns).where(eq(t.researchRuns.requestId, req.id));
  if (runs.length) {
    const checks = await db.select().from(t.sourceChecks).where(inArray(t.sourceChecks.runId, runs.map((r) => r.id))).orderBy(asc(t.sourceChecks.observedAt));
    const statusOf = (c: (typeof checks)[number]): TraceStep['status'] => (/success|found|ok/.test(c.status) ? (c.resultCount ? 'ok' : 'none') : /skip|unavailable|not_/.test(c.status) ? 'skipped' : 'error');
    for (const run of runs) {
      const mine = checks.filter((c) => c.runId === run.id);
      const test = run.mode === 'fixture' ? ' (test data)' : '';
      for (const c of mine.filter((x) => statusOf(x) !== 'skipped')) {
        steps.push({ at: c.observedAt, source: 'seller', title: `Checked ${c.sourceId}${test}`, status: statusOf(c), details: [`${c.status.replace(/_/g, ' ')} · ${c.resultCount} listing${c.resultCount === 1 ? '' : 's'}${c.reasonCode ? ` · ${c.reasonCode.replace(/_/g, ' ')}` : ''}`, ...c.limitations.slice(0, 3)], urls: [] });
      }
      // Sellers with no automatic access are one line, grouped by why, not a row each.
      const skipped = mine.filter((x) => statusOf(x) === 'skipped');
      if (skipped.length) {
        const byWhy = new Map<string, string[]>();
        for (const c of skipped) byWhy.set((c.reasonCode ?? c.status).replace(/_/g, ' '), [...(byWhy.get((c.reasonCode ?? c.status).replace(/_/g, ' ')) ?? []), c.sourceId]);
        steps.push({ at: skipped[0]!.observedAt, source: 'seller', title: `Sellers not checked automatically (${skipped.length})${test}`, status: 'skipped', details: [...byWhy].map(([why, ids]) => `${why}: ${ids.join(', ')}`), urls: [] });
      }
    }
  }

  // Links we put in the emails, as the customer would follow them.
  for (const l of await db.select().from(t.trackedLinks).where(eq(t.trackedLinks.requestId, req.id)).orderBy(asc(t.trackedLinks.createdAt))) {
    if (!httpsOnly(l.url)) continue;
    steps.push({ at: l.createdAt, source: 'link', title: l.label ?? 'Link in an email', status: 'ok', details: [`${l.purpose}${l.affiliate ? ' · affiliate' : ''}`], urls: [l.url] });
  }

  return steps.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** One line per source: whether it was used at all, for the card's header. */
export function traceSummary(steps: TraceStep[]): Array<{ source: TraceSource; used: boolean; calls: number }> {
  const order: TraceSource[] = ['ai', 'ticketmaster', 'web', 'seatdata', 'seller', 'link'];
  return order.map((source) => {
    const mine = steps.filter((s) => s.source === source && s.status !== 'skipped');
    return { source, used: mine.length > 0, calls: mine.length };
  });
}
