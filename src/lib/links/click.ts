import { desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { checkFreshness } from '@/lib/domain/freshness';
import { eventChangedSince } from '@/lib/domain/event-lifecycle';

type Link = typeof t.trackedLinks.$inferSelect;

/** Why a buy link's advice can't be stood behind at click time; each has its own explanation on the page. */
export type RecheckReason = 'unbound' | 'advice_missing' | 'advice_withdrawn' | 'advice_superseded' | 'other_event' | 'event_cancelled' | 'event_postponed' | 'event_rescheduled' | 'event_started' | 'event_missing' | 'event_occurrence_unrecorded' | 'price_stale';

export type LinkDecision =
  | { go: true; url: string; legacy: boolean }
  | { go: false; url: string; reason: RecheckReason; eventLabel: string | null; checkedAt: Date | null; timeZone: string | null };

/**
 * Whether a click goes straight to the stored URL (R2-LINK-STALE-01, R2-LINK-CONTEXT-01). Reference links (an
 * event page, an artist, the official sale) always do. A buy link does only while its advice still stands: the
 * advice exists and wasn't withdrawn or replaced by a newer request revision, the request is still for the event
 * the link was made for, that event is still as the advice found it, and the quoted price is inside its freshness
 * window. Otherwise the click gets a page that says why, with the seller's current page offered as that, never as
 * the old quote. A 'legacy' link (stored before purposes were recorded) redirects as it always did: its purpose is
 * unknown, and it says so in the click record.
 */
export async function linkDecision(db: DbOrTx, link: Link, now: Date): Promise<LinkDecision> {
  if (link.purpose !== 'buy') return { go: true, url: link.url, legacy: link.purpose === 'legacy' };
  const [row] = link.eventId ? await db.select({ e: t.events, v: t.venues }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(eq(t.events.id, link.eventId)) : [];
  const timeZone = row?.v.timezone ?? null;
  const eventLabel = row ? `${row.e.name} at ${row.v.name}, ${new Intl.DateTimeFormat('en-US', { timeZone: row.v.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(row.e.localStartAt)}` : null;
  const stop = (reason: RecheckReason, checkedAt: Date | null = null): LinkDecision => ({ go: false, url: link.url, reason, eventLabel, checkedAt, timeZone });
  if (!link.adviceRunId) return stop('unbound');
  const [rec] = await db.select().from(t.recommendations).where(eq(t.recommendations.adviceRunId, link.adviceRunId)).orderBy(desc(t.recommendations.createdAt)).limit(1);
  if (!rec) return stop('advice_missing');
  if (rec.reviewStatus === 'invalidated' || rec.reviewStatus === 'rejected') return stop('advice_withdrawn');
  const [req] = await db.select({ revision: t.requests.currentRevision, eventId: t.requests.eventId }).from(t.requests).where(eq(t.requests.id, link.requestId));
  if (!req || req.revision > rec.revision) return stop('advice_superseded');
  if (!link.eventId || req.eventId !== link.eventId) return stop('other_event');
  const [run] = await db.select({ packet: t.adviceRuns.packet }).from(t.adviceRuns).where(eq(t.adviceRuns.id, link.adviceRunId));
  const changed = eventChangedSince(row?.e, now, (run?.packet as { eventStartAt?: string | null } | undefined)?.eventStartAt ?? null);
  if (changed) return stop(changed as RecheckReason);
  const obs = rec.chosenObservationIds.length ? await db.select().from(t.offerObservations).where(inArray(t.offerObservations.id, rec.chosenObservationIds)) : [];
  const checkedAt = obs.length ? new Date(Math.min(...obs.map((o) => Math.min(o.fetchedAt.getTime(), o.sourceAsOf?.getTime() ?? Infinity)))) : null;
  if (!obs.length || obs.some((o) => !checkFreshness({ fetchedAt: o.fetchedAt, sourceAsOf: o.sourceAsOf, eventStartAt: row!.e.localStartAt, now }).fresh)) return stop('price_stale', checkedAt);
  return { go: true, url: link.url, legacy: false };
}

const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** What the page says for each reason: the first sentence is the answer, the rest what to do about it. */
export function recheckCopy(d: Extract<LinkDecision, { go: false }>): { title: string; body: string } {
  const what = d.eventLabel ? ` for ${d.eventLabel}` : '';
  const when = d.checkedAt && d.timeZone ? new Intl.DateTimeFormat('en-US', { timeZone: d.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d.checkedAt) : null;
  switch (d.reason) {
    case 'price_stale':
      return { title: 'Check the price before you buy', body: `The price I quoted${what} was checked ${when ? `on ${when}` : 'a while ago'}. Ticket prices move, so it may not be there at that price now. Reply to my email and I’ll check it again.` };
    case 'event_cancelled':
      return { title: 'This event has been cancelled', body: `The event${what} is listed as cancelled, so my advice on it no longer applies. Don’t buy on it; reply to my email if you’d like me to look for something else.` };
    case 'event_postponed':
      return { title: 'This event has been postponed', body: `The event${what} is listed as postponed, so my advice on it no longer applies. Reply to my email and I’ll check it again once there’s a new date.` };
    case 'event_rescheduled':
      return { title: 'This event has moved', body: `The event${what} has a new date or time since I checked, so my advice on it no longer applies. Reply to my email and I’ll check it again.` };
    case 'event_started':
      return { title: 'This event has started', body: `The event${what} has already started, so my advice on it no longer applies.` };
    case 'other_event':
      return { title: 'This link is for a different event', body: `This link was for an event${what} that’s no longer the one in your request. Reply to my latest email and I’ll check the one you want.` };
    case 'advice_superseded':
      return { title: 'This advice has been replaced', body: `You’ve changed the request since I sent this${what}, so the advice in that email no longer applies. My latest email has the current answer.` };
    default:
      return { title: 'This advice needs a fresh check', body: `I can’t stand behind the advice this link came with${what} any more. Reply to my email and I’ll check it again.` };
  }
}

/** The page a stale or changed buy link shows: why, and the seller's current page, labelled as that. */
export function recheckPage(d: Extract<LinkDecision, { go: false }>, currentHref: string): string {
  const { title, body } = recheckCopy(d);
  const current = d.reason === 'event_started' ? '' : `<p><a href="${esc(currentHref)}" rel="noreferrer">Go to the seller’s current page</a> (its prices and seats today, not the ones I quoted)</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="margin:0;padding:24px 16px;font:15px/1.6 Arial,sans-serif;color:#142438;background:#ffffff;"><main style="max-width:560px;margin:0 auto;"><h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;">${esc(title)}</h1><p>${esc(body)}</p>${current}<p style="font-size:12px;color:#5b6675;">Ticket Guy</p></main></body></html>`;
}
