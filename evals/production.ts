/**
 * Real customer threads, replayed. scripts/export-threads.ts copies each production conversation (the customer's
 * emails with their screenshots, what we sent, and the catalog slice it touched) into the private Braintrust dataset
 * "production-threads"; evals/export-threads-from-braintrust.ts moves that dataset, once, into an encrypted file
 * (evals/threads-store.ts) kept as the workflow artifact "production-threads", so eval runs never call Braintrust.
 * Here each record becomes a Scenario: the same emails at the same times, against that catalog slice and the
 * listings as they were, so new code answers the same customer with the same market.
 *
 * Nothing about these threads is known in advance, so they carry no expectations: the general checks (grounding,
 * answered the question, only what was asked, one email per message, coherence) do the judging.
 * The threads are private and the repo is public: never copy their content into the repo, a log or eval-results.json
 * (evals/results.ts keeps only their id and failing steps).
 *
 * Not replayed yet: SeatData market data (market_snapshots / listing sightings), which is where production prices and
 * picks come from. A replay answers from the recorded listings (offer_observations) only, so it tests understanding,
 * clarifying and event resolution on real wording, not pricing; pricing is covered by the eval world.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getTableColumns, inArray } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as t from '@/lib/db/schema';
import type { Offer } from '@/lib/domain/types';
import { FX } from '@/lib/fixtures';
import type { Scenario } from './harness';
import { openThreads, threadsKey } from './threads-store';

type Row = Record<string, unknown>;
export type Record_ = {
  conversationId: string;
  subject: string | null;
  inbound: Array<{ at: string; subject: string | null; text: string; images: Array<{ mime: string; base64: string }> }>;
  sent: Array<{ at: string; cls: string; subject: string; text: string; state: string }>;
  world: { venues: Row[]; entities: Row[]; events: Row[]; mappings: Row[]; zones: Row[]; offers: Row[]; observations: Row[] };
};

/** Every exported thread, newest last. Empty (with a note) when there is no file or no key: the suite runs without them. */
export function loadProductionThreads(): Record_[] {
  const path = process.env.EVAL_THREADS_FILE ?? '.eval-data/production-threads.enc';
  if (!existsSync(path)) { console.warn(`production threads: no ${path} (the workflow downloads the production-threads artifact), skipping`); return []; }
  if (!process.env.EVAL_THREADS_KEY) { console.warn('production threads: no EVAL_THREADS_KEY, skipping'); return []; }
  const out = openThreads<Record_>(readFileSync(path), threadsKey(process.env.EVAL_THREADS_KEY)).filter((x) => x?.inbound?.length);
  return out.sort((a, b) => a.inbound[0]!.at.localeCompare(b.inbound[0]!.at));
}

/** JSON turned timestamps into strings; put Dates back for the table's timestamp columns. */
function revive(table: PgTable, rows: Row[]): Row[] {
  const ts = Object.entries(getTableColumns(table)).filter(([, c]) => c.columnType === 'PgTimestamp').map(([k]) => k);
  return rows.map((r) => { const o = { ...r }; for (const k of ts) if (typeof o[k] === 'string') o[k] = new Date(o[k] as string); return o; });
}

/** One replayable thread. Listing links become example.invalid stand-ins so nothing points at a live checkout. */
export function productionScenario(r: Record_): Scenario {
  const w = r.world;
  // The latest observation of each listing at each quantity: what a source would have answered.
  const latest = new Map<string, Row>();
  for (const o of w.observations) {
    const k = `${o.offerId}:${o.quantity}`;
    const prev = latest.get(k);
    if (!prev || String(o.fetchedAt) > String(prev.fetchedAt)) latest.set(k, o);
  }
  const offers: Record<string, Offer[]> = {};
  for (const o of latest.values()) {
    const id = `prod-${String(o.offerId).slice(0, 8)}-${o.quantity}`;
    (offers[String(o.eventId)] ??= []).push({
      id, sourceId: FX.source, providerListingId: id, eventId: String(o.eventId), observedAt: String(o.fetchedAt), providerUpdatedAt: null, expiresAt: null,
      quantity: Number(o.quantity), currency: 'USD',
      baseTotalCents: (o.baseTotalCents as number | null) ?? null, mandatoryFeeTotalCents: (o.mandatoryFeeTotalCents as number | null) ?? null, taxTotalCents: (o.taxTotalCents as number | null) ?? null,
      deliveryTotalCents: (o.deliveryTotalCents as number | null) ?? null, payableTotalCents: (o.payableTotalCents as number | null) ?? null,
      priceCompleteness: o.priceCompleteness as Offer['priceCompleteness'], section: (o.section as string | null) ?? null, row: (o.rowLabel as string | null) ?? null,
      seatNumbers: (o.seatNumbers as string[] | null) ?? null, seatsTogether: (o.seatsTogether as boolean | null) ?? null, admissionType: o.admissionType as Offer['admissionType'],
      restrictions: (o.restrictions as string[]) ?? [], deliveryMethod: (o.deliveryMethod as string | null) ?? null, expectedDeliveryAt: o.expectedDeliveryAt ? new Date(String(o.expectedDeliveryAt)).toISOString() : null,
      directPurchaseUrl: `https://example.invalid/fixture/${id}`, affiliateUrl: null, affiliateCommissionBps: 0, evidenceId: `prod-ev-${id}`,
      collectionMode: 'fixture', availability: (o.availability as Offer['availability']) ?? 'unknown', seatClass: null,
    });
  }
  const grounded = new Set<number>();
  for (const o of w.observations) for (const v of [o.payableTotalCents, o.baseTotalCents, o.mandatoryFeeTotalCents] as Array<number | null>) if (v != null) { grounded.add(v); grounded.add(Math.round(v / Number(o.quantity))); }

  // Links that are grounded for this thread: anything in the recorded catalog (official pages, mappings) or sent by the customer.
  const links = new Set<string>();
  const urlRe = /https?:\/\/[^\s<>"')\]]+/g;
  const scan = (v: unknown): void => { if (typeof v === 'string') for (const m of v.matchAll(urlRe)) links.add(m[0].replace(/[.,;:]+$/, '')); else if (v && typeof v === 'object') for (const x of Object.values(v)) scan(x); };
  scan([w.venues, w.entities, w.events, w.mappings]);
  for (const m of r.inbound) scan(m.text);

  return {
    id: `prod/${r.conversationId.slice(0, 8)}`,
    capability: 'production-replay',
    tags: ['production'],
    world: 'none',
    now: r.inbound[0]!.at,
    offers,
    groundedCents: [...grounded],
    groundedLinks: [...links],
    steps: r.inbound.map((m, i) => ({ text: m.text || '(no text)', at: m.at, subject: m.subject ?? (i ? 'Re: Tickets' : 'Tickets'), images: m.images })),
    seed: async (db) => {
      // Teams the fixture catalog already has (same slug) keep its id, so the slice's events point at them.
      const slugs = w.entities.map((e) => String(e.slug));
      const have = slugs.length ? await db.select({ id: t.entities.id, slug: t.entities.slug }).from(t.entities).where(inArray(t.entities.slug, slugs)) : [];
      const remap = new Map<string, string>();
      for (const e of w.entities) { const hit = have.find((x) => x.slug === e.slug); if (hit) remap.set(String(e.id), hit.id); }
      const venueIds = new Set(w.venues.map((v) => String(v.id)));
      const ins = async (table: PgTable, rows: Row[]) => { if (rows.length) await db.insert(table).values(revive(table, rows) as never).onConflictDoNothing(); };
      await ins(t.venues, w.venues);
      await ins(t.entities, w.entities.filter((e) => !remap.has(String(e.id))).map((e) => ({ ...e, homeVenueId: e.homeVenueId && venueIds.has(String(e.homeVenueId)) ? e.homeVenueId : null })));
      const m = (id: unknown) => (id == null ? null : remap.get(String(id)) ?? id);
      await ins(t.events, w.events.map((e) => ({ ...e, primaryEntityId: m(e.primaryEntityId), opponentEntityId: m(e.opponentEntityId) })));
      await ins(t.eventSourceMappings, w.mappings);
      await ins(t.venueSeatZones, w.zones);
      await ins(t.offers, w.offers.map((o) => ({ ...o, directPurchaseUrl: `https://example.invalid/fixture/prod-${String(o.id).slice(0, 8)}`, affiliateUrl: null })));
      await ins(t.offerObservations, w.observations);
    },
  };
}

/** What we actually sent at the time, in order (Braintrust metadata when a run is sent there). */
export const originalReplies = (r: Record_) => r.sent.map((s) => ({ at: s.at, cls: s.cls, state: s.state, text: s.text.slice(0, 4000) }));
