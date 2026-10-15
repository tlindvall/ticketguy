/**
 * Copies real customer threads into the private Braintrust dataset "production-threads" so the eval suite can replay
 * them against new code (evals/production.ts). Run in the Render shell, where DATABASE_URL and BRAINTRUST_API_KEY are set:
 *
 *   pnpm tsx scripts/export-threads.ts            # every conversation with a customer email
 *   pnpm tsx scripts/export-threads.ts --since 2026-10-01 --limit 50
 *
 * Each record is one conversation: the customer's emails in order (text, time, screenshots), what we sent back, and the
 * slice of the catalog the thread touched (venues, teams, events, links, seat zones, listings and their price history),
 * so a replay sees what the customer saw. Records are keyed by conversation id, so re-running updates them in place.
 * Nothing is written to the repo or printed beyond counts: the dataset is private to the Braintrust project.
 */
import { and, asc, eq, gte, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { openDatabase, openMigrationDatabase } from '../src/lib/db';
import * as t from '../src/lib/db/schema';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const since = arg('since') ? new Date(arg('since')!) : new Date(0);
const limit = Number(arg('limit') ?? 500);
const BT = 'https://api.braintrust.dev/v1';
const key = process.env.BRAINTRUST_API_KEY;
if (!key) throw new Error('BRAINTRUST_API_KEY is not set');
const MAX_IMAGE = 4 * 1024 * 1024;

async function bt<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BT}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`braintrust ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const h = url ? await openMigrationDatabase(url) : await openDatabase();
const db = h.db;

const convs = await db
  .select({ id: t.conversations.id, subject: t.conversations.subject, contactId: t.conversations.contactId, createdAt: t.conversations.createdAt })
  .from(t.conversations)
  .where(gte(t.conversations.lastActivityAt, since))
  .orderBy(asc(t.conversations.createdAt))
  .limit(limit);

const records: Array<{ id: string; input: unknown; metadata: Record<string, unknown> }> = [];
for (const conv of convs) {
  const msgs = await db.select().from(t.messages).where(and(eq(t.messages.conversationId, conv.id), eq(t.messages.direction, 'inbound'), ne(t.messages.provider, 'test'))).orderBy(asc(t.messages.receivedAt));
  if (!msgs.length) continue;
  const atts = await db.select().from(t.attachments).where(and(inArray(t.attachments.messageId, msgs.map((m) => m.id)), eq(t.attachments.validationState, 'accepted'), isNotNull(t.attachments.mediaId)));
  const media = atts.length ? await db.select().from(t.mediaObjects).where(inArray(t.mediaObjects.id, atts.map((a) => a.mediaId!))) : [];
  const inbound = msgs.map((m) => ({
    at: m.receivedAt.toISOString(),
    subject: m.subject,
    text: m.sanitizedText ?? '',
    images: atts
      .filter((a) => a.messageId === m.id)
      .map((a) => media.find((x) => x.id === a.mediaId))
      .filter((x): x is NonNullable<typeof x> => !!x && x.mimeType.startsWith('image/') && x.byteLength <= MAX_IMAGE)
      .map((x) => ({ mime: x.mimeType, base64: Buffer.from(x.bytes).toString('base64') })),
  }));
  const [contact] = await db.select({ firstName: t.contacts.firstName, email: t.contacts.emailOriginal }).from(t.contacts).where(eq(t.contacts.id, conv.contactId));

  // The catalog slice: every event the thread's requests resolved, listed, or recommended.
  const reqs = await db.select({ id: t.requests.id, eventId: t.requests.eventId, browseShown: t.requests.browseShown }).from(t.requests).where(eq(t.requests.conversationId, conv.id));
  // What we sent: recommendations and alerts carry the request, not always the conversation.
  const reqIds = reqs.map((r) => r.id);
  const sent = await db
    .select({ at: t.sendIntents.createdAt, cls: t.sendIntents.messageClass, subject: t.sendIntents.subject, text: t.sendIntents.bodyText, state: t.sendIntents.state })
    .from(t.sendIntents)
    .where(reqIds.length ? or(eq(t.sendIntents.conversationId, conv.id), inArray(t.sendIntents.requestId, reqIds)) : eq(t.sendIntents.conversationId, conv.id))
    .orderBy(asc(t.sendIntents.createdAt));
  const chosen = reqs.length ? (await db.select({ ids: t.recommendations.chosenObservationIds }).from(t.recommendations).where(inArray(t.recommendations.requestId, reqs.map((r) => r.id)))).flatMap((r) => r.ids ?? []) : [];
  const recs = chosen.length ? await db.select({ eventId: t.offerObservations.eventId }).from(t.offerObservations).where(inArray(t.offerObservations.id, chosen)) : [];
  const eventIds = [...new Set([...reqs.flatMap((r) => [r.eventId, ...(r.browseShown ?? [])]), ...recs.map((r) => r.eventId)].filter((x): x is string => !!x))];
  const events = eventIds.length ? await db.select().from(t.events).where(inArray(t.events.id, eventIds)) : [];
  const venueIds = [...new Set(events.map((e) => e.venueId).filter(Boolean))] as string[];
  const entityIds = [...new Set(events.flatMap((e) => [e.primaryEntityId, e.opponentEntityId]).filter(Boolean))] as string[];
  const venues = venueIds.length ? await db.select().from(t.venues).where(inArray(t.venues.id, venueIds)) : [];
  const entities = entityIds.length ? await db.select().from(t.entities).where(inArray(t.entities.id, entityIds)) : [];
  const mappings = eventIds.length ? await db.select().from(t.eventSourceMappings).where(inArray(t.eventSourceMappings.eventId, eventIds)) : [];
  const zones = venueIds.length ? await db.select().from(t.venueSeatZones).where(inArray(t.venueSeatZones.venueId, venueIds)) : [];
  const offers = eventIds.length ? await db.select().from(t.offers).where(inArray(t.offers.eventId, eventIds)) : [];
  const lastAt = new Date(inbound[inbound.length - 1]!.at).getTime() + 86_400_000;
  const observations = (eventIds.length ? await db.select().from(t.offerObservations).where(inArray(t.offerObservations.eventId, eventIds)) : [])
    .filter((o) => o.fetchedAt.getTime() <= lastAt)
    .map((o) => ({ ...o, runId: null, checkId: null }));

  records.push({
    id: conv.id,
    input: { conversationId: conv.id, subject: conv.subject, firstName: contact?.firstName ?? null, email: contact?.email ?? null, inbound, sent, world: { venues, entities, events, mappings, zones, offers, observations } },
    metadata: { startedAt: conv.createdAt.toISOString(), emails: inbound.length, images: inbound.reduce((n, m) => n + m.images.length, 0), events: events.length, listings: observations.length },
  });
}

const projects = await bt<{ objects: Array<{ id: string }> }>(`/project?project_name=${encodeURIComponent(process.env.BRAINTRUST_PROJECT ?? 'My Project')}`);
const projectId = projects.objects[0]?.id;
if (!projectId) throw new Error('Braintrust project not found');
const ds = await bt<{ id: string }>('/dataset', { project_id: projectId, name: 'production-threads', description: 'Real customer threads with the catalog slice they touched, for replay (scripts/export-threads.ts).' });
for (let i = 0; i < records.length; i += 20) await bt(`/dataset/${ds.id}/insert`, { events: records.slice(i, i + 20) });
console.log(`exported ${records.length} threads (${records.reduce((n, r) => n + Number(r.metadata.emails), 0)} customer emails) from ${convs.length} conversations to production-threads`);
await h.close();
process.exit(0);
