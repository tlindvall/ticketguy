import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { getConcierge } from '@/lib/services';
import { inngest, outboxKick } from '@/inngest/client';
import { runOutboxBatch } from '@/inngest/functions';
import { buildTestInbound, isTestConversation, TEST_PROVIDER } from '@/lib/email/test-mode';
import { reasonText, sendClassLabel, stateInfo } from '@/lib/admin/labels';
import { audit } from '@/lib/util/audit';
import { questionsAsked, suppliedOffers, type IngestOutcome } from '@/lib/intake/pipeline';
import { resolveLinks } from '@/lib/domain/link-resolution';

/** What the admin form and the agent API both accept. Attachments arrive base64-encoded (images, as a customer would attach). */
export const TestMessageBody = z.object({
  from: z.string().trim().email().nullish(),
  name: z.string().trim().max(100).nullish(),
  subject: z.string().max(200).nullish(),
  text: z.string().min(1).max(20_000),
  replyToRequestId: z.string().uuid().nullish(),
  quote: z.boolean().default(true),
  attachments: z.array(z.object({ filename: z.string().max(200).nullish(), contentType: z.string().max(100).nullish(), base64: z.string().min(1) })).max(3).default([]),
});
export type TestMessage = z.infer<typeof TestMessageBody>;

/** Base64 image attachments are ~4/3 their size; three at the 10 MB image limit fit. */
export const TEST_MESSAGE_MAX_BYTES = 42 * 1024 * 1024;

export type InjectResult = { ok: true; outcome: IngestOutcome; requestId: string | null } | { ok: false; error: string; status: number };

/**
 * Writes in as a test customer, then hands the work to the dispatcher exactly as the Resend webhook does.
 * Without Inngest (local development) the outbox is drained inline instead, like the simulator.
 */
export async function injectTestMessage(body: TestMessage, actor: string): Promise<InjectResult> {
  const e = env();
  const { db } = await getDb();
  const built = await buildTestInbound(
    db,
    e,
    {
      from: body.from,
      fromName: body.name,
      subject: body.subject,
      text: body.text,
      replyToRequestId: body.replyToRequestId,
      quote: body.quote,
      attachments: body.attachments.map((a) => ({ filename: a.filename ?? null, contentType: a.contentType ?? null, bytes: new Uint8Array(Buffer.from(a.base64, 'base64')) })),
    },
    new Date(),
  );
  if (!built.ok) return { ok: false, error: built.error, status: built.error === 'test_mode_off' ? 409 : built.error === 'request_not_found' ? 404 : 422 };
  const c = await getConcierge();
  const outcome = await c.ingestInbound(built.message);
  await audit(db, { actor, action: 'test_mode.inbound_injected', entityKind: 'message', entityId: outcome.messageId, diff: { outcome: outcome.kind, reply: !!body.replyToRequestId, attachments: body.attachments.length } });
  if (e.INNGEST_EVENT_KEY) {
    // Best-effort immediate kick; the per-minute dispatcher covers a lost publish.
    inngest.send(outboxKick.create({ reason: 'test_mode.inbound' })).catch(() => undefined);
  } else {
    for (let i = 0; i < 8; i++) {
      const r = await runOutboxBatch(50);
      if (r.processed + r.failed === 0) break;
    }
  }
  return { ok: true, outcome, requestId: outcome.kind === 'queued' ? outcome.requestId : null };
}

const WORKING = ['received', 'interpreting', 'resolving_event', 'researching'];
const IN_FLIGHT_SENDS = ['queued', 'claimed'];

/**
 * A test request as its customer would have seen it: every email in the thread, in order, including the ones
 * test mode recorded instead of sending, plus anything not sent and why. `settled` is false while the system is
 * still working on it, so an agent polls until it is true. Test conversations only.
 */
export async function testTranscript(requestId: string): Promise<Record<string, unknown> | null> {
  const e = env();
  const { db } = await getDb();
  const [req] = await db.select().from(t.requests).where(eq(t.requests.id, requestId));
  if (!req || !(await isTestConversation(db, req.conversationId))) return null;
  const messages = await db.select().from(t.messages).where(eq(t.messages.conversationId, req.conversationId)).orderBy(asc(t.messages.receivedAt), asc(t.messages.createdAt));
  const intents = await db.select().from(t.sendIntents).where(eq(t.sendIntents.conversationId, req.conversationId)).orderBy(asc(t.sendIntents.createdAt));
  const [last] = await db.select({ reason: t.requestTransitions.reason }).from(t.requestTransitions).where(eq(t.requestTransitions.requestId, req.id)).orderBy(desc(t.requestTransitions.createdAt)).limit(1);
  const pendingOutbox = await db.select({ id: t.outboxEvents.id }).from(t.outboxEvents).where(and(inArray(t.outboxEvents.entityId, [req.id, ...messages.map((m) => m.id), ...intents.map((i) => i.id)]), inArray(t.outboxEvents.state, ['pending', 'leased']))).limit(1);
  const [draft] = await db.select().from(t.recommendations).where(and(eq(t.recommendations.requestId, req.id), eq(t.recommendations.reviewStatus, 'pending'), eq(t.recommendations.revision, req.currentRevision))).limit(1);
  const classOf = new Map(intents.filter((i) => i.providerMessageId).map((i) => [i.providerMessageId!, i.messageClass]));
  const recorded = new Set(messages.map((m) => m.providerEmailId).filter(Boolean));
  const qa = await qaTrace(db, req, messages, intents);
  const s = stateInfo(req.state);
  const settled = !WORKING.includes(req.state) && !intents.some((i) => IN_FLIGHT_SENDS.includes(i.state)) && pendingOutbox.length === 0;
  return {
    requestId: req.id,
    conversationId: req.conversationId,
    state: req.state,
    stateLabel: s.label,
    next: s.next,
    why: reasonText(last?.reason, req.state) || null,
    revision: req.currentRevision,
    settled,
    adminUrl: `${e.APP_URL.replace(/\/$/, '')}/admin/requests/${req.id}`,
    messages: messages.map((m) => ({
      direction: m.direction === 'outbound' ? 'from_ticket_guy' : 'from_customer',
      at: m.receivedAt.toISOString(),
      from: m.fromAddress,
      to: m.toAddresses,
      subject: m.subject,
      kind: m.direction === 'outbound' ? sendClassLabel(classOf.get(m.providerEmailId ?? '') ?? '') || null : null,
      // Outbound here was recorded by test mode (or, before test mode, really sent); inbound is what the customer wrote, quotes stripped.
      recordedByTestMode: m.direction === 'outbound' ? m.provider === TEST_PROVIDER : undefined,
      text: m.sanitizedText ?? '',
    })),
    notSent: intents
      .filter((i) => !i.providerMessageId || !recorded.has(i.providerMessageId))
      .map((i) => ({ at: i.createdAt.toISOString(), kind: sendClassLabel(i.messageClass), state: i.state, reasons: i.lastError ? i.lastError.split(',') : [], subject: i.subject, text: i.bodyText })),
    draftAwaitingApproval: draft ? { subject: draft.subject, text: draft.bodyText } : null,
    ...qa,
  };
}

/** Listing fields safe to hand back: what a customer could read off a listing, never an image, URL or barcode. */
// The rows a results page showed, tax basis, doors and show times and admission type are what QA checks a screenshot
// answer against (LAUNCH-10); they're what the page showed, nothing personal.
const SAFE_LISTING_FIELDS = ['seller', 'eventName', 'eventDate', 'eventTime', 'venue', 'city', 'quantity', 'priceText', 'perTicketCents', 'wholePartyCents', 'priceBasis', 'feeBasis', 'section', 'row', 'seatNumbers', 'seatsTogether', 'restrictions', 'restrictionCodes', 'deliveryText', 'deliveryBy', 'includedBenefits', 'offers', 'beforeTaxes', 'doorsTime', 'showTime', 'admission', 'listingType', 'chosenFor'] as const;

/** Audits a trace shows in full: link lookups, the trend read, market and AI fallbacks. Diffs carry no message text. */
const TRACE_AUDITS = ['listing.link_matched', 'listing.link_unmatched', 'listing.link_skipped', 'market.trend_assessed', 'market.read_failed', 'ai.budget_rules_fallback', 'ai.provider_rules_fallback', 'answer.coverage'];

/**
 * What a QA replay needs to tell a real fix from a warmer sentence (TGQA-R6): the build that answered, how the
 * request moved and what it understood at each revision, the contact's stored stops and deletion status, the
 * offer facts we kept and where each came from, and every email we generated as text and HTML. Test
 * conversations only (the caller checks); no credentials, attachment URLs, signed links or email lookups.
 */
export async function qaTrace(db: Awaited<ReturnType<typeof getDb>>['db'], req: typeof t.requests.$inferSelect, messages: (typeof t.messages.$inferSelect)[], intents: (typeof t.sendIntents.$inferSelect)[]) {
  const transitions = await db.select().from(t.requestTransitions).where(eq(t.requestTransitions.requestId, req.id)).orderBy(asc(t.requestTransitions.createdAt));
  const versions = await db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, req.id)).orderBy(asc(t.requestVersions.revision));
  const [contact] = await db.select({ id: t.contacts.id, emailLookup: t.contacts.emailLookup }).from(t.contacts).where(eq(t.contacts.id, req.contactId));
  const stops = contact ? await db.select({ scope: t.suppressions.scope, reason: t.suppressions.reason, createdAt: t.suppressions.createdAt }).from(t.suppressions).where(eq(t.suppressions.emailLookup, contact.emailLookup)) : [];
  const [deletion] = contact ? await db.select().from(t.deletionLedger).where(eq(t.deletionLedger.contactId, contact.id)).orderBy(desc(t.deletionLedger.requestedAt)).limit(1) : [];
  const evidence = await db.select().from(t.listingEvidence).where(eq(t.listingEvidence.requestId, req.id)).orderBy(asc(t.listingEvidence.observedAt));
  const inbound = messages.filter((m) => m.direction === 'inbound');
  const latest = inbound[inbound.length - 1];
  const [venue] = req.eventId ? await db.select({ tz: t.venues.timezone }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(eq(t.events.id, req.eventId)) : [];
  const parsed = latest ? suppliedOffers(latest.sanitizedText ?? '', inbound.map((m) => m.sanitizedText ?? ''), venue?.tz ?? 'America/New_York') : null;
  // What the trace needs to say why the answer followed (LAUNCH-10): per-turn model calls and fallbacks, which source
  // reads ran or were skipped and why, what became of each link, and the latest trend read with its clocks.
  const audits = await db.select({ action: t.auditLog.action, revision: t.auditLog.revision, diff: t.auditLog.diff, at: t.auditLog.createdAt }).from(t.auditLog).where(and(eq(t.auditLog.entityId, req.id), inArray(t.auditLog.action, TRACE_AUDITS))).orderBy(asc(t.auditLog.createdAt));
  const usage = await db.select().from(t.usageLedger).where(eq(t.usageLedger.requestId, req.id)).orderBy(asc(t.usageLedger.createdAt));
  const first = messages[0]?.receivedAt ?? req.createdAt;
  const reads = req.eventId ? await db.select({ kind: t.marketFetches.kind, status: t.marketFetches.status, calls: t.marketFetches.calls, detail: t.marketFetches.detail, at: t.marketFetches.at }).from(t.marketFetches).where(and(eq(t.marketFetches.eventId, req.eventId), gte(t.marketFetches.at, first))).orderBy(asc(t.marketFetches.at)) : [];
  const links = await db.select({ url: t.trackedLinks.url, label: t.trackedLinks.label, purpose: t.trackedLinks.purpose, affiliate: t.trackedLinks.affiliate }).from(t.trackedLinks).where(eq(t.trackedLinks.requestId, req.id));
  const latestBrief = (versions[versions.length - 1]?.brief ?? {}) as { submittedUrls?: string[] };
  const trend = [...audits].reverse().find((x) => x.action === 'market.trend_assessed');
  return {
    build: {
      commit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
      branch: process.env.RENDER_GIT_BRANCH ?? null,
      appMode: env().APP_MODE,
      extractionProvider: env().EXTRACTION_PROVIDER,
    },
    trace: {
      transitions: transitions.map((x) => ({ at: x.createdAt.toISOString(), from: x.fromState, to: x.toState, revision: x.revision, actor: x.actor, reason: x.reason })),
      versions: versions.map((v) => {
        const b = v.brief as Record<string, unknown>;
        return { revision: v.revision, at: v.createdAt.toISOString(), createdBy: v.createdBy, intent: b.intent ?? null, unresolved: v.unresolvedFields, understood: { performerOrTeam: b.performerOrTeam ?? null, city: b.city ?? null, dateExpression: b.dateExpression ?? null, resolvedLocalDate: b.resolvedLocalDate ?? null, quantity: b.quantity ?? null, budgetCents: b.budgetCents ?? null, budgetBasis: b.budgetBasis ?? null, togetherRequired: b.togetherRequired ?? null, accessibility: !!b.accessibilityNeeds, ambiguities: b.ambiguities ?? [] } };
      }),
    },
    suppression: { stopped: stops.map((x) => ({ scope: x.scope, reason: x.reason, since: x.createdAt.toISOString() })) },
    deletion: deletion ? { requestedAt: deletion.requestedAt.toISOString(), verifiedAt: deletion.verifiedAt?.toISOString() ?? null, completedAt: deletion.completedAt?.toISOString() ?? null, status: deletion.completedAt ? 'completed' : deletion.verifiedAt ? 'verified_awaiting_staff' : 'awaiting_confirm' } : null,
    offers: {
      // A sensitive image (a barcode or ticket) is deleted unread: only that it happened is reported.
      listings: evidence.map((x) => ({ source: x.source, kind: x.kind, observedAt: x.observedAt.toISOString(), readBy: x.readBy, confidence: x.confidence, sensitive: x.sensitive, fields: x.sensitive || !x.fields ? null : Object.fromEntries(SAFE_LISTING_FIELDS.filter((k) => k in x.fields!).map((k) => [k, x.fields![k]])) })),
      fromLatestMessage: parsed ? { provenance: 'customer_text', offers: parsed.textOffers, setAside: parsed.offersSetAside } : null,
    },
    emails: intents.map((i) => ({ at: i.createdAt.toISOString(), kind: sendClassLabel(i.messageClass), state: i.state, subject: i.subject, text: i.bodyText, html: i.bodyHtml })),
    diagnostics: {
      questionsDetected: latest ? questionsAsked(latest.sanitizedText ?? '') : null,
      links: resolveLinks(latestBrief.submittedUrls ?? [], { eventId: req.eventId, audits: audits.map((x) => ({ action: x.action, diff: x.diff as Record<string, unknown> | null })) }),
      // Where the reply sent them: host and path, and whether it was a checked offer or an event page.
      destinations: links.map((l) => ({ label: l.label, purpose: l.purpose, affiliate: l.affiliate, url: hostPath(l.url) })),
      modelCalls: usage.map((u) => ({ revision: u.revision, job: u.jobName, model: u.model, state: u.kind, inputTokens: u.inputTokens, outputTokens: u.outputTokens, usdMicros: u.actualUsdMicros ?? u.estimatedUsdMicros })),
      fallbacks: audits.filter((x) => x.action.startsWith('ai.')).map((x) => ({ at: x.at.toISOString(), revision: x.revision, action: x.action, diff: x.diff })),
      sourceReads: reads.map((r) => ({ at: r.at.toISOString(), kind: r.kind, status: r.status, calls: r.calls, detail: r.detail })),
      sourceCallCount: reads.reduce((n, r) => n + (r.calls ?? 0), 0),
      linkLookups: audits.filter((x) => x.action.startsWith('listing.')).map((x) => ({ at: x.at.toISOString(), revision: x.revision, action: x.action, diff: x.diff })),
      trend: trend ? { at: trend.at.toISOString(), revision: trend.revision, assessment: trend.diff } : null,
      // Each question asked and what the reply did about it, per revision and route (launch A23).
      answerCoverage: audits.filter((x) => x.action === 'answer.coverage').map((x) => ({ at: x.at.toISOString(), revision: x.revision, coverage: x.diff })),
    },
  };
}

/** A URL as host and path: query strings can carry session, cart or affiliate parameters. */
function hostPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return raw.split('?')[0]!.slice(0, 200);
  }
}
