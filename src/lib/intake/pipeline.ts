import { noDashes } from '@/lib/email/punctuation';
import { raPointer } from '@/lib/sources/resident-advisor';
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import type { Env } from '@/lib/config/env';
import type { NormalizedInbound } from './contract';
import { detectAutoResponse } from './autoreply';
import { normalizeEmailLookup, resolveThread, stripQuotedContent, buildReferencesChain } from './threading';
import { enqueueOutbox } from './outbox';
import { inspectImage, selectProcessableImages } from '@/lib/media/image-validation';
import { createMediaStore } from '@/lib/media/storage';
import { audit } from '@/lib/util/audit';
import { type Extractor, missingMandatoryFields, clarificationQuestions, titleCaseName } from '@/lib/ai/extraction';
import { classifyResidence } from '@/lib/domain/country';
import { isAgainst, opponentFor, splitMatchup } from '@/lib/domain/matchup';
import { areaFor, venueInArea, browseLabel, genreFamilyFor, genreMatches, isBrowseRequest, narrowByFor, oneListingPerShow, oneOfLabel, choosePicks, genreFitScore, pickReason, collapseRuns, categoryBuyingNote, pilotCategoriesFor, providerClassificationFor, spanLabel } from '@/lib/domain/browse';
import type { Drafter } from '@/lib/ai/drafting';
import { AMBIGUITY_KINDS, RequestExtractionSchema, type HardConstraints, type Offer, type RequestExtraction, type SourceResult } from '@/lib/domain/types';
import { wholePartyBudgetCents, formatUsd } from '@/lib/domain/money';
import { dateWindowFor, eventLocalDate, resolveRelativeDate, toIsoDate } from '@/lib/domain/dates';
import { compareOffers, independentOptionCount, type Evaluated } from '@/lib/domain/comparison';
import { checkFreshness } from '@/lib/domain/freshness';
import { deriveInterestObservations } from '@/lib/domain/interests';
import { classifyOptOutText, revokeMarketing, stopAll } from '@/lib/domain/suppression';
import { sourcePlan } from '@/lib/sources/routing';
import { buildAdapter, TicketmasterDiscoveryAdapter, type AdapterActivation, type TicketSourceAdapter } from '@/lib/sources/adapters';
import { MarketTracker, marketForGroup, marketLicence } from '@/lib/market/tracker';
import { syncFromDiscovery, NON_ADMISSION_SUBTYPES, isNonGameName, DISCOVERY_SOURCE_ID } from '@/lib/catalog/sync';
import { exploreLink, sellerLink, type EmailLink } from '@/lib/email/links';
import { geohash, inMarket, isOutsideUs, marketById, marketFor, type Market } from '@/lib/domain/markets';
import { computeBenchmark, type HistoricalSnapshot, type DatasetRights, type EventContext, type BenchmarkResult } from '@/lib/advice/benchmark';
import { computeTrend, type TrendResult } from '@/lib/advice/trend';
import { decide, type CustomerPriorities } from '@/lib/advice/policy';
import { buildPacket, packetHash } from '@/lib/advice/packet';
import { validateAndRender, renderEvidenceOnly } from '@/lib/advice/renderer';
import { createSendIntent, claimSendIntent, releaseClaim, recordProviderAccepted, uncertainRetryDecision } from '@/lib/email/send-intents';
import { evaluateGate, loadSwitches, loadSuppressionScopes, type MessageClass } from '@/lib/email/send-gate';
import { renderTemplate } from '@/lib/email/templates';
import { loadActiveTemplates, loadBrandSignature } from '@/lib/email/template-store';
import { reserveBudget, settleBudget, releaseBudget, estimateUsdMicros, BudgetExceededError } from '@/lib/ai/budget';
import { ModelOutputError } from '@/lib/ai/model-client';
import { cadenceMinutes, watchExpiry, shouldAlert, alertDedupeKey, WATCH_MAX_ACTIVE_PER_CONTACT } from '@/lib/domain/watches';

export type Clock = () => Date;

export interface EmailProvider {
  send(args: { idempotencyKey: string; from: string; to: string; subject: string; text: string; html: string; headers: Record<string, string> }): Promise<{ providerMessageId: string }>;
}

export type ConciergeDeps = {
  db: Db;
  env: Env;
  extractor: Extractor;
  drafter: Drafter;
  clock?: Clock;
  emailProvider: EmailProvider | null;
  fixtureOffers?: Record<string, Offer[]>;
  fixtureBehavior?: Record<string, { status?: SourceResult['status']; retryAfterSeconds?: number }>;
  /** Fetch used by the Discovery adapter; tests inject a fake so no test ever reaches the provider. */
  discoveryFetch?: typeof fetch;
  /** Fetch used for SeatData market data; tests inject a fake. */
  marketFetch?: typeof fetch;
};

export type IngestOutcome = { kind: 'stored_auto_response'; messageId: string } | { kind: 'ignored_recipient'; messageId: string } | { kind: 'duplicate'; messageId: string } | { kind: 'queued'; messageId: string; conversationId: string; requestId: string; contactId: string; isNewConversation: boolean };

const RAW_RETENTION_DAYS = 30;
const OBSERVATION_RETENTION_DAYS = 90;

type NoMatchReason = 'no_performer' | 'unknown_performer' | 'no_scheduled_event' | 'discovery_no_results';

/** The keys that earn a clarification round. Ambiguities are a closed vocabulary, so this can match them. */
const CLARIFIABLE: string[] = ['event', 'quantity', 'budget_basis', 'country', ...AMBIGUITY_KINDS];

/**
 * What we tell the customer when no event could be attached — which depends entirely on why.
 *
 * "We couldn't find it in the official listings we can check" reads as "we looked and it wasn't there".
 * With no integrated source and an empty catalog that is a claim about diligence we did not do, and the
 * same prohibition that stops us inventing availability stops us inventing a search.
 */
function noMatchNote(reason: NoMatchReason, brief: RequestExtraction): string | null {
  const who = brief.performerOrTeam ? titleCaseName(brief.performerOrTeam) : null;
  const when = brief.dateExpression ? ` for "${brief.dateExpression}"` : '';
  const where = brief.city ? ` in ${brief.city}` : '';
  if (reason === 'no_performer') return null; // nothing was named; the questions carry it
  if (reason === 'unknown_performer') return `We don't have ${who ?? 'that performer or team'} in our event list yet, so we haven't looked at any prices.`;
  // This one is earned: the official listings were actually queried for this name and window.
  if (reason === 'discovery_no_results') return `We checked the official listings and couldn't find a scheduled ${who ?? 'matching'} event${where}${when}, so we haven't looked at prices yet.`;
  return `We don't have a scheduled ${who ?? 'matching'} event${where}${when} on file, so we haven't looked at prices yet.`;
}

export class Concierge {
  private readonly db: Db;
  private readonly env: Env;
  readonly now: Clock;
  constructor(private readonly deps: ConciergeDeps) {
    this.db = deps.db;
    this.env = deps.env;
    this.now = deps.clock ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------------------------
  // Intake
  // ---------------------------------------------------------------------------------------------
  async ingestInbound(msg: NormalizedInbound): Promise<IngestOutcome> {
    const now = this.now();
    // Every address we receive on or send from counts as our own, so a loop is detected whichever one bounced.
    const svc = [...new Set([...this.env.inboundAddresses, ...Object.values(this.env.messageClassFromAddresses), this.env.MARKETING_FROM_ADDRESS])];
    const auto = detectAutoResponse({ headers: msg.headers, subject: msg.subject, from: msg.from, serviceAddresses: svc });
    const accepted = new Set(this.env.inboundAddresses.map(normalizeEmailLookup));
    const toService = msg.to.map(normalizeEmailLookup).some((a) => accepted.has(a));
    const senderLookup = normalizeEmailLookup(msg.from);

    return await this.db.transaction(async (tx) => {
      // Dedupe on provider email id.
      const dup = await tx.select({ id: t.messages.id }).from(t.messages).where(and(eq(t.messages.provider, msg.provider), eq(t.messages.direction, 'inbound'), eq(t.messages.providerEmailId, msg.providerEmailId)));
      if (dup[0]) return { kind: 'duplicate' as const, messageId: dup[0].id };

      // Contact (conservative lookup: lowercase only).
      const [existingContact] = await tx.select().from(t.contacts).where(eq(t.contacts.emailLookup, senderLookup));
      let contactId = existingContact?.id;
      if (!contactId) {
        const [c] = await tx.insert(t.contacts).values({ emailOriginal: msg.from, emailLookup: senderLookup, lastInboundAt: now }).returning({ id: t.contacts.id });
        contactId = c!.id;
      } else {
        await tx.update(t.contacts).set({ lastInboundAt: now }).where(eq(t.contacts.id, contactId));
      }

      // Thread resolution with participant authorization (A20).
      const refs = await (async () => {
        const ids = [msg.inReplyTo, msg.references].filter((x): x is string => !!x).flatMap((x) => [...x.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]));
        if (!ids.length) return new Map<string, { conversationId: string; contactEmailLookup: string; rfcMessageId: string }>();
        const rows = await tx.select({ conversationId: t.messages.conversationId, rfc: t.messages.rfcMessageId, providerRfc: t.sendIntents.providerRfcMessageId, email: t.contacts.emailLookup }).from(t.messages).innerJoin(t.conversations, eq(t.conversations.id, t.messages.conversationId)).innerJoin(t.contacts, eq(t.contacts.id, t.conversations.contactId)).leftJoin(t.sendIntents, eq(t.sendIntents.conversationId, t.conversations.id)).where(inArray(t.messages.rfcMessageId, ids));
        const m = new Map<string, { conversationId: string; contactEmailLookup: string; rfcMessageId: string }>();
        for (const r of rows) if (r.rfc) m.set(r.rfc, { conversationId: r.conversationId, contactEmailLookup: r.email, rfcMessageId: r.rfc });
        // Outbound provider-assigned Message-IDs are also valid anchors.
        const outbound = await tx.select({ conversationId: t.sendIntents.conversationId, rfc: t.sendIntents.providerRfcMessageId, email: t.contacts.emailLookup }).from(t.sendIntents).innerJoin(t.contacts, eq(t.contacts.id, t.sendIntents.contactId)).where(inArray(t.sendIntents.providerRfcMessageId, ids));
        for (const r of outbound) if (r.rfc && r.conversationId) m.set(r.rfc, { conversationId: r.conversationId, contactEmailLookup: r.email, rfcMessageId: r.rfc });
        return m;
      })();
      const thread = resolveThread({ senderEmail: msg.from, inReplyTo: msg.inReplyTo, references: msg.references, lookup: (id) => refs.get(id) });
      let conversationId: string;
      let isNewConversation = false;
      if (thread.kind === 'existing') {
        conversationId = thread.conversationId;
        await tx.update(t.conversations).set({ lastActivityAt: now, revision: sql`${t.conversations.revision} + 1` }).where(eq(t.conversations.id, conversationId));
      } else {
        const [c] = await tx.insert(t.conversations).values({ contactId, subject: msg.subject, lastActivityAt: now }).returning({ id: t.conversations.id });
        conversationId = c!.id;
        isNewConversation = true;
      }

      const sanitized = stripQuotedContent(msg.text).slice(0, 20_000);
      const [m] = await tx
        .insert(t.messages)
        .values({
          conversationId,
          direction: 'inbound',
          provider: msg.provider,
          providerEmailId: msg.providerEmailId,
          rfcMessageId: msg.rfcMessageId,
          inReplyTo: msg.inReplyTo,
          referencesHeader: msg.references,
          fromAddress: msg.from,
          toAddresses: msg.to,
          subject: msg.subject,
          sanitizedText: sanitized,
          authenticationSummary: { ...msg.authentication, signatureVerified: msg.signatureVerified, threadResolution: thread.kind === 'new' ? thread.reason : 'existing', autoResponseReasons: auto.reasons },
          autoSubmitted: auto.autoResponse,
          receivedAt: msg.receivedAt,
          purgeAt: new Date(now.getTime() + RAW_RETENTION_DAYS * 86_400_000),
        })
        .returning({ id: t.messages.id });
      const messageId = m!.id;

      // Raw text copy + attachments into private media (bounded, validated).
      const media = createMediaStore(tx, this.env.MEDIA_PROVIDER, this.env.MEDIA_MAX_TOTAL_BYTES);
      const raw = await media.put({ ownerKind: 'raw_mime', ownerId: messageId, mimeType: 'text/plain', bytes: new TextEncoder().encode(msg.text), expiresAt: new Date(now.getTime() + RAW_RETENTION_DAYS * 86_400_000) });
      if (raw.ok) await tx.update(t.messages).set({ rawMediaId: raw.id }).where(eq(t.messages.id, messageId));
      const inspected = msg.attachments.map((a) => ({ a, insp: inspectImage(a.bytes, a.declaredMimeType), byteLength: a.bytes.byteLength, accepted: false as boolean }));
      for (const x of inspected) x.accepted = x.insp.ok;
      const { selected } = selectProcessableImages(inspected);
      for (const x of inspected) {
        const isSelected = selected.includes(x);
        let mediaId: string | null = null;
        let validationState = x.insp.ok ? (isSelected ? 'accepted' : 'rejected') : 'rejected';
        let reason: string | null = x.insp.ok ? (isSelected ? null : 'exceeds_per_message_limits') : x.insp.reason;
        if (x.insp.ok && isSelected) {
          const put = await media.put({ ownerKind: 'attachment', ownerId: messageId, mimeType: x.insp.mimeType, bytes: x.a.bytes, expiresAt: new Date(now.getTime() + RAW_RETENTION_DAYS * 86_400_000) });
          if (put.ok) mediaId = put.id;
          else {
            validationState = 'pending_budget'; // A45: never silently discard; surfaces as a staff task
            reason = put.reason;
          }
        }
        await tx.insert(t.attachments).values({ messageId, providerAttachmentId: x.a.providerAttachmentId, filename: x.a.filename, declaredMimeType: x.a.declaredMimeType, detectedMimeType: x.insp.ok ? x.insp.mimeType : null, byteLength: x.byteLength, width: x.insp.ok ? x.insp.width : null, height: x.insp.ok ? x.insp.height : null, mediaId, validationState, validationReason: reason, purgeAt: new Date(now.getTime() + RAW_RETENTION_DAYS * 86_400_000) });
      }

      if (auto.autoResponse) {
        await audit(tx, { actor: 'system', action: 'inbound.auto_response_suppressed', entityKind: 'message', entityId: messageId, diff: { reasons: auto.reasons } });
        return { kind: 'stored_auto_response' as const, messageId };
      }
      if (!toService) {
        await audit(tx, { actor: 'system', action: 'inbound.unknown_recipient_ignored', entityKind: 'message', entityId: messageId, diff: { to: msg.to } });
        return { kind: 'ignored_recipient' as const, messageId };
      }

      // Request: attach to the conversation's latest open request, or create one.
      const openStates = ['received', 'interpreting', 'needs_clarification', 'resolving_event', 'researching', 'awaiting_review', 'recommendation_sent', 'monitoring', 'manual_attention', 'referred'];
      const [existingReq] = await tx.select().from(t.requests).where(and(eq(t.requests.conversationId, conversationId), inArray(t.requests.state, openStates))).orderBy(desc(t.requests.createdAt)).limit(1);
      let requestId: string;
      if (existingReq) {
        requestId = existingReq.id;
      } else {
        const [r] = await tx.insert(t.requests).values({ conversationId, contactId, state: 'received' }).returning({ id: t.requests.id });
        requestId = r!.id;
        await tx.insert(t.requestTransitions).values({ requestId, fromState: null, toState: 'received', revision: 1, actor: 'system', reason: 'inbound_message' });
      }
      await enqueueOutbox(tx, { eventType: 'request.interpret', eventKey: `interpret:${messageId}`, entityId: requestId, payload: { messageId, requestId, conversationId }, now });
      await audit(tx, { actor: 'system', action: 'inbound.received', entityKind: 'message', entityId: messageId, diff: { conversationId, requestId, newConversation: isNewConversation } });
      return { kind: 'queued' as const, messageId, conversationId, requestId, contactId, isNewConversation };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Interpretation
  // ---------------------------------------------------------------------------------------------
  async interpret(args: { messageId: string; requestId: string }): Promise<{ state: string; revision: number; extraction: RequestExtraction | null }> {
    const now = this.now();
    const [msg] = await this.db.select().from(t.messages).where(eq(t.messages.id, args.messageId));
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, args.requestId));
    if (!msg || !req) throw new Error('message or request not found');
    const [contact] = await this.db.select().from(t.contacts).where(eq(t.contacts.id, req.contactId));
    const entities = await this.db.select({ e: t.entities, v: t.venues }).from(t.entities).leftJoin(t.venues, eq(t.venues.id, t.entities.homeVenueId));
    const known = entities.map(({ e }) => ({ name: e.name, aliases: e.aliases, kind: (e.kind === 'team' ? 'team' : 'artist') as 'team' | 'artist', category: e.league?.toLowerCase() ?? 'concert' }));

    // Venue timezone hint: from a previously matched event or the NY pilot default when city is NYC (never for dates when unknown).
    const priorVersion = await this.latestVersion(req.id);
    let venueTz: string | null = null;
    if (req.eventId) {
      const [ev] = await this.db.select({ tz: t.venues.timezone }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(eq(t.events.id, req.eventId));
      venueTz = ev?.tz ?? null;
    }
    if (!venueTz && /\b(new york|nyc|manhattan|brooklyn|msg)\b/i.test(msg.sanitizedText ?? '')) venueTz = 'America/New_York';

    let extraction: RequestExtraction;
    try {
      extraction = await this.runExtractor({ messageId: msg.id, text: msg.sanitizedText ?? '', subject: msg.subject, receivedAt: msg.receivedAt, venueTimeZone: venueTz, knownEntities: known }, req);
    } catch (e) {
      // A transport failure is transient, so it is rethrown and the outbox retries it with backoff.
      // Parking it in manual_attention would turn one timeout into permanent staff work on a customer's
      // request. Refusals, malformed and incomplete output are deterministic — the same message gets the
      // same answer — so those do go to staff, carrying the kind and the provider's own message: the
      // class name alone ('ModelOutputError') never said why.
      if (e instanceof ModelOutputError && e.kind === 'transport') throw e;
      if (e instanceof BudgetExceededError || e instanceof ModelOutputError) {
        const reason = e instanceof ModelOutputError ? `extraction_failed:${e.kind}: ${e.message}` : `extraction_failed:budget_exceeded: ${e.message}`;
        await this.parkForStaff({ req, revision: req.currentRevision, reason, contact: contact!, msg });
        return { state: 'manual_attention', revision: req.currentRevision, extraction: null };
      }
      throw e;
    }

    // Merge with prior revision when this is a follow-up (never re-ask established facts).
    let merged = priorVersion ? mergeExtraction(RequestExtractionSchema.parse(priorVersion.brief), extraction) : extraction;

    // Intents with side effects but no research.
    if (extraction.intent === 'marketing_opt_out') {
      const kind = classifyOptOutText(msg.sanitizedText ?? '') ?? 'unsubscribe_marketing';
      if (kind === 'stop_all') await stopAll(this.db, { contactId: contact!.id, emailLookup: contact!.emailLookup, evidence: { messageId: msg.id } });
      else await revokeMarketing(this.db, { contactId: contact!.id, emailLookup: contact!.emailLookup, method: 'natural_language', evidence: { messageId: msg.id }, noticeVersion: 'n/a' });
      await audit(this.db, { actor: 'system', action: kind === 'stop_all' ? 'contact.stop_all' : 'contact.marketing_opt_out', entityKind: 'contact', entityId: contact!.id, diff: { messageId: msg.id } });
      if (!priorVersion) await this.transition(req.id, 'closed', 'opt_out_only');
      return { state: priorVersion ? req.state : 'closed', revision: req.currentRevision, extraction };
    }
    if (extraction.intent === 'delete_data') {
      await this.db.insert(t.deletionLedger).values({ emailLookupHash: sha(contact!.emailLookup), contactId: contact!.id, requestedAt: now, actor: 'customer', scope: ['messages', 'attachments', 'requests', 'interests', 'watches'] });
      await this.queueSend({ messageClass: 'verification', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Confirm your deletion request'), template: 'deletion_verification', vars: {}, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
      await this.transition(req.id, 'manual_attention', 'deletion_requested_pending_verification');
      return { state: 'manual_attention', revision: req.currentRevision, extraction };
    }
    if (extraction.intent === 'cancel_watch') {
      await this.db.update(t.watches).set({ state: 'cancelled', generation: sql`${t.watches.generation} + 1` }).where(and(eq(t.watches.contactId, contact!.id), eq(t.watches.state, 'active')));
      await this.db.update(t.eventAlerts).set({ state: 'cancelled' }).where(and(eq(t.eventAlerts.contactId, contact!.id), eq(t.eventAlerts.state, 'active')));
      await audit(this.db, { actor: 'customer', action: 'watch.cancelled_by_customer', entityKind: 'contact', entityId: contact!.id, diff: { messageId: msg.id } });
    }

    // New revision.
    const revision = priorVersion ? req.currentRevision + 1 : 1;
    // Only a statement that names a place counts; "I'm in a hurry" or an unrecognised place changes nothing.
    const residence = classifyResidence(extraction.countryStatement);
    if (residence) {
      const isUs = residence === 'US';
      await this.db.update(t.contacts).set({ countryConfirmed: isUs ? 'US' : 'NON_US' }).where(eq(t.contacts.id, contact!.id));
      // The replies below read the contact loaded before this message; "I'm in Brooklyn" must not be followed
      // by "reply if you're not in the US".
      contact!.countryConfirmed = isUs ? 'US' : 'NON_US';
      await this.db.update(t.requests).set({ countryConfirmed: isUs ? 'US' : 'NON_US' }).where(eq(t.requests.id, req.id));
      if (!isUs) {
        await this.db.insert(t.requestVersions).values({ requestId: req.id, revision, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: [], createdBy: 'system' });
        await this.db.update(t.requests).set({ currentRevision: revision }).where(eq(t.requests.id, req.id));
        await this.transition(req.id, 'unsupported', 'customer_outside_us');
        await this.queueSend({ messageClass: 'no_result', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Ticket Guy is US-only for now'), template: 'unsupported', vars: { reason: 'We currently serve US customers and US events only.' }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
        return { state: 'unsupported', revision, extraction: merged };
      }
    }

    // "What's on?" — a kind of event, a place and some dates, but no performer or team: answer with options
    // instead of asking which event, how many tickets and which date.
    let picked: { e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect } | null = null;
    let pickNote: string | null = null;
    if (isBrowseRequest(merged)) {
      const b = await this.browse({ req, msg, contact: contact!, merged, revision, more: extraction.wantsMore === true && req.browseShown.length > 0 });
      if (!('pick' in b)) return b;
      picked = b.pick;
      pickNote = b.note;
    }

    // Assume and say, rather than ask: an unstated quantity is two and a bare budget is the total, and the reply
    // says so in one line the customer can correct. Only a real doubt ("a few tickets") is still asked.
    const { brief: withDefaults, assumed } = applyDefaults(merged);
    merged = withDefaults;
    const assumptions = [...(pickNote ? [pickNote] : []), ...assumptionLines(assumed, merged)];

    // Event resolution (a browse that found exactly one event has already resolved it).
    const resolution: Awaited<ReturnType<Concierge['resolveEvent']>> = picked
      ? { kind: 'resolved', event: picked.e, venue: picked.v, label: eventLabel(picked.e, picked.v), entityKind: null }
      : await this.resolveEventWithDiscovery(merged, { receivedAt: msg.receivedAt, venueTimeZone: venueTz, home: merged.city ? null : await this.contactMarket(contact!.id) });
    const eventResolved = resolution.kind === 'resolved';
    if (resolution.kind === 'resolved' && resolution.assumed) assumptions.unshift(resolution.assumed);
    const missing = missingMandatoryFields(merged, { eventResolved });
    // "next week" is a window the resolver now reads; a model that still flags it as an unsupported date
    // expression should not cost the customer a question about it.
    const dateWindowKnown = !!merged.dateExpression && !!dateWindowFor(merged.dateExpression, msg.receivedAt, venueTz ?? 'America/New_York');
    // The model flags "Giants" as ambiguous and "no city" as unknown from the words alone; once the catalog has
    // settled the event (one team with a game then, or the local one), those questions have been answered.
    const ambiguities = merged.ambiguities.filter((a) => !(dateWindowKnown && a === 'date_unsupported_expression') && !(eventResolved && SETTLED_BY_RESOLUTION.includes(a)));
    const unresolved = [...missing, ...(resolution.kind === 'ambiguous' ? ['event_ambiguous'] : []), ...ambiguities];

    await this.db.insert(t.requestVersions).values({ requestId: req.id, revision, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: unresolved, createdBy: 'system' });
    await this.db.update(t.requests).set({ currentRevision: revision, eventId: eventResolved ? resolution.event.id : null, category: eventResolved ? resolution.event.category : req.category, mode: merged.intent === 'watch_request' ? 'keep_looking' : merged.submittedUrls.length ? 'beat_offer' : 'find_options', updatedAt: now, deadlineAt: merged.decisionDeadline ? new Date(merged.decisionDeadline) : req.deadlineAt }).where(eq(t.requests.id, req.id));
    if (revision > 1) await this.invalidateForRevision(req.id, revision);

    // Interest evidence (never marketing permission).
    const catForInterest = eventResolved ? resolution.event.category : null;
    const entityKind = eventResolved ? (resolution.entityKind ?? null) : merged.performerOrTeam ? (known.find((k) => k.name === merged.performerOrTeam)?.kind ?? null) : null;
    const wp = wholePartyBudgetCents(merged.budgetCents, merged.budgetBasis, merged.quantity);
    for (const o of deriveInterestObservations(merged, { category: catForInterest, entityKind, wholePartyBudgetCents: wp })) {
      await this.db.insert(t.interestTaxonomy).values({ key: o.tagKey, kind: o.kind, allowedForMarketing: o.allowedForMarketing }).onConflictDoNothing();
      await this.db.insert(t.interestObservations).values({ contactId: contact!.id, tagKey: o.tagKey, messageId: msg.id, requestId: req.id, explicit: o.explicit, polarity: o.polarity, confidence: o.confidence, forSelf: o.forSelf, observedAt: now, expiresAt: new Date(now.getTime() + 365 * 86_400_000) });
    }

    if (resolution.kind === 'non_us') {
      await this.transition(req.id, 'unsupported', 'event_outside_us');
      await this.queueSend({ messageClass: 'no_result', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Ticket Guy is US-only for now'), template: 'unsupported', vars: { reason: 'That event is outside the US, and we only cover US events for now.' }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
      return { state: 'unsupported', revision, extraction: merged };
    }

    // "Let me know when it goes on sale / when they announce a date" (DECISION_LOG #43).
    if (this.env.EVENT_ALERTS_ENABLED && merged.notifyAsked && extraction.intent !== 'cancel_watch') {
      const set = await this.maybeEventAlert({ req, msg, contact: contact!, merged, revision, resolution, home: merged.city ? null : await this.contactMarket(contact!.id) });
      if (set) return set;
    }

    if (unresolved.some((u) => CLARIFIABLE.includes(u))) {
      const count = req.clarificationCount + 1;
      if (count > 3) {
        await this.db.update(t.requests).set({ clarificationCount: count }).where(eq(t.requests.id, req.id));
        await this.parkForStaff({ req, revision, reason: 'clarification_limit_reached', contact: contact!, msg });
        return { state: 'manual_attention', revision, extraction: merged };
      }
      // The question that decides the event comes first and is built from the filtered candidates, never a
      // dump of them. The extractor's ambiguities are asked too: they are why this clarification exists, and
      // they used to trigger it without ever reaching the email.
      const eventQuestion = resolution.kind === 'ambiguous' ? decisiveEventQuestion(resolution.candidates, merged) : null;
      const qKeys = [...new Set([...missing, ...ambiguities])].filter((k) => !(eventQuestion && (k === 'event' || k === 'performer_ambiguous')));
      if (ambiguities.includes('date_near_midnight') && !eventQuestion && !qKeys.includes('event')) qKeys.unshift('event');
      const questions = [...(eventQuestion ? [eventQuestion] : []), ...clarificationQuestions(qKeys, merged)].slice(0, 3);
      // Residency is an eligibility check, not part of the request: asked once, on its own line, on the first
      // clarification (ENGINEERING_SPEC §1), and remembered on the contact once answered.
      const countryCheck = !contact!.countryConfirmed && count === 1;
      const knownFacts = describeKnown(merged);
      const noMatch = resolution.kind === 'no_match' ? noMatchNote(resolution.reason, merged) : null;
      // Nothing scheduled at all (not merely on that date): offer to tell them when there is.
      const offerAlert = noMatch && this.env.EVENT_ALERTS_ENABLED && !!merged.performerOrTeam && (await this.nothingScheduled(merged, merged.city ? null : await this.contactMarket(contact!.id)));
      const eventNote = noMatch ? `${noMatch}${offerAlert ? ' If they haven’t announced it yet, reply "let me know" and I’ll email you when a date is out.' : ''}` : null;
      // An electronic act we can't find is often only on Resident Advisor: point there for the customer's city.
      const ra = noMatch && genreFamilyFor(merged.genreHint)?.key === 'electronic' ? raPointer((await this.marketForRequest(merged, contact!.id))?.market.id) : null;
      await this.db.update(t.requests).set({ clarificationCount: count }).where(eq(t.requests.id, req.id));
      await this.transition(req.id, 'needs_clarification', unresolved.join(','));
      await this.queueSend({ messageClass: 'clarification', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'A couple of quick questions'), template: 'clarification', vars: { acknowledgement: acknowledgementLine(merged), eventNote, questions, assumptions, countryCheck, knownFacts, ra }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
      return { state: 'needs_clarification', revision, extraction: merged };
    }

    if (resolution.kind !== 'resolved') throw new Error('unreachable');

    // Still on general sale at the official seller, and resale not asked about: that is the answer. Buy/wait
    // advice is for resale only (official prices are fixed or rise), so no research runs; the customer is
    // pointed at the sale, told resale can be cheaper for events that are not sold out, and "compare" opens
    // the resale comparison. No prices are quoted, so this goes without review (DECISION_LOG #36).
    // A price to judge ("is $106 a good deal?") gets the full answer, which includes the official sale.
    const official = merged.resaleAsked || merged.quotedPriceCents != null || merged.intent === 'watch_request' || merged.submittedUrls.length ? null : await this.officialSale(resolution.event, now);
    if (official) {
      await this.transition(req.id, 'referred', 'official_sale_open');
      await this.queueSend({
        messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal,
        subject: reSubject(msg.subject, 'Still on general sale'), template: 'official_sale',
        vars: { eventLabel: resolution.label, eventTitle: resolution.event.name, eventWhen: shortWhen(resolution.event.localStartAt, resolution.venue.timezone, resolution.event.subtype === 'time_tba'), venueName: resolution.venue.name, seller: official.seller, url: official.buyUrl, eventUrl: official.url, affiliate: official.affiliate, quantity: merged.quantity, notes: [...(pickNote ? [pickNote] : []), ...(resolution.assumed ? [resolution.assumed] : []), ...[categoryBuyingNote(resolution.event.category)].filter((x): x is string => !!x)], sportsGame: ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer'].includes(resolution.event.category), countryUnconfirmed: !contact!.countryConfirmed },
        inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null,
        dedupeKey: `official_sale:${req.id}:${resolution.event.id}`,
      });
      return { state: 'referred', revision, extraction: merged };
    }

    const cameFromReferral = req.state === 'referred';
    await this.transition(req.id, 'researching', 'brief_complete');
    // A browse that settled on its only match is answered here too, whichever revision it came on, and so is
    // a "compare" after the official-sale reply.
    if (revision === 1 || picked || cameFromReferral) {
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Got it, checking your options'), template: 'acknowledgment', vars: { knownFacts: describeKnown(merged, { eventResolved: true }), eventLabel: resolution.label, assumptions, countryUnconfirmed: !contact!.countryConfirmed }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
    }
    await this.db.transaction((tx) => enqueueOutbox(tx, { eventType: 'research.requested', eventKey: `research:${req.id}:${revision}`, entityId: req.id, revision, payload: { requestId: req.id, revision }, now }));

    if (merged.intent === 'watch_request') await this.maybeCreateWatch({ requestId: req.id, revision, contactId: contact!.id, eventId: resolution.event.id, eventStartAt: resolution.event.localStartAt, brief: merged, consentMessageId: msg.id });
    return { state: 'researching', revision, extraction: merged };
  }

  /**
   * Where a request is for: the place it names; else where this customer last asked about; else the default
   * market. `assumed` is true unless they named it, so the reply can say so. Null for a place outside the US.
   */
  private async marketForRequest(x: RequestExtraction, contactId: string): Promise<{ market: Market; assumed: boolean } | null> {
    if (x.city) {
      const named = marketFor(x.city, x.state);
      return named ? { market: named, assumed: false } : null;
    }
    return { market: (await this.contactMarket(contactId)) ?? marketById(this.env.DEFAULT_MARKET), assumed: true };
  }

  /** The market of this customer's most recent request that named a US place, if any. */
  private async contactMarket(contactId: string): Promise<Market | null> {
    const rows = await this.db.select({ brief: t.requestVersions.brief }).from(t.requestVersions).innerJoin(t.requests, eq(t.requests.id, t.requestVersions.requestId)).where(eq(t.requests.contactId, contactId)).orderBy(desc(t.requestVersions.createdAt)).limit(20);
    for (const r of rows) {
      const b = r.brief as { city?: string | null; state?: string | null };
      if (b.city && !isOutsideUs(b.city)) return marketFor(b.city, b.state ?? null);
    }
    return null;
  }

  /**
   * The official seller's page when its general sale is open now: the provider says "onsale", the public sale
   * window has started and not ended, and the event is still ahead. "On sale" is the provider's word for the
   * window; it is not a promise that seats remain, and the reply never says it is.
   */
  private async officialSale(event: typeof t.events.$inferSelect, now: Date): Promise<{ url: string; buyUrl: string; affiliate: boolean; seller: string } | null> {
    if (event.saleStatus !== 'onsale' || !event.publicSaleStartAt || event.publicSaleStartAt > now) return null;
    if (event.publicSaleEndAt && event.publicSaleEndAt <= now) return null;
    if (event.localStartAt <= now) return null;
    const [m] = await this.db.select({ url: t.eventSourceMappings.authoritativeUrl }).from(t.eventSourceMappings).where(and(eq(t.eventSourceMappings.eventId, event.id), eq(t.eventSourceMappings.sourceId, DISCOVERY_SOURCE_ID)));
    const seller = officialSellerFor(m?.url ?? null);
    if (!seller) return null;
    const buy = sellerLink(m!.url!, seller, this.env.AFFILIATE_LINK_TEMPLATES);
    return { url: m!.url!, buyUrl: buy.url, affiliate: buy.affiliate, seller };
  }

  /**
   * The picks as the email shows them: the line, why it fits, and at most two links — something to listen
   * to or explore, and the event's own ticket page (affiliate-wrapped after the picks were chosen).
   */
  private async picksFor(shown: Array<{ e: typeof t.events.$inferSelect }>, lines: string[], notes: Array<string | null> = []): Promise<Array<{ line: string; title: string; reason: string; eventUrl: string | null; links: EmailLink[]; affiliate: boolean }>> {
    if (!shown.length) return [];
    const ids = shown.map(({ e }) => e.id);
    const maps = await this.db.select({ eventId: t.eventSourceMappings.eventId, url: t.eventSourceMappings.authoritativeUrl }).from(t.eventSourceMappings).where(and(inArray(t.eventSourceMappings.eventId, ids), eq(t.eventSourceMappings.sourceId, DISCOVERY_SOURCE_ID)));
    const entityIds = shown.map(({ e }) => e.primaryEntityId).filter((x): x is string => !!x);
    const ents = entityIds.length ? await this.db.select({ id: t.entities.id, links: t.entities.links, kind: t.entities.kind }).from(t.entities).where(inArray(t.entities.id, entityIds)) : [];
    return shown.map(({ e }, i) => {
      const url = maps.find((m) => m.eventId === e.id)?.url ?? null;
      const seller = officialSellerFor(url);
      const tickets = url && seller ? sellerLink(url, seller, this.env.AFFILIATE_LINK_TEMPLATES) : null;
      const ent = ents.find((x) => x.id === e.primaryEntityId);
      const explore = exploreLink(ent?.links, ent?.kind ?? null);
      const links = [...(explore ? [explore] : []), ...(tickets ? [{ label: 'Tickets', url: tickets.url }] : [])];
      return { line: lines[i]!, title: e.name, reason: [pickReason(e), notes[i]].filter(Boolean).join(' '), eventUrl: seller ? url : null, links, affiliate: !!tickets?.affiliate };
    });
  }

  private async runExtractor(input: Parameters<Extractor['extract']>[0], req: { id: string; currentRevision: number }): Promise<RequestExtraction> {
    if (this.deps.extractor.name === 'fixture') return this.deps.extractor.extract(input);
    const model = this.env.modelName ?? 'rules';
    const est = estimateUsdMicros(model, Math.ceil(input.text.length / 3) + 800, 700, 0, this.env.modelPrices);
    // The ledger records the model the cost was estimated against; naming a different one makes every
    // spend figure unattributable.
    const res = await reserveBudget(this.db, { requestId: req.id, revision: req.currentRevision, runId: null, jobName: 'extract', model, estimatedUsdMicros: est, limits: this.limits(), now: this.now() });
    let out: RequestExtraction;
    try {
      out = await this.deps.extractor.extract(input);
    } catch (e) {
      // Nothing was billed when the call never reached the model, so the reservation must not stand: a
      // run of transport failures would otherwise eat the daily cap without producing one extraction.
      // A refusal, a malformed response or a truncated one did consume tokens, so those keep theirs.
      if (e instanceof ModelOutputError && e.kind === 'transport') {
        await releaseBudget(this.db, { requestId: req.id, revision: req.currentRevision, model, estimatedUsdMicros: est, jobName: 'extract' });
      }
      throw e;
    }
    const usage = (this.deps.extractor as { lastUsage?: { inputTokens: number; outputTokens: number } | null }).lastUsage ?? null;
    if (usage) await settleBudget(this.db, res.ledgerId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: 0, actualUsdMicros: estimateUsdMicros(model, usage.inputTokens, usage.outputTokens, 0, this.env.modelPrices) });
    return out;
  }

  private limits() {
    return { requestSoftUsd: this.env.aiRequestSoftBudgetUsd, requestHardUsd: this.env.aiRequestHardBudgetUsd, globalDailyUsd: this.env.aiGlobalDailyBudgetUsd, maxCallsPerRevision: this.env.AI_MAX_CALLS_PER_REVISION };
  }

  private async latestVersion(requestId: string) {
    const [v] = await this.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId)).orderBy(desc(t.requestVersions.revision)).limit(1);
    return v ?? null;
  }

  /**
   * A request only a person can move. It used to stop here in silence: no reply to the customer, nothing to
   * staff, found only by someone opening the inbox. Now the customer is told once per request that a person
   * has it, and staff are alerted once per revision with the reason and a link — never the message itself.
   */
  private async parkForStaff(a: { req: typeof t.requests.$inferSelect; revision: number; reason: string; contact: typeof t.contacts.$inferSelect; msg: typeof t.messages.$inferSelect }): Promise<void> {
    const { req, revision, reason, contact, msg } = a;
    await this.transition(req.id, 'manual_attention', reason.slice(0, 500));
    await this.queueSend({
      messageClass: 'acknowledgment', contactId: contact.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact.emailOriginal,
      subject: reSubject(msg.subject, 'A person is picking this up'), template: 'holding', vars: { hours: staffedHoursLabel(this.env) },
      inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null,
      dedupeKey: `holding:${req.id}`,
    });
    await enqueueOutbox(this.db, { eventType: 'staff.alert', eventKey: `staff_alert:${req.id}:${revision}`, entityId: req.id, payload: { requestId: req.id, revision }, now: this.now() });
  }

  /**
   * One email per staff address for a request waiting on a person. Internal mail, so it does not pass the
   * customer send gate (whose test allowlist would drop staff), but "stop all outbound" still stops it. It
   * carries the reason and a link, never the customer's words, like the diagnostic scripts.
   */
  async alertStaff(args: { requestId: string; revision: number }): Promise<{ outcome: 'sent' | 'skipped'; reason?: string }> {
    const skip = async (why: string) => {
      await audit(this.db, { actor: 'system', action: 'staff_alert.skipped', entityKind: 'request', entityId: args.requestId, revision: args.revision, diff: { reason: why } });
      return { outcome: 'skipped' as const, reason: why };
    };
    const recipients = this.env.STAFF_ALERT_ADDRESSES.length ? this.env.STAFF_ALERT_ADDRESSES : this.env.STAFF_EMAIL_ALLOWLIST;
    if (!recipients.length) return skip('no_staff_addresses');
    if (!this.deps.emailProvider) return skip('sending_disabled');
    const switches = await loadSwitches(this.db);
    if (switches.all_outbound === false) return skip('kill_switch_all_outbound');
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, args.requestId));
    if (!req) return skip('request_not_found');
    if (req.state !== 'manual_attention') return skip('no_longer_waiting');
    const [last] = await this.db.select({ reason: t.requestTransitions.reason, at: t.requestTransitions.createdAt }).from(t.requestTransitions).where(and(eq(t.requestTransitions.requestId, req.id), eq(t.requestTransitions.toState, 'manual_attention'))).orderBy(desc(t.requestTransitions.createdAt)).limit(1);
    const why = staffReasonLabel(last?.reason ?? 'unknown');
    const link = `${this.env.APP_URL.replace(/\/$/, '')}/admin/requests/${req.id}`;
    const subject = `Needs a person: ${why}`;
    const text = [
      `A request is waiting on a person: ${why}.`,
      `Request ${req.id.slice(0, 8)}, revision ${args.revision}. The customer has been told a person is picking it up.`,
      `Open it: ${link}`,
      'This is an automatic alert. Reply to the customer from the request page, not to this email.',
    ].join('\n\n');
    const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = `<p>A request is waiting on a person: <strong>${esc(why)}</strong>.</p><p>Request ${esc(req.id.slice(0, 8))}, revision ${args.revision}. The customer has been told a person is picking it up.</p><p><a href="${esc(link)}">Open the request</a></p><p style="color:#666;font-size:12px;">This is an automatic alert. Reply to the customer from the request page, not to this email.</p>`;
    for (const to of recipients) {
      await this.deps.emailProvider.send({
        idempotencyKey: `staff-alert:${req.id}:${args.revision}:${to}`,
        from: `Ticket Guy alerts <${this.env.CONCIERGE_FROM_ADDRESS}>`,
        to, subject, text, html,
        // An out-of-office reply to this must not come back in as a customer request.
        headers: { 'Auto-Submitted': 'auto-generated', 'X-TicketGuy-Staff-Alert': 'true' },
      });
    }
    await audit(this.db, { actor: 'system', action: 'staff_alert.sent', entityKind: 'request', entityId: req.id, revision: args.revision, diff: { recipients: recipients.length, reason: last?.reason?.split(':')[0] ?? 'unknown' } });
    return { outcome: 'sent' };
  }

  async transition(requestId: string, toState: string, reason: string, actor = 'system'): Promise<void> {
    const [r] = await this.db.select({ state: t.requests.state, rev: t.requests.currentRevision }).from(t.requests).where(eq(t.requests.id, requestId));
    await this.db.update(t.requests).set({ state: toState, updatedAt: this.now(), failureReason: toState === 'failed' || toState === 'unsupported' ? reason : null }).where(eq(t.requests.id, requestId));
    await this.db.insert(t.requestTransitions).values({ requestId, fromState: r?.state ?? null, toState, revision: r?.rev ?? 1, actor, reason });
  }

  /**
   * A browse reply: up to five real scheduled events of the kind asked for, in the pilot market and the span
   * named (the next two weeks when none was, and the reply says so). The request waits for the customer to
   * pick one; their reply names it, and the ordinary resolution takes over from there.
   */
  private async browse(a: { req: typeof t.requests.$inferSelect; msg: typeof t.messages.$inferSelect; contact: typeof t.contacts.$inferSelect; merged: RequestExtraction; revision: number; more?: boolean }): Promise<{ state: string; revision: number; extraction: RequestExtraction } | { pick: { e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect }; note: string }> {
    const { req, msg, contact, merged, revision } = a;
    const more = a.more === true;
    const now = this.now();
    // Paging through a list is the customer steering, not a question we failed to settle: it does not count
    // towards the limit that hands a request to a person.
    const count = req.clarificationCount + (more ? 0 : 1);
    // Recorded once the outcome is known: a single match goes on as an ordinary request, which records its own.
    const recordVersion = async () => {
      await this.db.insert(t.requestVersions).values({ requestId: req.id, revision, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: ['event'], createdBy: 'system' });
      await this.db.update(t.requests).set({ currentRevision: revision, eventId: null, mode: 'find_options', updatedAt: now }).where(eq(t.requests.id, req.id));
      if (revision > 1) await this.invalidateForRevision(req.id, revision);
    };
    if (count > 3) {
      await recordVersion();
      await this.db.update(t.requests).set({ clarificationCount: count }).where(eq(t.requests.id, req.id));
      await this.parkForStaff({ req, revision, reason: 'clarification_limit_reached', contact, msg });
      return { state: 'manual_attention', revision, extraction: merged };
    }
    const unsupported = async (reason: string, why: string) => {
      await recordVersion();
      await this.transition(req.id, 'unsupported', why);
      await this.queueSend({ messageClass: 'no_result', contactId: contact.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact.emailOriginal, subject: reSubject(msg.subject, 'Not covered yet'), template: 'unsupported', vars: { reason }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
      return { state: 'unsupported', revision, extraction: merged };
    };
    // Any US market: the one they named, else where they looked last time, else the default, said as such.
    const placed_ = await this.marketForRequest(merged, contact.id);
    if (!placed_) return unsupported('For now I only cover events in the US.', 'browse_outside_us');
    const { market, assumed: assumedPlace } = placed_;
    const tz = market.timezone;
    const categories = pilotCategoriesFor(merged.categoryHint, this.env.blockedCategories);
    const coverage = 'For now I cover concerts, sports, theater, comedy and family shows.';
    if (!categories.length) return unsupported(merged.categoryHint && merged.categoryHint !== 'sports' ? `${browseLabel(merged.categoryHint)} isn't something I cover yet. ${coverage}` : coverage, 'browse_category_not_in_pilot');

    const day = (iso: string, delta: number) => {
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d + delta));
      return toIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    };
    const today = eventLocalDate(now, tz);
    let win = merged.dateExpression ? dateWindowFor(merged.dateExpression, msg.receivedAt, tz) : null;
    if (!win && merged.resolvedLocalDate) win = { from: merged.resolvedLocalDate, to: merged.resolvedLocalDate };
    const assumedWindow = !win;
    win ??= { from: today, to: day(today, 13) };
    if (win.from < today) win = { from: today, to: win.to };

    // The borough they named and the kind of music narrow the list; either is dropped, and the reply says so,
    // when nothing on file fits it.
    const area = market.id === 'new-york' ? areaFor(merged.city) : null;
    const genre = merged.categoryHint === 'concert' || merged.categoryHint === null ? genreFamilyFor(merged.genreHint) : null;

    // Ask the provider about a window once per city (fresh results are reused), then read the catalog. A kind
    // of music is also asked for by name, so a busy week's first hundred shows do not crowd it out.
    const discovery = await this.discoveryAvailability();
    const lookIn = async (w: { from: string; to: string }) => {
      let providerChecked = false;
      if (discovery && w.from <= w.to) {
        // A borough is asked about by its own cities; a metro by its centre and radius; a town by name.
        // A neighbourhood is asked about around its centre (its venues are filed under the borough), and its
        // borough too, so there is something to widen to.
        const wheres: Array<{ city?: string; stateCode?: string | null; geoPoint?: string; radiusMiles?: number }> = area
          ? [...(area.centre ? [{ geoPoint: geohash(area.centre.lat, area.centre.lng), radiusMiles: Math.ceil(area.centre.radiusMiles) + 1 }] : []), ...area.providerCities.map((city) => ({ city }))]
          : market.lat !== null && market.lng !== null
            ? [{ geoPoint: geohash(market.lat, market.lng), radiusMiles: market.radiusMiles }]
            : [{ city: market.label, stateCode: merged.state }];
        const classifications = [providerClassificationFor(merged.categoryHint), ...(genre?.provider ?? [])];
        for (const where of wheres) for (const classificationName of classifications) {
          const sync = await syncFromDiscovery(this.db, discovery.adapter, { keyword: '', classificationName, ...where, startDateTime: `${w.from}T00:00:00Z`, endDateTime: `${day(w.to, 1)}T12:00:00Z`, size: 100, trigger: 'interpret', dailyCallLimit: discovery.dailyCallLimit, now });
          await audit(this.db, { actor: 'system', action: 'catalog.discovery_synced', entityKind: 'catalog', entityId: `browse:${(where.city ?? market.id).toLowerCase()}`, diff: { status: sync.status, eventsSeen: sync.eventsSeen, eventsUpserted: sync.eventsUpserted, window: w, classification: classificationName } });
          if (sync.status === 'success' || sync.status === 'skipped_fresh') providerChecked = true;
        }
      }
      const rows = w.from <= w.to
        ? await this.db.select({ e: t.events, v: t.venues }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(and(inArray(t.events.category, categories), eq(t.events.status, 'scheduled'), gte(t.events.localStartAt, now), lte(t.events.localStartAt, new Date(`${day(w.to, 2)}T00:00:00Z`)), marketFilter(market))).orderBy(asc(t.events.localStartAt)).limit(2000)
        : [];
      const seen = new Set<string>();
      const inWindow = rows.filter(({ e, v }) => {
        if (!inMarket(v, market)) return false;
        if (e.subtype && NON_ADMISSION_SUBTYPES.includes(e.subtype)) return false;
        if (isNonGameName(e.name) && ['nhl', 'nba', 'mlb', 'wnba', 'nfl'].includes(e.category)) return false;
        const d = eventLocalDate(e.localStartAt, v.timezone);
        if (d < w.from || d > w.to) return false;
        const key = `${e.name.toLowerCase()}|${d}|${v.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // The provider lists VIP, premium and package versions of one show as separate events; one line per show.
      const all = oneListingPerShow(inWindow, ({ e, v }) => ({ name: e.name, venueId: v.id, startAt: e.localStartAt, entityId: e.primaryEntityId }));
      // The area named, else the borough it is in, else the whole market: whichever has something on.
      const inArea = area ? all.filter(({ v }) => venueInArea(area, v)) : all;
      const inParent = area?.parent && !inArea.length ? all.filter(({ v }) => venueInArea(area.parent!, v)) : [];
      const areaUsed = !area ? null : inArea.length ? area : inParent.length ? area.parent! : null;
      const areaKept = !area || areaUsed === area;
      const placed = !area ? all : inArea.length ? inArea : inParent.length ? inParent : all;
      const ofGenre = genre ? placed.filter(({ e }) => genreMatches(genre, e.genre)) : placed;
      const genreKept = !genre || ofGenre.length > 0;
      return { providerChecked, all, placed, areaKept, areaUsed, genreKept, events: genreKept ? ofGenre : placed };
    };
    // Nothing in the window is not a dead end: a team that plays at home every other week, or a quiet week,
    // gets the next few after it (six weeks on), said as such.
    const within = await lookIn(win);
    const after = within.events.length ? null : await lookIn({ from: day(win.to, 1), to: day(win.to, 42) });
    const found = after?.events.length ? after : within;
    const { all, placed, areaKept, areaUsed, genreKept } = found;
    // A run of dates (a Broadway show, a two-night stand, a series) is one pick. Then "the other 7": the same
    // list, without what was already sent. Runs are formed first, so a sent show never returns as its next date.
    const runs = collapseRuns(found.events, ({ e, v }) => ({ name: e.name, venueId: v.id, day: eventLocalDate(e.localStartAt, v.timezone) }));
    const runOf = new Map(runs.map((r) => [r.item.e.id, r]));
    const alreadyShown = new Set(more ? req.browseShown : []);
    const events = runs.map((r) => r.item).filter(({ e }) => !alreadyShown.has(e.id));
    const providerChecked = within.providerChecked;

    // One game in the window is the answer, not a menu of one. When they have said how many tickets, they are
    // buying: it goes straight on to prices as an ordinary request, and the reply says why. Without a number
    // it is shown as the one option, and only the number is asked.
    // One show with many dates is not one match: which night is still theirs to pick.
    const single = !more && !after && events.length === 1 && !runOf.get(events[0]!.e.id)?.moreDates && genreKept && areaKept;
    if (single && merged.quantity !== null) {
      const only = events[0]!;
      return { pick: only, note: `That's the only ${oneOfLabel(merged.categoryHint, genre)} in ${areaUsed?.label ?? market.label} for ${spanLabel(win.from, win.to)}, so I've gone ahead with it. Tell me if you had something else in mind.` };
    }
    await recordVersion();
    // Three picks that fit best, on different days where possible, each with why it fits and where to go next.
    const dayOf = ({ e, v }: (typeof events)[number]) => eventLocalDate(e.localStartAt, v.timezone);
    const shown = choosePicks(events, 3, (x) => ({ day: dayOf(x), score: genreFitScore(x.e.genre, merged.genreHint) }));
    const options = shown.map(({ e, v }) => `${new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(e.localStartAt)}: ${e.name} at ${v.name}`);
    const picks = await this.picksFor(shown, options, shown.map(({ e }) => runNote(runOf.get(e.id), e.category)));
    const label = genre && genreKept ? genre.label : browseLabel(merged.categoryHint);
    const place = areaUsed?.label ?? market.label;
    const span = spanLabel(win.from, win.to);
    const headline = more
      ? (options.length ? `More ${label.toLowerCase()} in ${place}, ${span}:` : `That's everything I have for ${label.toLowerCase()} in ${place}, ${span}.`)
      : after?.events.length
      ? `${label} in ${place}: nothing on ${span}, but here are the next ones after that:`
      : `${label} in ${place}, ${span}${single ? '. There’s one on:' : options.length ? (options.length === 1 ? '. Here’s the one I found:' : `. Here are my ${options.length === 3 ? 'three' : 'two'} picks:`) : '.'}`;
    // Most small venues sell outside the listings we read; saying so beats implying there is nothing on.
    const sceneNote = area?.independentScene && events.length < 3 ? `A lot of the smaller venues around ${area.label} sell through DICE, Eventbrite or Resident Advisor, which I can't see yet.` : null;
    const ra = genre?.key === 'electronic' ? raPointer(market.id) : sceneNote ? raPointer(market.id, `${sceneNote} Resident Advisor lists many of them.`) : null;
    const assumptions = [assumedWindow ? 'the next two weeks' : null, assumedPlace ? market.label : null].filter(Boolean);
    const notes = [
      assumptions.length ? `I've looked at ${assumptions.join(', in ')}. Tell me if you had something else in mind.` : null,
      area && areaKept && events.length ? `I've kept it to ${area.label} venues. Say if you'd go further.` : null,
      area && !areaKept && all.length ? `Nothing in ${area.label} fits, so here's the rest of ${areaUsed?.label ?? market.label}.` : null,
      // Said here only when there is no Resident Advisor link to say it with.
      sceneNote && !ra ? sceneNote : null,
      genre && !genreKept && placed.length ? `I couldn't find any ${genre.words} listed for those dates, so here's everything that's on.` : null,
    ].filter(Boolean);
    const assumption = notes.length ? notes.join(' ') : null;
    // A place we don't know is searched as a town of that name; finding nothing there says more about the name.
    const unknownPlace = market.id.startsWith('city:') && !all.length;
    const emptyNote = unknownPlace
      ? `I couldn't find ${market.label} as a place in the official listings. Which city is it in or near? I'll look there.`
      : providerChecked
      ? `I checked the official listings and couldn't find any ${label.toLowerCase()} in ${place} for ${span}.`
      : `I don't have any ${label.toLowerCase()} in ${place} on file for ${span}.`;
    // What this reply lists is remembered, so "the other 7" continues from here; a new question starts over.
    const listed = shown.map(({ e }) => e.id);
    await this.db.update(t.requests).set({ clarificationCount: count, browseShown: more ? [...req.browseShown, ...listed] : listed }).where(eq(t.requests.id, req.id));
    await this.transition(req.id, 'needs_clarification', 'browse_options');
    await this.queueSend({
      messageClass: 'clarification', contactId: contact.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact.emailOriginal,
      subject: reSubject(msg.subject, `${label} in ${place}, ${span}`), template: 'browse_options',
      vars: { headline, options, picks, affiliate: picks.some((p) => p.affiliate), quantity: merged.quantity, single, moreCount: after?.events.length ? 0 : events.length - shown.length, ...(genre && genreKept ? { narrowBy: 'an artist, venue or day', askFor: 'an artist' } : narrowByFor(merged.categoryHint)), assumption, emptyNote, countryCheck: !contact.countryConfirmed && count === 1, ra },
      inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null,
    });
    return { state: 'needs_clarification', revision, extraction: merged };
  }

  /** A05: a new revision invalidates prior approvals/recommendations and pauses watches bound to older revisions. */
  private async invalidateForRevision(requestId: string, newRevision: number): Promise<void> {
    await this.db.update(t.recommendations).set({ reviewStatus: 'invalidated' }).where(and(eq(t.recommendations.requestId, requestId), inArray(t.recommendations.reviewStatus, ['pending', 'approved']), sql`${t.recommendations.revision} < ${newRevision}`));
    await this.db.update(t.watches).set({ state: 'paused', generation: sql`${t.watches.generation} + 1` }).where(and(eq(t.watches.requestId, requestId), eq(t.watches.state, 'active'), sql`${t.watches.revision} < ${newRevision}`));
    await this.db.update(t.sendIntents).set({ state: 'blocked', lastError: 'revision_superseded' }).where(and(eq(t.sendIntents.requestId, requestId), eq(t.sendIntents.state, 'queued'), inArray(t.sendIntents.messageClass, ['recommendation', 'watch_alert'])));
    await this.db.update(t.researchRuns).set({ supersededAt: this.now(), status: 'superseded' }).where(and(eq(t.researchRuns.requestId, requestId), eq(t.researchRuns.status, 'running')));
    await audit(this.db, { actor: 'system', action: 'request.revision_invalidated_prior_work', entityKind: 'request', entityId: requestId, revision: newRevision });
  }

  // ---------------------------------------------------------------------------------------------
  // Event resolution (canonical events only; never invents a show)
  // ---------------------------------------------------------------------------------------------
  /**
   * Performers/teams the customer's word could mean. Matches the canonical name, a stored alias ("Rangers" for
   * "New York Rangers"), or the name containing the word — case-insensitively, because the customer typed
   * "rangers". More than one hit is a real ambiguity (two teams share the nickname), not a bug.
   */
  private async matchEntities(performerOrTeam: string): Promise<Array<typeof t.entities.$inferSelect>> {
    const kw = performerOrTeam.trim().toLowerCase();
    if (!kw) return [];
    const like = `%${kw}%`;
    const rows = await this.db
      .select()
      .from(t.entities)
      .where(sql`lower(${t.entities.name}) = ${kw}
        or exists (select 1 from jsonb_array_elements_text(${t.entities.aliases}) a where lower(a) = ${kw})
        or lower(${t.entities.name}) like ${like}`)
      .orderBy(asc(t.entities.name))
      .limit(10);
    // An exact name or nickname beats a name that merely contains the word: "rangers" is the New York and the
    // Texas Rangers, not also "New York Rangers Alumni". Containment is the fallback when nothing is exact.
    const exact = rows.filter((r) => r.name.toLowerCase() === kw || (r.aliases ?? []).some((a) => a.toLowerCase() === kw));
    return exact.length ? exact : rows;
  }

  async resolveEvent(x: RequestExtraction, home?: Market | null): Promise<{ kind: 'resolved'; event: typeof t.events.$inferSelect; venue: typeof t.venues.$inferSelect; label: string; entityKind: 'artist' | 'team' | null; assumed?: string | null } | { kind: 'ambiguous'; candidates: EventCandidate[] } | { kind: 'no_match'; reason: NoMatchReason } | { kind: 'non_us' }> {
    if (!x.performerOrTeam) return { kind: 'no_match', reason: 'no_performer' };
    // A matchup ("Rangers vs Lightning") is tried side by side: the side we know is the team, the other side
    // narrows its games. The first-named side goes first because it is usually the home team.
    const matchup = splitMatchup(x.performerOrTeam);
    const attempts = matchup
      ? [{ name: matchup.first, opponent: matchup.second }, { name: matchup.second, opponent: matchup.first }]
      : [{ name: x.performerOrTeam, opponent: opponentFor(x.performerOrTeam, x.eventName) }];
    const now = this.now();

    const asked = [x.performerOrTeam, x.eventName, x.dateExpression].filter(Boolean).join(' ');
    const windowFilter = (rows: Array<{ e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect }>, isTeam: boolean, opponent: string | null) => {
      let cands = rows.filter(({ e }) => !e.subtype || !NON_ADMISSION_SUBTYPES.includes(e.subtype)); // parking and packages are not "tickets to the game"
      if (isTeam && !isNonGameName(asked)) cands = cands.filter(({ e }) => !isNonGameName(e.name));
      // A named opponent is a hard filter: "vs Lightning" never resolves to the game against someone else.
      if (opponent) cands = cands.filter(({ e }) => isAgainst(e.name, opponent));
      // A span the customer named ("Oct 1-7", "first week of October") wins over a single date the extractor
      // may have pinned from it: the words are the evidence, and the 1st is not "the first week".
      const spanNamed = !!x.dateExpression && rows.some(({ v }) => dateWindowFor(x.dateExpression!, now, v.timezone) !== null);
      if (x.resolvedLocalDate && !spanNamed) {
        cands = cands.filter(({ e, v }) => eventLocalDate(e.localStartAt, v.timezone) === x.resolvedLocalDate);
      } else if (x.dateExpression) {
        // A month or week named without a day still rules events out. Ignoring "next week" offered a November
        // alumni night to someone asking in September; ignoring a month once bound a November request to the
        // only October event on file. The window is read in each venue's own timezone.
        cands = cands.filter(({ e, v }) => {
          const win = dateWindowFor(x.dateExpression!, now, v.timezone);
          if (!win) return true;
          const d = eventLocalDate(e.localStartAt, v.timezone);
          return d >= win.from && d <= win.to;
        });
      }
      // A New York borough ("we're staying in Brooklyn") is where they are, not a rule that the Knicks move out
      // of Madison Square Garden: inside the pilot market any market venue fits; elsewhere the city must match.
      // A place is its market: "LA" means Inglewood too, and a borough ("we're staying in Brooklyn") does not
      // move the Knicks out of Madison Square Garden. Outside a known market the city must match.
      if (x.city) {
        const mk = marketFor(x.city, x.state);
        cands = cands.filter(({ v }) => (mk ? inMarket(v, mk) : false) || (v.city ?? '').toLowerCase() === x.city!.toLowerCase());
      }
      // The provider lists one show more than once (package and presale variants under the same name); one
      // show at one venue on one day is one candidate, or the customer is asked to choose between twins.
      const seen = new Set<string>();
      const twinsOut = cands.filter(({ e, v }) => {
        const key = `${e.name.toLowerCase()}|${eventLocalDate(e.localStartAt, v.timezone)}|${v.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return oneListingPerShow(twinsOut, ({ e, v }) => ({ name: e.name, venueId: v.id, startAt: e.localStartAt, entityId: e.primaryEntityId }));
    };

    // Events per matched entity, filtered the same way, so a nickname shared by two teams is settled by the
    // window, city or opponent when it can be and surfaced as a choice when it cannot.
    let perEntity: Array<{ entity: typeof t.entities.$inferSelect; cands: Array<{ e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect }> }> = [];
    let sawEntity = false;
    for (const attempt of attempts) {
      const entities = await this.matchEntities(attempt.name);
      if (!entities.length) continue;
      sawEntity = true;
      perEntity = [];
      for (const entity of entities) {
        const rows = await this.db.select({ e: t.events, v: t.venues }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(and(eq(t.events.primaryEntityId, entity.id), gte(t.events.localStartAt, now), eq(t.events.status, 'scheduled'))).orderBy(asc(t.events.localStartAt)).limit(40);
        perEntity.push({ entity, cands: windowFilter(rows, entity.kind === 'team', attempt.opponent) });
      }
      if (perEntity.some((p) => p.cands.length > 0)) break;
    }
    // Not on file at all is a different fact from on file with nothing scheduled, and the customer is told
    // which: claiming we searched listings we do not have is a claim about our own diligence.
    if (!sawEntity) return { kind: 'no_match', reason: 'unknown_performer' };
    let withEvents = perEntity.filter((p) => p.cands.length > 0);
    if (withEvents.length === 0) return { kind: 'no_match', reason: 'no_scheduled_event' };
    // Two teams share the name and both have a game in the window ("Giants", "Rangers", "Jets"): the one
    // that plays in the market we serve is meant, and the reply says so in a line the customer can correct.
    // Only when neither or both are local is it asked.
    let assumed: string | null = null;
    if (withEvents.length > 1) {
      const homeMarket = marketFor(x.city, x.state) ?? home ?? marketById(this.env.DEFAULT_MARKET);
      const local = withEvents.filter((p) => isLocalTeam(p.entity, p.cands, homeMarket));
      if (local.length === 1) {
        withEvents = local;
        assumed = `I've gone with the ${local[0]!.entity.name}. Tell me if you meant a different ${local[0]!.entity.kind === 'team' ? 'team' : 'act'}.`;
      }
    }
    if (withEvents.length > 1) {
      // Two different teams both have a game in the window: name them, one candidate each.
      return { kind: 'ambiguous', candidates: withEvents.slice(0, 5).map(({ entity, cands }) => candidateFrom(entity, cands[0]!.e, cands[0]!.v, `${entity.name}${entity.league ? ` (${entity.league})` : ''}: ${eventLabel(cands[0]!.e, cands[0]!.v)}`)) };
    }
    const { entity, cands } = withEvents[0]!;
    if (cands.length > 1) return { kind: 'ambiguous', candidates: cands.slice(0, 5).map(({ e, v }) => candidateFrom(entity, e, v, eventLabel(e, v))) };
    const { e, v } = cands[0]!;
    if (v.country !== 'US') return { kind: 'non_us' };
    return { kind: 'resolved', event: e, venue: v, label: eventLabel(e, v), entityKind: entity.kind === 'team' ? 'team' : 'artist', assumed };
  }

  /**
   * Whether the catalog may be extended from the provider right now. Both halves are required on purpose: the
   * key proves the account works, the adapter row proves someone accepted the terms and set the limits — a
   * working key alone never enables an integration (ENGINEERING_SPEC §6).
   */
  private async discoveryAvailability(): Promise<{ adapter: TicketmasterDiscoveryAdapter; dailyCallLimit: number | null } | null> {
    if (!this.env.TICKETMASTER_DISCOVERY_ENABLED || !this.env.TICKETMASTER_DISCOVERY_API_KEY) return null;
    const [cfg] = await this.db.select().from(t.adapterConfigs).where(eq(t.adapterConfigs.sourceId, DISCOVERY_SOURCE_ID));
    if (!cfg?.enabled || cfg.implementation !== 'ticketmaster_discovery') return null;
    return { adapter: new TicketmasterDiscoveryAdapter(this.env.TICKETMASTER_DISCOVERY_API_KEY, true, this.deps.discoveryFetch ?? fetch), dailyCallLimit: cfg.dailyCallLimit };
  }

  /** The date window the provider is asked about: the customer's date when we have one, otherwise the next 90 days. */
  private discoveryWindow(x: RequestExtraction, ctx: { receivedAt: Date; venueTimeZone: string | null }): { start: string; end: string } {
    const day = (iso: string, deltaDays: number) => {
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
      return toIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    };
    let from: string | null = x.resolvedLocalDate;
    let to: string | null = x.resolvedLocalDate;
    if (!from && x.dateExpression) {
      const win = dateWindowFor(x.dateExpression, ctx.receivedAt, ctx.venueTimeZone ?? 'America/New_York');
      if (win) [from, to] = [win.from, win.to];
      else {
        // "tonight" needs a zone to be a date; the pilot's venues are all in one, and a wrong guess only
        // widens the window by a day either side, it never binds an event.
        const r = resolveRelativeDate(x.dateExpression, ctx.receivedAt, ctx.venueTimeZone ?? 'America/New_York');
        if (r.kind === 'resolved') [from, to] = [r.localDate, r.localDate];
      }
    }
    if (from && to) return { start: `${day(from, -1)}T00:00:00Z`, end: `${day(to, 1)}T23:59:59Z` };
    const today = toIsoDate(ctx.receivedAt.getUTCFullYear(), ctx.receivedAt.getUTCMonth() + 1, ctx.receivedAt.getUTCDate());
    return { start: `${today}T00:00:00Z`, end: `${day(today, 90)}T23:59:59Z` };
  }

  /**
   * Local catalog first; when it has nothing for this name, ask the provider once and look again. A provider
   * failure never fails the request — it is recorded and the customer gets the honest "not on file" answer.
   */
  async resolveEventWithDiscovery(x: RequestExtraction, ctx: { receivedAt: Date; venueTimeZone: string | null; home?: Market | null }): Promise<Awaited<ReturnType<Concierge['resolveEvent']>>> {
    const local = await this.resolveEvent(x, ctx.home);
    if (local.kind !== 'no_match' || local.reason === 'no_performer') return local;
    const discovery = await this.discoveryAvailability();
    if (!discovery) return local;
    const win = this.discoveryWindow(x, ctx);
    // For a matchup the provider is asked about one team; its schedule includes the game against the other.
    const keyword = splitMatchup(x.performerOrTeam)?.first ?? x.performerOrTeam ?? x.eventName ?? '';
    // A named metro is searched by its centre and radius ("LA" finds Inglewood); a town by name; none, nationally.
    const mk = marketFor(x.city, x.state);
    const where = mk && mk.lat !== null && mk.lng !== null ? { geoPoint: geohash(mk.lat, mk.lng), radiusMiles: mk.radiusMiles } : { city: x.city };
    const sync = await syncFromDiscovery(this.db, discovery.adapter, { keyword, ...where, startDateTime: win.start, endDateTime: win.end, trigger: 'interpret', dailyCallLimit: discovery.dailyCallLimit, now: this.now() });
    await audit(this.db, { actor: 'system', action: 'catalog.discovery_synced', entityKind: 'catalog', entityId: keyword.toLowerCase(), diff: { status: sync.status, eventsSeen: sync.eventsSeen, eventsUpserted: sync.eventsUpserted, window: win } });
    if (sync.status !== 'success' && sync.status !== 'skipped_fresh') return local; // provider trouble: say what we have, not what we could not check
    const again = await this.resolveEvent(x, ctx.home);
    if (again.kind === 'no_match' && again.reason !== 'no_performer') return { kind: 'no_match', reason: 'discovery_no_results' };
    return again;
  }

  // ---------------------------------------------------------------------------------------------
  // Event alerts: "email me when it goes on sale / when they announce a date" (DECISION_LOG #43)
  // ---------------------------------------------------------------------------------------------

  /** No event at all for this performer or team where they asked, on any date. */
  private async nothingScheduled(x: RequestExtraction, home: Market | null): Promise<boolean> {
    const any = await this.resolveEvent({ ...x, dateExpression: null, resolvedLocalDate: null }, home);
    return any.kind === 'no_match' && any.reason !== 'no_performer';
  }

  /**
   * Sets an alert when one fits and answers the customer; null when the ordinary path should answer instead
   * (the sale is already open, it has closed, or there are events on other dates to choose from).
   */
  private async maybeEventAlert(a: { req: typeof t.requests.$inferSelect; msg: typeof t.messages.$inferSelect; contact: typeof t.contacts.$inferSelect; merged: RequestExtraction; revision: number; resolution: Awaited<ReturnType<Concierge['resolveEvent']>>; home: Market | null }): Promise<{ state: string; revision: number; extraction: RequestExtraction } | null> {
    const { req, msg, contact, merged, revision, resolution } = a;
    const now = this.now();
    let kind: 'on_sale' | 'new_date';
    let vars: Record<string, unknown>;
    let values: Partial<typeof t.eventAlerts.$inferInsert>;
    if (resolution.kind === 'resolved') {
      const e = resolution.event;
      // Only a sale the provider says opens later. On sale now is the official-sale reply; no sale date at all
      // could as easily mean sold out as not yet, and "isn't on sale yet" would then be wrong.
      if (e.localStartAt <= now || !e.publicSaleStartAt || e.publicSaleStartAt <= now) return null;
      const opens = e.publicSaleStartAt;
      kind = 'on_sale';
      vars = { kind, what: resolution.label, saleOpens: opens ? saleOpensLabel(opens, resolution.venue.timezone) : null };
      values = { eventId: e.id, nextCheckAt: nextOnSaleCheck(opens, now), expiresAt: e.localStartAt };
    } else if (resolution.kind === 'no_match' && merged.performerOrTeam && (await this.nothingScheduled(merged, a.home))) {
      const mk = merged.city ? marketFor(merged.city, merged.state) : null;
      kind = 'new_date';
      vars = { kind, what: `${titleCaseName(merged.performerOrTeam)}${mk ? ` in ${mk.label}` : merged.city ? ` in ${merged.city}` : ''}` };
      values = { keyword: merged.performerOrTeam, marketId: mk?.id ?? null, nextCheckAt: new Date(now.getTime() + EVENT_ALERT_CHECK_HOURS * 3_600_000), expiresAt: new Date(now.getTime() + NEW_DATE_ALERT_DAYS * 86_400_000) };
    } else return null;

    const [row] = await this.db.insert(t.eventAlerts).values({ requestId: req.id, contactId: contact.id, kind, consentMessageId: msg.id, nextCheckAt: values.nextCheckAt!, expiresAt: values.expiresAt!, eventId: values.eventId ?? null, keyword: values.keyword ?? null, marketId: values.marketId ?? null })
      .onConflictDoUpdate({ target: [t.eventAlerts.requestId, t.eventAlerts.kind], set: { state: 'active', consentMessageId: msg.id, nextCheckAt: values.nextCheckAt!, expiresAt: values.expiresAt!, eventId: values.eventId ?? null, keyword: values.keyword ?? null, marketId: values.marketId ?? null } })
      .returning({ id: t.eventAlerts.id });
    await audit(this.db, { actor: 'system', action: 'event_alert.created', entityKind: 'event_alert', entityId: row!.id, diff: { kind, consentMessageId: msg.id } });
    await this.transition(req.id, 'monitoring', kind === 'on_sale' ? 'event_alert_on_sale' : 'event_alert_new_date');
    await this.queueSend({ messageClass: 'acknowledgment', contactId: contact.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact.emailOriginal, subject: reSubject(msg.subject, kind === 'on_sale' ? 'I’ll tell you when it’s on sale' : 'I’ll tell you when there’s a date'), template: 'event_alert_set', vars: { ...vars, countryUnconfirmed: !contact.countryConfirmed }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `event_alert_set:${row!.id}:${revision}` });
    return { state: 'monitoring', revision, extraction: merged };
  }

  /**
   * One pass over due alerts (hourly cron). Each check is one bounded Discovery call inside the daily budget;
   * provider trouble just moves the check later. An alert fires once, then it is done.
   */
  async evaluateEventAlerts(opts: { limit?: number } = {}): Promise<{ checked: number; sent: number; expired: number; skipped?: string }> {
    const out = { checked: 0, sent: 0, expired: 0 };
    if (!this.env.EVENT_ALERTS_ENABLED) return { ...out, skipped: 'event_alerts_disabled' };
    const discovery = await this.discoveryAvailability();
    if (!discovery) return { ...out, skipped: 'discovery_unavailable' };
    const now = this.now();
    const due = await this.db.select().from(t.eventAlerts).where(and(eq(t.eventAlerts.state, 'active'), lte(t.eventAlerts.nextCheckAt, now))).orderBy(asc(t.eventAlerts.nextCheckAt)).limit(opts.limit ?? 25);
    for (const al of due) {
      if (al.expiresAt <= now) {
        await this.db.update(t.eventAlerts).set({ state: 'expired', lastCheckedAt: now }).where(eq(t.eventAlerts.id, al.id));
        out.expired += 1;
        continue;
      }
      out.checked += 1;
      const later = (at: Date) => this.db.update(t.eventAlerts).set({ nextCheckAt: at, lastCheckedAt: now }).where(eq(t.eventAlerts.id, al.id));
      const fallback = new Date(now.getTime() + EVENT_ALERT_CHECK_HOURS * 3_600_000);
      const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, al.requestId));
      if (!req) continue;

      if (al.kind === 'on_sale' && al.eventId) {
        const [row] = await this.db.select({ e: t.events, v: t.venues, ent: t.entities }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).leftJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId)).where(eq(t.events.id, al.eventId));
        if (!row) { await later(fallback); continue; }
        // Refresh the event itself: its sale window and status are what we are waiting on.
        const day = eventLocalDate(row.e.localStartAt, row.v.timezone);
        const sync = await syncFromDiscovery(this.db, discovery.adapter, { keyword: row.ent?.name ?? row.e.name, startDateTime: `${day}T00:00:00Z`, endDateTime: `${day}T23:59:59Z`, trigger: 'alert', dailyCallLimit: discovery.dailyCallLimit, now, force: true });
        if (sync.status !== 'success') { await later(new Date(now.getTime() + 3_600_000)); continue; }
        const [fresh] = await this.db.select().from(t.events).where(eq(t.events.id, al.eventId));
        const official = fresh ? await this.officialSale(fresh, now) : null;
        if (!official || !fresh) {
          await later(nextOnSaleCheck(fresh?.publicSaleStartAt && fresh.publicSaleStartAt > now ? fresh.publicSaleStartAt : null, now));
          continue;
        }
        await this.fireEventAlert(al, req, fresh.id, { kind: 'on_sale', what: eventLabel(fresh, row.v), seller: official.seller, affiliate: official.affiliate, events: [{ title: fresh.name, when: shortWhen(fresh.localStartAt, row.v.timezone, fresh.subtype === 'time_tba'), venue: row.v.name, url: official.buyUrl }] }, `On sale now: ${fresh.name}`);
        out.sent += 1;
        continue;
      }

      if (al.kind === 'new_date' && al.keyword) {
        const mk = al.marketId ? marketById(al.marketId) : null;
        const where = mk && mk.lat !== null && mk.lng !== null ? { geoPoint: geohash(mk.lat, mk.lng), radiusMiles: mk.radiusMiles } : {};
        const end = new Date(now.getTime() + 365 * 86_400_000);
        const sync = await syncFromDiscovery(this.db, discovery.adapter, { keyword: al.keyword, ...where, startDateTime: `${now.toISOString().slice(0, 10)}T00:00:00Z`, endDateTime: `${end.toISOString().slice(0, 10)}T23:59:59Z`, trigger: 'alert', dailyCallLimit: discovery.dailyCallLimit, now });
        if (sync.status !== 'success' && sync.status !== 'skipped_fresh') { await later(new Date(now.getTime() + 3_600_000)); continue; }
        const version = await this.latestVersion(req.id);
        const brief = version ? RequestExtractionSchema.parse(version.brief) : null;
        const found = brief ? await this.resolveEvent({ ...brief, performerOrTeam: al.keyword, dateExpression: null, resolvedLocalDate: null }, mk) : null;
        const ids = found?.kind === 'resolved' ? [found.event.id] : found?.kind === 'ambiguous' ? found.candidates.map((c) => c.id) : [];
        if (!ids.length) { await later(fallback); continue; }
        const rows = await this.db.select({ e: t.events, v: t.venues }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(inArray(t.events.id, ids)).orderBy(asc(t.events.localStartAt)).limit(3);
        const maps = await this.db.select({ eventId: t.eventSourceMappings.eventId, url: t.eventSourceMappings.authoritativeUrl }).from(t.eventSourceMappings).where(and(inArray(t.eventSourceMappings.eventId, rows.map((r) => r.e.id)), eq(t.eventSourceMappings.sourceId, DISCOVERY_SOURCE_ID)));
        const urlOf = new Map(maps.map((m) => [m.eventId, m.url]));
        let affiliate = false;
        const events = rows.map(({ e, v }) => {
          const raw = urlOf.get(e.id) ?? null;
          const seller = raw ? officialSellerFor(raw) : null;
          const l = raw && seller ? sellerLink(raw, seller, this.env.AFFILIATE_LINK_TEMPLATES) : null;
          affiliate = affiliate || !!l?.affiliate;
          return { title: e.name, when: shortWhen(e.localStartAt, v.timezone, e.subtype === 'time_tba'), venue: `${v.name}, ${v.city}`, url: l?.url ?? raw };
        });
        await this.fireEventAlert(al, req, rows[0]!.e.id, { kind: 'new_date', what: titleCaseName(al.keyword), where: mk?.label ?? null, affiliate, events }, `${titleCaseName(al.keyword)} just announced ${events.length === 1 ? 'a date' : 'dates'}`);
        out.sent += 1;
        continue;
      }
      await later(fallback);
    }
    return out;
  }

  private async fireEventAlert(al: typeof t.eventAlerts.$inferSelect, req: typeof t.requests.$inferSelect, firedEventId: string, vars: Record<string, unknown>, subject: string): Promise<void> {
    const now = this.now();
    const [contact] = await this.db.select().from(t.contacts).where(eq(t.contacts.id, al.contactId));
    if (!contact) return;
    const [lastInbound] = await this.db.select({ id: t.messages.rfcMessageId, subject: t.messages.subject }).from(t.messages).where(and(eq(t.messages.conversationId, req.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(desc(t.messages.receivedAt)).limit(1);
    // Claim it first, so a second pass can never send it twice.
    const claimed = await this.db.update(t.eventAlerts).set({ state: 'sent', sentAt: now, lastCheckedAt: now, firedEventId }).where(and(eq(t.eventAlerts.id, al.id), eq(t.eventAlerts.state, 'active'))).returning({ id: t.eventAlerts.id });
    if (!claimed.length) return;
    await this.queueSend({ messageClass: 'event_alert', contactId: contact.id, conversationId: req.conversationId, requestId: req.id, revision: null, recipient: contact.emailOriginal, subject: lastInbound?.subject ? reSubject(lastInbound.subject, subject) : subject, template: 'event_alert', vars, inReplyTo: lastInbound?.id ?? null, approvalId: null, approvedHash: null, dedupeKey: `event_alert:${al.id}` });
    await audit(this.db, { actor: 'system', action: 'event_alert.sent', entityKind: 'event_alert', entityId: al.id, diff: { kind: al.kind, firedEventId } });
    await this.transition(req.id, 'referred', 'event_alert_sent');
  }

  // ---------------------------------------------------------------------------------------------
  // Research → comparison → advice → draft
  // ---------------------------------------------------------------------------------------------
  async research(args: { requestId: string; revision: number }): Promise<{ recommendationId: string | null; state: string }> {
    const now = this.now();
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, args.requestId));
    if (!req) throw new Error('request not found');
    if (req.currentRevision !== args.revision) return { recommendationId: null, state: req.state }; // late work for a superseded revision (A05)
    const version = await this.latestVersion(req.id);
    const brief = RequestExtractionSchema.parse(version!.brief);
    if (!req.eventId) throw new Error('research without resolved event');
    const [evRow] = await this.db.select({ e: t.events, v: t.venues, ent: t.entities }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).leftJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId)).where(eq(t.events.id, req.eventId));
    const { e: event, v: venue, ent } = evRow!;
    const [contact] = await this.db.select().from(t.contacts).where(eq(t.contacts.id, req.contactId));

    const [run] = await this.db.insert(t.researchRuns).values({ requestId: req.id, revision: args.revision, mode: this.env.APP_MODE === 'fixture' ? 'fixture' : 'live', status: 'running' }).returning({ id: t.researchRuns.id });
    const runId = run!.id;

    // Source plan and adapters.
    const plan = sourcePlan(event.category);
    const required = plan.required.length ? plan.required : ['ticketmaster', 'seatgeek', 'stubhub'];
    const configs = await this.db.select().from(t.adapterConfigs);
    const cfgBySource = new Map(configs.map((c) => [c.sourceId, c]));
    const enabledFixtureSources = configs.filter((c) => c.enabled && c.implementation === 'fixture').map((c) => c.sourceId);
    const sourceIds = [...new Set([...required, ...enabledFixtureSources])];
    const quantity = brief.quantity!;
    const searchInput = { requestId: req.id, revision: args.revision, eventId: event.id, providerEventId: null, quantity, hardConstraints: {} };

    const allOffers: Offer[] = [];
    const checked: string[] = [];
    const unavailable: Array<{ sourceId: string; status: string }> = [];
    let ordinal = 0;
    for (const sourceId of sourceIds) {
      const cfg = cfgBySource.get(sourceId);
      const activation: AdapterActivation = { sourceId, implementation: (cfg?.implementation as AdapterActivation['implementation']) ?? 'not_integrated', enabled: cfg?.enabled ?? false, accessApprovalEvidence: cfg?.accessApprovalEvidence ?? null, monitoringAllowed: cfg?.monitoringAllowed ?? false };
      const adapter: TicketSourceAdapter = buildAdapter(activation, { fixtureOffers: this.deps.fixtureOffers ?? {}, fixtureBehavior: this.deps.fixtureBehavior, ticketmasterKey: this.env.TICKETMASTER_DISCOVERY_API_KEY ?? null, ticketmasterEnabled: this.env.TICKETMASTER_DISCOVERY_ENABLED, now: this.now });
      const res = await adapter.search(searchInput);
      ordinal += 1;
      const [check] = await this.db.insert(t.sourceChecks).values({ runId, sourceId, ordinal, status: res.status, reasonCode: res.reasonCode, observedAt: new Date(res.checkedAt), sourceAsOf: res.sourceAsOf ? new Date(res.sourceAsOf) : null, resultCount: res.offers.length, limitations: res.coverageNotes, evidence: { retryAfterSeconds: res.retryAfterSeconds }, checkedBy: `adapter:${adapter.implementation}` }).returning({ id: t.sourceChecks.id });
      if (res.status === 'success' || res.status === 'no_matching_inventory') checked.push(sourceId);
      else unavailable.push({ sourceId, status: res.status });
      for (const o of res.offers) {
        const [offerRow] = await this.db.insert(t.offers).values({ sourceId: o.sourceId, providerListingId: o.providerListingId, eventId: event.id, directPurchaseUrl: o.directPurchaseUrl, affiliateUrl: o.affiliateUrl ?? null }).returning({ id: t.offers.id });
        const [obs] = await this.db.insert(t.offerObservations).values({ offerId: offerRow!.id, runId, checkId: check!.id, eventId: event.id, quantity: o.quantity, section: o.section, rowLabel: o.row, seatNumbers: o.seatNumbers, seatsTogether: o.seatsTogether, admissionType: o.admissionType, baseTotalCents: o.baseTotalCents, mandatoryFeeTotalCents: o.mandatoryFeeTotalCents, taxTotalCents: o.taxTotalCents, deliveryTotalCents: o.deliveryTotalCents, payableTotalCents: o.payableTotalCents, priceCompleteness: o.priceCompleteness, restrictions: o.restrictions, deliveryMethod: o.deliveryMethod, expectedDeliveryAt: o.expectedDeliveryAt ? new Date(o.expectedDeliveryAt) : null, availability: o.availability, verificationMethod: o.collectionMode, verifiedBy: `adapter:${adapter.implementation}`, sourceAsOf: o.providerUpdatedAt ? new Date(o.providerUpdatedAt) : null, fetchedAt: new Date(o.observedAt), retentionUntil: new Date(now.getTime() + OBSERVATION_RETENTION_DAYS * 86_400_000), evidence: { evidenceId: o.evidenceId, seatClass: o.seatClass ?? null } }).returning({ id: t.offerObservations.id });
        allOffers.push({ ...o, id: obs!.id, evidenceId: obs!.id });
      }
    }
    // Manual evidence entered by staff for this request/revision is included.
    const manual = await this.db.select({ obs: t.offerObservations, off: t.offers }).from(t.offerObservations).innerJoin(t.offers, eq(t.offers.id, t.offerObservations.offerId)).where(and(eq(t.offerObservations.eventId, event.id), eq(t.offerObservations.verificationMethod, 'approved_manual'), eq(t.offerObservations.quantity, quantity), gte(t.offerObservations.fetchedAt, new Date(now.getTime() - 6 * 3_600_000))));
    for (const { obs, off } of manual) allOffers.push(observationToOffer(obs, off));

    // Deterministic comparison.
    const constraints: HardConstraints = { quantity, togetherRequired: brief.togetherRequired, budgetTotalCents: wholePartyBudgetCents(brief.budgetCents, brief.budgetBasis, quantity), excludeObstructedView: true, requireAccessible: !!brief.accessibilityNeeds, acceptableSections: null, eventStartAt: event.localStartAt.toISOString() };
    const cmp = compareOffers(allOffers, constraints, event.id);
    const best = cmp.eligible[0] ?? null;
    const alternatives = Object.entries(cmp.groups).filter(([k]) => k !== (best?.offer.seatClass ?? best?.offer.admissionType)).map(([, list]) => list[0]!).filter((e) => e.offer.id !== best?.offer.id).slice(0, 2);
    let entryRef: Evaluated | null = null;
    if (quantity > 1) {
      const singles = allOffers.filter((o) => o.quantity === 1 && o.eventId === event.id);
      const single = compareOffers(singles, { ...constraints, quantity: 1, togetherRequired: false, budgetTotalCents: null }, event.id).eligible[0] ?? null;
      entryRef = single;
    }

    // Advice: benchmark + trend from market snapshots (licensed or fixture) + policy.
    const priorities: CustomerPriorities = { mustAttend: brief.mustAttend, waitRiskTolerance: brief.waitRiskTolerance, decisionDeadline: brief.decisionDeadline ? new Date(brief.decisionDeadline) : null, budgetTotalCents: constraints.budgetTotalCents, togetherRequired: brief.togetherRequired, splitGroupAllowed: brief.splitGroupAllowed, watchConsentGiven: brief.intent === 'watch_request' };
    const basketKey = basketKeyFor(event.id, quantity, best?.offer.seatClass ?? null);
    const leadMinutes = Math.round((event.localStartAt.getTime() - now.getTime()) / 60_000);
    const { benchmark, benchmarkRunId } = await this.computeBenchmarkFor({ event, venue, ent, quantity, seatZone: best?.offer.seatClass ?? null, leadMinutes, now });
    const { trend, trendRunId } = await this.computeTrendFor({ eventId: event.id, basketKey, now });
    const monitoringCoverage = configs.some((c) => c.enabled && c.monitoringAllowed);
    // Resale market statistics (DECISION_LOG #44): brought up to date for this event now, used in the decision
    // only when the licence allows it in advice, and shown only when it allows customer display.
    const licence = await marketLicence(this.db);
    let market: Awaited<ReturnType<typeof marketForGroup>> | null = null;
    if (licence.allows('tracking')) {
      await new MarketTracker({ db: this.db, env: this.env, now: this.now, fetchImpl: this.deps.marketFetch }).refreshEvent(event.id);
      market = await marketForGroup(this.db, { eventId: event.id, quantity, eventStartAt: event.localStartAt, now });
    }
    const marketSignal = market && licence.allows('advice') ? { basisMatchesGroup: !!market.context && market.context.adequacy === 'sufficient', direction: market.context?.direction ?? 'insufficient', supply: market.supplyScope === 'group' && market.supply.trend === 'unknown' ? market.single.supply.trend : market.supply.trend } : null;
    const policy = decide({ market: marketSignal, now, eventStartAt: event.localStartAt, offers: { bestEligibleTotalCents: best?.comparableTotalCents ?? null, bestEligibleObservationId: best?.offer.id ?? null, eligibleCount: cmp.eligible.length, needsReviewCount: cmp.needsReview.length, alternativeAvailable: alternatives.length > 0 || cmp.needsReview.length > 0, deliveryFeasible: best ? (best.offer.deliveryMethod ? true : null) : null, safeDeliveryBufferMinutes: null }, benchmark, trend, priorities, monitoringCoverageAvailable: monitoringCoverage, staffedUntil: null });

    const isFixtureRun = allOffers.some((o) => o.collectionMode === 'fixture') || this.env.APP_MODE === 'fixture';
    // What we know without listings: the official sale if it is open, the provider's face value, and the
    // price the customer asked about (per ticket; a total is divided by the party size).
    const official = await this.officialSale(event, now);
    const faceValue = event.faceMinCents != null && event.faceMaxCents != null ? { minCents: event.faceMinCents, maxCents: event.faceMaxCents } : null;
    const quote = brief.quotedPriceCents != null
      ? { perTicketCents: brief.quotedPriceBasis === 'whole_party' && quantity > 0 ? Math.round(brief.quotedPriceCents / quantity) : brief.quotedPriceCents, assumedPerTicket: brief.quotedPriceBasis === null }
      : null;
    const packet = buildPacket({ market: market ? { basis: market.basis, context: market.context, supply: market.supply, supplyScope: market.supplyScope, comparableLabel: ent?.name ?? null, visible: licence.allows('customer_display') } : null, official: official ? { seller: official.seller, url: official.buyUrl } : null, faceValue, quote, requestId: req.id, revision: args.revision, quantity, eventLabel: eventLabel(event, venue), best, alternatives, entryReference: entryRef, benchmark, benchmarkRunId, trend, trendRunId, policy, priorities, sourcesChecked: checked, sourcesUnavailable: unavailable, independentOptionCount: independentOptionCount(cmp), observedAt: now, evidenceExpiresAt: new Date(now.getTime() + 15 * 60_000), basketKey, watchConsentReference: brief.intent === 'watch_request' ? version!.sourceMessageIds[0] ?? null : null, isFixture: isFixtureRun });
    const hash = packetHash(packet);
    const [adviceRun] = await this.db.insert(t.adviceRuns).values({ requestId: req.id, revision: args.revision, benchmarkRunId, trendRunId, verifiedOfferObservationIds: packet.verifiedOfferObservationIds, customerPriorities: packet.customerPriorities, policyVersion: policy.policyVersion, decision: policy.decision, reasonCodes: policy.reasonCodes, abstentions: policy.abstentions, nextCheckpointAt: policy.nextCheckpointAt, stopConditions: policy.stopConditions, packet: packet as unknown as Record<string, unknown>, packetHash: hash, evidenceExpiresAt: new Date(now.getTime() + 15 * 60_000) }).returning({ id: t.adviceRuns.id });

    // A price check with no listings of ours goes out without review (owner's decision, DECISION_LOG #42):
    // it compares the customer's own number with the provider's published face value and names the official
    // sale, and recommends no listing. Anything carrying a verified offer still waits for a person.
    const autoSend = packet.verifiedOfferObservationIds.length === 0 && quote !== null;
    const renderOpts = { reviewed: !autoSend };
    // Draft via drafter (fixture or model) with bounded retries → evidence-only fallback.
    let body: { textBody: string; htmlBody: string } | null = null;
    let draftNote: string | null = null;
    for (let attempt = 0; attempt < 2 && !body; attempt++) {
      try {
        if (this.deps.drafter.name !== 'fixture') {
          const model = this.env.modelName ?? 'rules';
          const est = estimateUsdMicros(model, 2500, 600, 0, this.env.modelPrices);
          const r = await reserveBudget(this.db, { requestId: req.id, revision: args.revision, runId, jobName: 'draft', model, estimatedUsdMicros: est, limits: this.limits(), now });
          let blocks;
          try {
            blocks = await this.deps.drafter.draft(packet, { quantity, mustAttend: brief.mustAttend, waitRiskTolerance: brief.waitRiskTolerance, togetherRequired: brief.togetherRequired });
          } catch (e) {
            // Same rule as extraction: a call that never reached the model keeps no reservation. This
            // loop retries, so an unreleased reservation would be charged twice for one draft.
            if (e instanceof ModelOutputError && e.kind === 'transport') {
              await releaseBudget(this.db, { requestId: req.id, revision: args.revision, model, estimatedUsdMicros: est, jobName: 'draft' });
            }
            throw e;
          }
          const usage = (this.deps.drafter as { lastUsage?: { inputTokens: number; outputTokens: number } | null }).lastUsage ?? null;
          if (usage) await settleBudget(this.db, r.ledgerId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: 0, actualUsdMicros: estimateUsdMicros(model, usage.inputTokens, usage.outputTokens, 0, this.env.modelPrices) });
          const v = validateAndRender(packet, blocks, renderOpts);
          if (v.ok) body = { textBody: v.textBody, htmlBody: v.htmlBody };
          else draftNote = `draft rejected: ${v.errors.join('; ')}`;
        } else {
          const blocks = await this.deps.drafter.draft(packet, { quantity, mustAttend: brief.mustAttend, waitRiskTolerance: brief.waitRiskTolerance, togetherRequired: brief.togetherRequired });
          const v = validateAndRender(packet, blocks, renderOpts);
          if (v.ok) body = { textBody: v.textBody, htmlBody: v.htmlBody };
          else draftNote = `draft rejected: ${v.errors.join('; ')}`;
        }
      } catch (e) {
        draftNote = `draft failed: ${e instanceof Error ? e.message : String(e)}`;
        if (e instanceof BudgetExceededError) break;
      }
    }
    if (!body) body = renderEvidenceOnly(packet, renderOpts);
    // Staff approve exactly what the customer gets, so the house style is applied before review, not at send.
    body = { textBody: noDashes(body.textBody), htmlBody: noDashes(body.htmlBody) };

    const isNoResult = !best && alternatives.length === 0;
    const subject = noDashes(isNoResult ? `Ticket Guy: what we found for ${eventLabel(event, venue)}` : `Ticket Guy: ${quantity} for ${event.name}`);
    const draftHash = sha(body.textBody + body.htmlBody);
    const [rec] = await this.db.insert(t.recommendations).values({ requestId: req.id, revision: args.revision, draftHash, chosenObservationIds: packet.verifiedOfferObservationIds, adviceRunId: adviceRun!.id, computedSavingsCents: null, bodyText: body.textBody, bodyHtml: body.htmlBody, subject, reviewStatus: 'pending', reviewNote: [draftNote, isFixtureRun ? 'FIXTURE DATA — cannot be sent' : null, contact?.countryConfirmed ? null : 'customer country unconfirmed'].filter(Boolean).join(' | ') || null, expiresAt: new Date(now.getTime() + 15 * 60_000) }).returning({ id: t.recommendations.id });
    await this.db.update(t.researchRuns).set({ status: 'completed', completedAt: now }).where(eq(t.researchRuns.id, runId));
    if (autoSend) {
      const [lastInbound] = await this.db.select().from(t.messages).where(and(eq(t.messages.conversationId, req.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(desc(t.messages.receivedAt)).limit(1);
      await this.db.update(t.recommendations).set({ reviewStatus: 'auto_sent', reviewerUserId: 'system:price-check' }).where(eq(t.recommendations.id, rec!.id));
      await this.queueSend({ messageClass: 'no_result', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: args.revision, recipient: contact!.emailOriginal, subject: reSubject(lastInbound?.subject ?? null, subject), template: 'raw_auto', vars: { text: body.textBody, html: body.htmlBody }, inReplyTo: lastInbound?.rfcMessageId ?? null, approvalId: null, approvedHash: null, dedupeKey: `rec:${rec!.id}:${draftHash}` });
      await audit(this.db, { actor: 'system', action: 'recommendation.auto_sent', entityKind: 'recommendation', entityId: rec!.id, revision: args.revision, diff: { reason: 'price_check_without_listings' } });
      await this.transition(req.id, 'recommendation_sent', 'price_check_auto_sent');
      return { recommendationId: rec!.id, state: 'recommendation_sent' };
    }
    await this.transition(req.id, 'awaiting_review', isNoResult ? 'no_verified_result_pending_review' : 'draft_ready');
    await this.db.transaction((tx) => enqueueOutbox(tx, { eventType: 'recommendation.review_ready', eventKey: `review:${rec!.id}`, entityId: rec!.id, revision: args.revision, payload: { recommendationId: rec!.id, requestId: req.id }, now }));
    return { recommendationId: rec!.id, state: 'awaiting_review' };
  }

  private async computeBenchmarkFor(a: { event: typeof t.events.$inferSelect; venue: typeof t.venues.$inferSelect; ent: typeof t.entities.$inferSelect | null; quantity: number; seatZone: string | null; leadMinutes: number; now: Date }): Promise<{ benchmark: BenchmarkResult | null; benchmarkRunId: string | null }> {
    if (!a.ent) return { benchmark: null, benchmarkRunId: null };
    const targetContext: EventContext = { entitySlug: a.ent.slug, venueId: a.venue.id, layoutVersion: a.venue.layoutVersion, category: a.event.category, subtype: a.event.subtype, isHome: a.event.isHome, dayType: null };
    const rows = await this.db.select({ s: t.marketSnapshots, e: t.events, v: t.venues }).from(t.marketSnapshots).innerJoin(t.events, eq(t.events.id, t.marketSnapshots.eventId)).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(and(eq(t.events.primaryEntityId, a.ent.id), eq(t.marketSnapshots.quantity, a.quantity)));
    const datasets = await this.db.select().from(t.marketDatasets);
    const rights: Record<string, DatasetRights> = Object.fromEntries(datasets.map((d) => [d.id, { id: d.id, status: d.status as DatasetRights['status'], approvedUses: d.approvedUses, rawRetentionUntil: d.rawRetentionUntil, derivedRetentionUntil: d.derivedRetentionUntil, isFixture: d.isFixture }]));
    const snapshots: HistoricalSnapshot[] = rows.map(({ s, e, v }) => ({ id: s.id, eventId: s.eventId, datasetId: s.datasetId, quantity: s.quantity, seatZone: s.seatZone, section: null, leadTimeMinutes: s.leadTimeMinutes, cheapestEligibleTotalCents: s.cheapestEligibleTotalCents, feeBasis: s.feeBasis as HistoricalSnapshot['feeBasis'], coverageComplete: s.coverageComplete, isFixture: s.isFixture, context: { entitySlug: a.ent!.slug, venueId: v.id, layoutVersion: v.layoutVersion, category: e.category, subtype: e.subtype, isHome: e.isHome, dayType: null } }));
    const allowFixtures = this.env.APP_MODE === 'fixture';
    const benchmark = computeBenchmark({ targetEventId: a.event.id, targetContext, targetQuantity: a.quantity, targetSeatZone: a.seatZone, targetLeadMinutes: a.leadMinutes, snapshots, datasets: rights, now: a.now, allowFixtures });
    const [run] = await this.db.insert(t.benchmarkRuns).values({ targetEventId: a.event.id, targetContext, cohortFilters: { quantity: a.quantity, seatZone: a.seatZone, leadMinutes: a.leadMinutes }, fallbacksApplied: benchmark.fallbacksApplied, representativeSnapshotIds: benchmark.representativeSnapshotIds, independentEventCount: benchmark.independentEventCount, medianCents: benchmark.medianCents === null ? null : Math.round(benchmark.medianCents), p25Cents: benchmark.p25Cents === null ? null : Math.round(benchmark.p25Cents), p75Cents: benchmark.p75Cents === null ? null : Math.round(benchmark.p75Cents), exclusions: benchmark.exclusions, adequacy: benchmark.adequacy, adequacyReasons: benchmark.adequacyReasons, licenseExpiresAt: benchmark.licenseExpiresAt, methodVersion: benchmark.methodVersion }).returning({ id: t.benchmarkRuns.id });
    return { benchmark, benchmarkRunId: run!.id };
  }

  private async computeTrendFor(a: { eventId: string; basketKey: string; now: Date }): Promise<{ trend: TrendResult | null; trendRunId: string | null }> {
    const rows = await this.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, a.eventId), eq(t.marketSnapshots.basketKey, a.basketKey))).orderBy(asc(t.marketSnapshots.observedAt));
    const admissible = rows.filter((r) => !r.isFixture || this.env.APP_MODE === 'fixture');
    if (admissible.length === 0) return { trend: null, trendRunId: null };
    const trend = computeTrend(admissible.map((r) => ({ id: r.id, observedAt: r.observedAt, basketKey: r.basketKey, cheapestEligibleTotalCents: r.cheapestEligibleTotalCents, sourceIds: r.sourceIds, feeBasis: r.feeBasis as 'verified_total' | 'estimated_total' | 'incomplete', coverageComplete: r.coverageComplete, qualityFlags: r.qualityFlags, cheapestSourceId: (r.qualityFlags.find((f) => f.startsWith('cheapest_source:')) ?? '').split(':')[1] ?? null })), a.now);
    const [run] = await this.db.insert(t.trendRuns).values({ eventId: a.eventId, basketKey: a.basketKey, sourceIntersection: trend.sourceIntersection, windows: trend.windows as unknown as Record<string, unknown>, baselineSnapshotId: trend.windows.h24?.baselineObservationId ?? null, currentSnapshotId: trend.validObservationIds[trend.validObservationIds.length - 1] ?? null, direction: trend.direction, adequacy: trend.adequacy, qualityFlags: trend.qualityFlags, methodVersion: trend.methodVersion }).returning({ id: t.trendRuns.id });
    return { trend, trendRunId: run!.id };
  }

  // ---------------------------------------------------------------------------------------------
  // Staff: manual evidence, approval
  // ---------------------------------------------------------------------------------------------
  async addManualOffer(args: { staffUserId: string; requestId: string; sourceId: string; sourceUrl: string; observedAt: Date; quantity: number; section: string | null; row: string | null; seatsTogether: boolean | null; payableTotalCents: number | null; baseTotalCents: number | null; feesKnown: boolean; taxKnown: boolean; deliveryMethod: string | null; restrictions: string[]; evidenceNote: string; seatClass: string | null }): Promise<{ observationId: string }> {
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, args.requestId));
    if (!req?.eventId) throw new Error('request has no resolved event');
    const completeness = args.payableTotalCents !== null && args.feesKnown && args.taxKnown ? 'verified_total' : args.payableTotalCents !== null ? 'estimated_total' : 'incomplete';
    const [offer] = await this.db.insert(t.offers).values({ sourceId: args.sourceId, providerListingId: null, eventId: req.eventId, directPurchaseUrl: args.sourceUrl }).returning({ id: t.offers.id });
    const [obs] = await this.db.insert(t.offerObservations).values({ offerId: offer!.id, eventId: req.eventId, quantity: args.quantity, section: args.section, rowLabel: args.row, seatsTogether: args.seatsTogether, admissionType: 'reserved', baseTotalCents: args.baseTotalCents, mandatoryFeeTotalCents: args.feesKnown && args.payableTotalCents !== null && args.baseTotalCents !== null ? args.payableTotalCents - args.baseTotalCents : null, taxTotalCents: args.taxKnown ? 0 : null, deliveryTotalCents: args.deliveryMethod ? 0 : null, payableTotalCents: args.payableTotalCents, priceCompleteness: completeness, restrictions: args.restrictions, deliveryMethod: args.deliveryMethod, availability: 'available', verificationMethod: 'approved_manual', verifiedBy: args.staffUserId, fetchedAt: args.observedAt, retentionUntil: new Date(this.now().getTime() + OBSERVATION_RETENTION_DAYS * 86_400_000), evidence: { note: args.evidenceNote, seatClass: args.seatClass } }).returning({ id: t.offerObservations.id });
    await audit(this.db, { actor: args.staffUserId, action: 'manual_offer.added', entityKind: 'request', entityId: args.requestId, revision: req.currentRevision, diff: { sourceId: args.sourceId, observationId: obs!.id } });
    return { observationId: obs!.id };
  }

  async approveRecommendation(args: { recommendationId: string; reviewerUserId: string; expectedRevision: number; draftHash: string; note: string | null }): Promise<{ ok: true; sendIntentId: string } | { ok: false; status: 409 | 422; reason: string }> {
    const now = this.now();
    const [rec] = await this.db.select().from(t.recommendations).where(eq(t.recommendations.id, args.recommendationId));
    if (!rec) return { ok: false, status: 422, reason: 'not_found' };
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, rec.requestId));
    if (!req || req.currentRevision !== args.expectedRevision || rec.revision !== req.currentRevision) return { ok: false, status: 409, reason: 'revision_stale' };
    if (rec.draftHash !== args.draftHash) return { ok: false, status: 409, reason: 'draft_hash_mismatch' };
    if (rec.reviewStatus !== 'pending') return { ok: false, status: 409, reason: `review_status_${rec.reviewStatus}` };
    // A27: chosen observations must be fresh at approval; otherwise revalidation is required.
    const [event] = await this.db.select().from(t.events).where(eq(t.events.id, req.eventId!));
    const obs = rec.chosenObservationIds.length ? await this.db.select().from(t.offerObservations).where(inArray(t.offerObservations.id, rec.chosenObservationIds)) : [];
    const stale = obs.filter((o) => !checkFreshness({ fetchedAt: o.fetchedAt, sourceAsOf: o.sourceAsOf, eventStartAt: event!.localStartAt, now }).fresh);
    if (stale.length) {
      await this.db.update(t.recommendations).set({ reviewNote: `revalidation_required: ${stale.length} observation(s) older than the freshness window` }).where(eq(t.recommendations.id, rec.id));
      await audit(this.db, { actor: args.reviewerUserId, action: 'recommendation.approval_blocked_stale_evidence', entityKind: 'recommendation', entityId: rec.id, revision: rec.revision });
      return { ok: false, status: 409, reason: 'evidence_stale_revalidate_first' };
    }
    const [contact] = await this.db.select().from(t.contacts).where(eq(t.contacts.id, req.contactId));
    const [lastInbound] = await this.db.select().from(t.messages).where(and(eq(t.messages.conversationId, req.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(desc(t.messages.receivedAt)).limit(1);
    await this.db.update(t.recommendations).set({ reviewStatus: 'approved', reviewerUserId: args.reviewerUserId, reviewNote: args.note, approvedAt: now }).where(eq(t.recommendations.id, rec.id));
    const containsFixture = obs.some((o) => o.verificationMethod === 'fixture');
    const intent = await this.queueSend({ messageClass: obs.length ? 'recommendation' : 'no_result', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact!.emailOriginal, subject: reSubject(lastInbound?.subject ?? null, rec.subject), template: 'raw', vars: { text: rec.bodyText, html: rec.bodyHtml }, inReplyTo: lastInbound?.rfcMessageId ?? null, approvalId: rec.id, approvedHash: rec.draftHash, dedupeKey: `rec:${rec.id}:${rec.draftHash}`, containsFixtureData: containsFixture });
    await audit(this.db, { actor: args.reviewerUserId, action: 'recommendation.approved', entityKind: 'recommendation', entityId: rec.id, revision: rec.revision, diff: { draftHash: rec.draftHash, observationIds: rec.chosenObservationIds } });
    return { ok: true, sendIntentId: intent.id };
  }

  async revalidateRecommendation(args: { recommendationId: string; staffUserId: string }): Promise<{ refreshed: number; unavailable: number }> {
    const now = this.now();
    const [rec] = await this.db.select().from(t.recommendations).where(eq(t.recommendations.id, args.recommendationId));
    if (!rec) throw new Error('not found');
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, rec.requestId));
    const obs = rec.chosenObservationIds.length ? await this.db.select({ o: t.offerObservations, off: t.offers }).from(t.offerObservations).innerJoin(t.offers, eq(t.offers.id, t.offerObservations.offerId)).where(inArray(t.offerObservations.id, rec.chosenObservationIds)) : [];
    const configs = await this.db.select().from(t.adapterConfigs);
    let refreshed = 0;
    let unavailable = 0;
    for (const { o, off } of obs) {
      const cfg = configs.find((c) => c.sourceId === off.sourceId);
      const adapter = buildAdapter({ sourceId: off.sourceId, implementation: (cfg?.implementation as AdapterActivation['implementation']) ?? 'not_integrated', enabled: cfg?.enabled ?? false, accessApprovalEvidence: null, monitoringAllowed: false }, { fixtureOffers: this.deps.fixtureOffers ?? {}, fixtureBehavior: this.deps.fixtureBehavior, ticketmasterKey: null, ticketmasterEnabled: false, now: this.now });
      const fixtureId = (o.evidence as { evidenceId?: string } | null)?.evidenceId;
      const r = await adapter.revalidate(o.verificationMethod === 'fixture' && fixtureId ? (this.deps.fixtureOffers?.[o.eventId] ?? []).find((f) => f.evidenceId === fixtureId)?.id ?? '' : off.providerListingId ?? '', { requestId: req!.id, revision: req!.currentRevision, eventId: o.eventId, providerEventId: null, quantity: o.quantity, hardConstraints: {} });
      if (r.status === 'success' && r.offers[0]) {
        await this.db.update(t.offerObservations).set({ fetchedAt: now, payableTotalCents: r.offers[0].payableTotalCents, availability: 'available' }).where(eq(t.offerObservations.id, o.id));
        refreshed += 1;
      } else {
        unavailable += 1;
        await this.db.update(t.offerObservations).set({ availability: r.status === 'no_matching_inventory' ? 'unavailable' : 'unknown' }).where(eq(t.offerObservations.id, o.id));
      }
    }
    await audit(this.db, { actor: args.staffUserId, action: 'recommendation.revalidated', entityKind: 'recommendation', entityId: rec.id, diff: { refreshed, unavailable } });
    return { refreshed, unavailable };
  }

  // ---------------------------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------------------------
  async queueSend(a: { messageClass: MessageClass; contactId: string; conversationId: string; requestId: string | null; revision: number | null; recipient: string; subject: string; template: string; vars: Record<string, unknown>; inReplyTo: string | null; approvalId: string | null; approvedHash: string | null; dedupeKey?: string; containsFixtureData?: boolean }): Promise<{ id: string; created: boolean }> {
    // Loaded per send, never cached: staff copy must take effect at the next send, like the kill switches.
    const [overrides, brand] = await Promise.all([loadActiveTemplates(this.db), loadBrandSignature(this.db)]);
    // The full signature introduces us once per conversation; after that a thread signs "— Ticket Guy".
    // Blocked and suppressed intents never reached the customer, so they do not count as the introduction.
    const [prior] = await this.db.select({ n: sql<number>`count(*)::int` }).from(t.sendIntents).where(and(eq(t.sendIntents.conversationId, a.conversationId), sql`${t.sendIntents.state} not in ('blocked', 'suppressed', 'failed')`));
    const signature = (prior?.n ?? 0) === 0 ? 'full' : 'short';
    const rendered = renderTemplate(a.template, a.vars, { appUrl: this.env.APP_URL, postalAddress: this.env.BUSINESS_POSTAL_ADDRESS ?? null, overrides, signature, brand });
    const headers: Record<string, string> = { 'Reply-To': this.env.CONCIERGE_FROM_ADDRESS };
    if (a.inReplyTo) {
      headers['In-Reply-To'] = a.inReplyTo;
      const priorRefs = await this.db.select({ r: t.messages.referencesHeader }).from(t.messages).where(eq(t.messages.rfcMessageId, a.inReplyTo));
      headers['References'] = buildReferencesChain([...(priorRefs[0]?.r ?? '').matchAll(/<[^<>\s]+>/g)].map((m) => m[0]), a.inReplyTo);
    }
    if (a.containsFixtureData) headers['X-TicketGuy-Fixture'] = 'true';
    return await this.db.transaction(async (tx) => {
      const r = await createSendIntent(tx, { dedupeKey: a.dedupeKey ?? `${a.messageClass}:${a.requestId ?? a.conversationId}:${a.revision ?? 0}:${sha(rendered.text).slice(0, 12)}`, messageClass: a.messageClass, contactId: a.contactId, conversationId: a.conversationId, requestId: a.requestId, requestRevision: a.revision, approvalId: a.approvalId, approvedHash: a.approvedHash, recipient: a.recipient, fromAddress: `Ticket Guy <${this.env.messageClassFromAddresses[a.messageClass]}>`, subject: a.subject, bodyText: rendered.text, bodyHtml: rendered.html, headers });
      if (r.created) await enqueueOutbox(tx, { eventType: 'email.send_requested', eventKey: `send:${r.id}`, entityId: r.id, payload: { sendIntentId: r.id }, now: this.now() });
      return r;
    });
  }

  /** Dispatcher: claim → gate (current state) → provider → record. Never sends fixture content; never resends blindly. */
  async dispatchSend(sendIntentId: string): Promise<{ outcome: 'sent' | 'blocked' | 'suppressed' | 'uncertain' | 'already_handled' | 'manual_reconciliation'; reasons?: string[] }> {
    const now = this.now();
    const [intent] = await this.db.select().from(t.sendIntents).where(eq(t.sendIntents.id, sendIntentId));
    if (!intent) throw new Error('send intent not found');
    if (intent.state === 'uncertain') {
      if (uncertainRetryDecision({ firstSubmittedAt: intent.submittedAt ?? intent.claimedAt, now }) === 'manual_reconciliation') return { outcome: 'manual_reconciliation' };
      await this.db.update(t.sendIntents).set({ state: 'queued' }).where(and(eq(t.sendIntents.id, intent.id), eq(t.sendIntents.state, 'uncertain')));
    }
    const claim = await claimSendIntent(this.db, sendIntentId, now);
    if (!claim) return { outcome: 'already_handled' };

    const [switches, suppressed] = await Promise.all([loadSwitches(this.db), loadSuppressionScopes(this.db, normalizeEmailLookup(intent.recipient))]);
    let revisionCurrent = true;
    let evidenceFresh = true;
    let containsFixture = intent.headers['X-TicketGuy-Fixture'] === 'true';
    let marketingPermission = false;
    let approved = intent.approvalId !== null;
    let hashMatches = true;
    if (intent.requestId && intent.requestRevision !== null) {
      const [req] = await this.db.select({ rev: t.requests.currentRevision, eventId: t.requests.eventId }).from(t.requests).where(eq(t.requests.id, intent.requestId));
      revisionCurrent = req?.rev === intent.requestRevision;
      if (intent.approvalId) {
        const [rec] = await this.db.select().from(t.recommendations).where(eq(t.recommendations.id, intent.approvalId));
        approved = rec?.reviewStatus === 'approved';
        hashMatches = rec?.draftHash === intent.approvedHash;
        if (rec && req?.eventId) {
          const [event] = await this.db.select().from(t.events).where(eq(t.events.id, req.eventId));
          const obs = rec.chosenObservationIds.length ? await this.db.select().from(t.offerObservations).where(inArray(t.offerObservations.id, rec.chosenObservationIds)) : [];
          evidenceFresh = obs.every((o) => checkFreshness({ fetchedAt: o.fetchedAt, sourceAsOf: o.sourceAsOf, eventStartAt: event!.localStartAt, now }).fresh);
          containsFixture = containsFixture || obs.some((o) => o.verificationMethod === 'fixture');
        }
      }
    }
    if (intent.messageClass === 'marketing' && intent.contactId) {
      const [perm] = await this.db.select().from(t.marketingPermissions).where(and(eq(t.marketingPermissions.contactId, intent.contactId), eq(t.marketingPermissions.status, 'granted'))).orderBy(desc(t.marketingPermissions.createdAt)).limit(1);
      const [rev] = await this.db.select().from(t.marketingPermissions).where(and(eq(t.marketingPermissions.contactId, intent.contactId), eq(t.marketingPermissions.status, 'revoked'))).orderBy(desc(t.marketingPermissions.createdAt)).limit(1);
      marketingPermission = !!perm && (!rev || rev.createdAt < perm.createdAt);
    }
    const gate = evaluateGate(this.env, switches, suppressed, { messageClass: intent.messageClass as MessageClass, recipientLookup: normalizeEmailLookup(intent.recipient), containsFixtureData: containsFixture, approved, approvalHashMatches: hashMatches, revisionCurrent, evidenceFresh, marketingPermission });
    if (!gate.allowed) {
      const suppressedOnly = gate.reasons.every((r) => r.startsWith('suppressed'));
      await releaseClaim(this.db, claim, suppressedOnly ? 'suppressed' : 'blocked', gate.reasons.join(','));
      await audit(this.db, { actor: 'system', action: 'send.blocked', entityKind: 'send_intent', entityId: intent.id, diff: { reasons: gate.reasons, messageClass: intent.messageClass } });
      return { outcome: suppressedOnly ? 'suppressed' : 'blocked', reasons: gate.reasons };
    }
    if (!this.deps.emailProvider) {
      await releaseClaim(this.db, claim, 'blocked', 'no_email_provider_configured');
      return { outcome: 'blocked', reasons: ['no_email_provider_configured'] };
    }
    try {
      const r = await this.deps.emailProvider.send({ idempotencyKey: intent.dedupeKey, from: intent.fromAddress, to: intent.recipient, subject: intent.subject, text: intent.bodyText, html: intent.bodyHtml, headers: intent.headers });
      await recordProviderAccepted(this.db, claim, r.providerMessageId, now);
      await this.db.insert(t.messages).values({ conversationId: intent.conversationId!, direction: 'outbound', provider: 'resend', providerEmailId: r.providerMessageId, rfcMessageId: null, inReplyTo: intent.headers['In-Reply-To'] ?? null, referencesHeader: intent.headers['References'] ?? null, fromAddress: intent.fromAddress, toAddresses: [intent.recipient], subject: intent.subject, sanitizedText: intent.bodyText, receivedAt: now }).onConflictDoNothing();
      if (intent.approvalId) {
        await this.db.update(t.recommendations).set({ reviewStatus: 'sent' }).where(eq(t.recommendations.id, intent.approvalId));
        if (intent.requestId) await this.transition(intent.requestId, 'recommendation_sent', 'approved_recommendation_sent');
      }
      return { outcome: 'sent' };
    } catch (e) {
      // A17: the provider may have accepted; keep the same key/payload for any retry, and mark uncertain.
      await releaseClaim(this.db, claim, 'uncertain', e instanceof Error ? e.message : String(e));
      await audit(this.db, { actor: 'system', action: 'send.uncertain', entityKind: 'send_intent', entityId: intent.id });
      return { outcome: 'uncertain' };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Watches
  // ---------------------------------------------------------------------------------------------
  private async maybeCreateWatch(a: { requestId: string; revision: number; contactId: string; eventId: string; eventStartAt: Date; brief: RequestExtraction; consentMessageId: string }): Promise<string | null> {
    const now = this.now();
    const target = wholePartyBudgetCents(a.brief.budgetCents, a.brief.budgetBasis, a.brief.quantity);
    if (target === null || !a.brief.quantity) return null; // budget is required for a target-price watch → clarification already asked via ambiguities path
    const active = await this.db.select({ n: sql<number>`count(*)::int` }).from(t.watches).where(and(eq(t.watches.contactId, a.contactId), eq(t.watches.state, 'active')));
    if ((active[0]?.n ?? 0) >= WATCH_MAX_ACTIVE_PER_CONTACT) return null;
    const cadence = cadenceMinutes(a.eventStartAt, now, { lastMinuteApproved: false });
    if (cadence === null) return null;
    // A watch needs a seller we may check on a schedule. Without one it could never alert, yet it showed as
    // "active" to staff until it expired; the customer is already told we are not monitoring automatically.
    const configs = await this.db.select({ enabled: t.adapterConfigs.enabled, monitoringAllowed: t.adapterConfigs.monitoringAllowed }).from(t.adapterConfigs);
    if (!configs.some((c) => c.enabled && c.monitoringAllowed)) {
      await audit(this.db, { actor: 'system', action: 'watch.not_created', entityKind: 'request', entityId: a.requestId, diff: { reason: 'no_monitoring_coverage' } });
      return null;
    }
    const [w] = await this.db.insert(t.watches).values({ requestId: a.requestId, revision: a.revision, contactId: a.contactId, eventId: a.eventId, quantity: a.brief.quantity, targetTotalCents: target, togetherRequired: a.brief.togetherRequired ?? true, consentMessageId: a.consentMessageId, cadenceMinutes: cadence, nextCheckAt: new Date(now.getTime() + cadence * 60_000), expiresAt: watchExpiry({ now, eventStartAt: a.eventStartAt, purchaseDeadline: a.brief.decisionDeadline ? new Date(a.brief.decisionDeadline) : null }) }).returning({ id: t.watches.id });
    await audit(this.db, { actor: 'system', action: 'watch.created', entityKind: 'watch', entityId: w!.id, diff: { consentMessageId: a.consentMessageId, targetTotalCents: target } });
    return w!.id;
  }

  /** Deterministic due-watch evaluation; never invokes a model. */
  async evaluateDueWatches(limit = 20): Promise<{ evaluated: number; alertsCreated: number }> {
    const now = this.now();
    const due = await this.db.select().from(t.watches).where(and(eq(t.watches.state, 'active'), lte(t.watches.nextCheckAt, now))).orderBy(asc(t.watches.nextCheckAt)).limit(limit);
    let alerts = 0;
    const configs = await this.db.select().from(t.adapterConfigs);
    for (const w of due) {
      if (w.expiresAt <= now) {
        await this.db.update(t.watches).set({ state: 'expired' }).where(eq(t.watches.id, w.id));
        continue;
      }
      const [event] = await this.db.select().from(t.events).where(eq(t.events.id, w.eventId));
      const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, w.requestId));
      if (!event || !req || req.currentRevision !== w.revision) {
        await this.db.update(t.watches).set({ state: 'paused' }).where(eq(t.watches.id, w.id));
        continue;
      }
      const offers: Offer[] = [];
      for (const cfg of configs.filter((c) => c.enabled && c.monitoringAllowed)) {
        const adapter = buildAdapter({ sourceId: cfg.sourceId, implementation: cfg.implementation as AdapterActivation['implementation'], enabled: true, accessApprovalEvidence: cfg.accessApprovalEvidence, monitoringAllowed: true }, { fixtureOffers: this.deps.fixtureOffers ?? {}, fixtureBehavior: this.deps.fixtureBehavior, ticketmasterKey: null, ticketmasterEnabled: false, now: this.now });
        const r = await adapter.search({ requestId: w.requestId, revision: w.revision, eventId: w.eventId, providerEventId: null, quantity: w.quantity, hardConstraints: {} });
        offers.push(...r.offers);
      }
      const cmp = compareOffers(offers, { quantity: w.quantity, togetherRequired: w.togetherRequired, budgetTotalCents: w.targetTotalCents, excludeObstructedView: true, requireAccessible: false, acceptableSections: w.acceptableSections, eventStartAt: event.localStartAt.toISOString() }, w.eventId);
      const best = cmp.eligible[0];
      if (best && best.comparableTotalCents !== null) {
        const key = alertDedupeKey({ watchId: w.id, generation: w.generation, offerIdentity: `${best.offer.sourceId}:${best.offer.providerListingId ?? best.offer.section ?? 'x'}:${best.offer.row ?? ''}`, totalCents: best.comparableTotalCents });
        const [existing] = await this.db.select({ id: t.watchAlerts.id }).from(t.watchAlerts).where(eq(t.watchAlerts.dedupeKey, key));
        const recent = await this.db.select({ n: sql<number>`count(*)::int`, last: sql<number | null>`min(payable_total_cents)` }).from(t.watchAlerts).where(and(eq(t.watchAlerts.watchId, w.id), eq(t.watchAlerts.generation, w.generation), gte(t.watchAlerts.createdAt, new Date(now.getTime() - 86_400_000))));
        const fresh = checkFreshness({ fetchedAt: new Date(best.offer.observedAt), sourceAsOf: best.offer.providerUpdatedAt ? new Date(best.offer.providerUpdatedAt) : null, eventStartAt: event.localStartAt, now }).fresh;
        const d = shouldAlert({ targetTotalCents: w.targetTotalCents, candidateTotalCents: best.comparableTotalCents, candidateVerified: best.offer.priceCompleteness === 'verified_total', candidateFresh: fresh, lastAlertedTotalCents: recent[0]?.last ?? null, alertsInLast24h: recent[0]?.n ?? 0, dedupeKeyExists: !!existing });
        if (d.alert) {
          const [offerRow] = await this.db.insert(t.offers).values({ sourceId: best.offer.sourceId, providerListingId: best.offer.providerListingId, eventId: w.eventId, directPurchaseUrl: best.offer.directPurchaseUrl }).returning({ id: t.offers.id });
          const [obs] = await this.db.insert(t.offerObservations).values({ offerId: offerRow!.id, eventId: w.eventId, quantity: best.offer.quantity, section: best.offer.section, rowLabel: best.offer.row, seatsTogether: best.offer.seatsTogether, admissionType: best.offer.admissionType, payableTotalCents: best.comparableTotalCents, baseTotalCents: best.offer.baseTotalCents, mandatoryFeeTotalCents: best.offer.mandatoryFeeTotalCents, taxTotalCents: best.offer.taxTotalCents, deliveryTotalCents: best.offer.deliveryTotalCents, priceCompleteness: best.offer.priceCompleteness, restrictions: best.offer.restrictions, deliveryMethod: best.offer.deliveryMethod, availability: best.offer.availability, verificationMethod: best.offer.collectionMode, fetchedAt: new Date(best.offer.observedAt), retentionUntil: new Date(now.getTime() + OBSERVATION_RETENTION_DAYS * 86_400_000), evidence: { evidenceId: best.offer.evidenceId } }).returning({ id: t.offerObservations.id });
          await this.db.insert(t.watchAlerts).values({ watchId: w.id, generation: w.generation, observationId: obs!.id, dedupeKey: key, payableTotalCents: best.comparableTotalCents, approvalState: 'pending' }).onConflictDoNothing();
          alerts += 1;
        }
      }
      await this.db.update(t.watches).set({ nextCheckAt: new Date(now.getTime() + w.cadenceMinutes * 60_000 + Math.floor(Math.random() * 60_000)) }).where(eq(t.watches.id, w.id));
    }
    return { evaluated: due.length, alertsCreated: alerts };
  }

  /** Staff approval of a watch alert creates a gated send intent; cancellation observed at dispatch time wins (A26). */
  async approveWatchAlert(args: { alertId: string; reviewerUserId: string }): Promise<{ ok: boolean; reason?: string; sendIntentId?: string }> {
    const [alert] = await this.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.id, args.alertId));
    if (!alert || alert.approvalState !== 'pending') return { ok: false, reason: 'not_pending' };
    const [w] = await this.db.select().from(t.watches).where(eq(t.watches.id, alert.watchId));
    if (!w || w.state !== 'active' || w.generation !== alert.generation) {
      await this.db.update(t.watchAlerts).set({ approvalState: 'invalidated' }).where(eq(t.watchAlerts.id, alert.id));
      return { ok: false, reason: 'watch_not_active_or_generation_changed' };
    }
    const [contact] = await this.db.select().from(t.contacts).where(eq(t.contacts.id, w.contactId));
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, w.requestId));
    const [obs] = await this.db.select({ o: t.offerObservations, off: t.offers }).from(t.offerObservations).innerJoin(t.offers, eq(t.offers.id, t.offerObservations.offerId)).where(eq(t.offerObservations.id, alert.observationId));
    const intent = await this.queueSend({ messageClass: 'watch_alert', contactId: contact!.id, conversationId: req!.conversationId, requestId: req!.id, revision: w.revision, recipient: contact!.emailOriginal, subject: `Ticket Guy alert: ${w.quantity} for ${formatUsd(alert.payableTotalCents)} total`, template: 'watch_alert', vars: { totalCents: alert.payableTotalCents, quantity: w.quantity, url: obs!.off.directPurchaseUrl, observedAt: obs!.o.fetchedAt.toISOString(), section: obs!.o.section }, inReplyTo: null, approvalId: alert.id, approvedHash: null, dedupeKey: `alert:${alert.dedupeKey}`, containsFixtureData: obs!.o.verificationMethod === 'fixture' });
    await this.db.update(t.watchAlerts).set({ approvalState: 'approved', sendIntentId: intent.id }).where(eq(t.watchAlerts.id, alert.id));
    await audit(this.db, { actor: args.reviewerUserId, action: 'watch_alert.approved', entityKind: 'watch_alert', entityId: alert.id });
    return { ok: true, sendIntentId: intent.id };
  }

  async cancelWatch(args: { watchId: string; actor: string; reason: string }): Promise<void> {
    await this.db.update(t.watches).set({ state: 'cancelled', generation: sql`${t.watches.generation} + 1` }).where(eq(t.watches.id, args.watchId));
    // Any queued (not yet provider-accepted) alert sends for this watch are blocked; accepted ones cannot be recalled.
    const alerts = await this.db.select({ sendIntentId: t.watchAlerts.sendIntentId }).from(t.watchAlerts).where(eq(t.watchAlerts.watchId, args.watchId));
    const ids = alerts.map((a) => a.sendIntentId).filter((x): x is string => !!x);
    if (ids.length) await this.db.update(t.sendIntents).set({ state: 'blocked', lastError: 'watch_cancelled' }).where(and(inArray(t.sendIntents.id, ids), eq(t.sendIntents.state, 'queued')));
    await audit(this.db, { actor: args.actor, action: 'watch.cancelled', entityKind: 'watch', entityId: args.watchId, diff: { reason: args.reason } });
  }
}

// -------------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------------
export function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function reSubject(original: string | null, fallback: string): string {
  if (original && original.trim()) return /^re:/i.test(original.trim()) ? original.trim() : `Re: ${original.trim()}`;
  return fallback;
}

/** A possible match offered back to the customer: enough to ask the one question that separates them. */
export type EventCandidate = { id: string; label: string; entityName: string; league: string | null; name: string; venueName: string; isHome: boolean | null; when: string };

function candidateFrom(entity: { name: string; league: string | null }, e: { id: string; name: string; localStartAt: Date; isHome: boolean | null }, v: { name: string; timezone: string }, label: string): EventCandidate {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(e.localStartAt);
  return { id: e.id, label, entityName: entity.name, league: entity.league, name: e.name, venueName: v.name, isHome: e.isHome, when };
}

/**
 * The single question that separates the candidates, asked the way a person would. Two teams → which team.
 * Home and away games in the window → home at the venue, or would they travel. A few games → name them. More
 * than that → ask for the date. It never lists more than three events and never claims availability.
 */
export function decisiveEventQuestion(cands: EventCandidate[], x: RequestExtraction): string {
  const who = x.performerOrTeam ? titleCaseName(x.performerOrTeam) : null;
  const teams = [...new Map(cands.map((c) => [c.entityName, c])).values()];
  if (teams.length > 1) {
    const names = teams.map((c) => `the ${c.entityName}${c.league ? ` (${c.league})` : ''}`);
    return `Which ${who ?? 'one'} do you mean: ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}?`;
  }
  const home = cands.filter((c) => c.isHome === true);
  const away = cands.filter((c) => c.isHome === false);
  if (home.length && away.length) return `Are you looking for a home game at ${home[0]!.venueName}, or are away games an option? Send a date or ticket link if you have one.`;
  if (cands.length <= 3) {
    // A team plays a game against someone; an artist plays a show somewhere. "Which game: Fri, Oct 2 (Jack White)"
    // named the performer the customer had just named and called a concert a game.
    const isGame = cands.some((c) => c.league);
    const opts = cands.map((c) => (isGame ? `${c.when} (${c.name})` : `${c.when} at ${c.venueName}`));
    return `Which ${isGame ? 'game' : 'show'}: ${opts.slice(0, -1).join(', ')} or ${opts[opts.length - 1]}?`;
  }
  return 'Which date are you looking at? Send a date or ticket link if you have one.';
}

const QTY_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** One sentence playing back the request — "Two Rangers tickets next week, up to $200 total—got it." */
export function acknowledgementLine(x: RequestExtraction): string {
  const who = x.performerOrTeam ? titleCaseName(x.performerOrTeam) : null;
  const n = x.quantity;
  if (!who && !n) return 'Thanks for getting in touch.';
  const count = n ? (QTY_WORDS[n] ?? String(n)) : null;
  const noun = n === 1 ? 'ticket' : 'tickets';
  // "Two Rangers tickets" reads naturally; "Two Rangers vs Lightning tickets" does not, so a game takes "for".
  const isGame = !!who && splitMatchup(who) !== null;
  let line = isGame ? [count, noun].filter(Boolean).join(' ') : [count, who, noun].filter(Boolean).join(' ');
  line = line[0]!.toUpperCase() + line.slice(1);
  if (x.togetherRequired) line += ' together';
  if (isGame) line += ` for ${who}`;
  if (x.dateExpression && !/^\d{4}-\d{2}-\d{2}$/.test(x.dateExpression)) line += ` ${x.dateExpression}`;
  if (x.budgetCents !== null) line += x.budgetBasis ? `, up to ${formatUsd(x.budgetCents)} ${x.budgetBasis === 'whole_party' ? 'total' : 'each'}` : `, around ${formatUsd(x.budgetCents)}`;
  return `${line}. Got it.`;
}

export function eventLabel(e: { name: string; localStartAt: Date }, v: { name: string; city: string | null; timezone: string }): string {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(e.localStartAt);
  return `${e.name} at ${v.name}${v.city ? `, ${v.city}` : ''}, ${when}`;
}

/**
 * The seller behind an official event link, by host. Only the provider's own sale pages count: an https link
 * on a host we know, never an arbitrary URL passed through.
 */
export function officialSellerFor(url: string | null): string | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  const sellers: Array<[string, string]> = [['ticketmaster.com', 'Ticketmaster'], ['livenation.com', 'Live Nation'], ['ticketweb.com', 'TicketWeb'], ['universe.com', 'Universe'], ['frontgatetickets.com', 'Front Gate Tickets']];
  return sellers.find(([d]) => host === d || host.endsWith(`.${d}`))?.[1] ?? null;
}

/** "Sun, Oct 11 at 1pm" — how a person writes a date and time in an email; the day alone when the time is TBA. */
export function shortWhen(at: Date, tz: string, timeTba: boolean): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(at);
  if (timeTba) return day;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(at);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const ampm = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return `${day} at ${hour}${minute === '00' ? '' : `:${minute}`}${ampm}`;
}

/** Model ambiguities that a resolved event answers: which team by that name, and which city. */
const SETTLED_BY_RESOLUTION = ['performer_ambiguous', 'event_location_unknown'];

/** How often an alert with nothing more specific to wait for is checked, and how long a new-date alert lives. */
const EVENT_ALERT_CHECK_HOURS = 24;
const NEW_DATE_ALERT_DAYS = 180;

/** Check just after the published sale time, and at least daily in case it moves. */
function nextOnSaleCheck(opens: Date | null, now: Date): Date {
  const daily = new Date(now.getTime() + EVENT_ALERT_CHECK_HOURS * 3_600_000);
  if (!opens) return daily;
  const justAfter = new Date(opens.getTime() + 2 * 60_000);
  return justAfter < daily ? justAfter : daily;
}

/** "Fri, Oct 2 at 10:00 am ET"-style, in the venue's zone. */
function saleOpensLabel(at: Date, tz: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at);
  return `${day} at ${time}`;
}

/**
 * The team a New York customer means by a shared nickname: named for the market ("New York Giants",
 * "Brooklyn Nets", "New Jersey Devils"), or at home in one of its venues in the games found.
 */
export function isLocalTeam(entity: { name: string }, cands: Array<{ e: { isHome: boolean | null }; v: { city: string | null; latitude?: number | null; longitude?: number | null } }>, market: Market): boolean {
  if (market.teamNames.test(entity.name.trim())) return true;
  return cands.some(({ e, v }) => e.isHome === true && inMarket(v, market));
}

/** "Also 6 more performances through Sat, Oct 10." — the rest of a run, said once on its pick. */
function runNote(run: { moreDates: number; lastDay: string | null } | undefined, category: string): string | null {
  if (!run?.moreDates || !run.lastDay) return null;
  if (run.moreDates === 1) return `Also ${spanLabel(run.lastDay, run.lastDay)}.`;
  const what = ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer'].includes(category) ? 'games' : ['broadway', 'touring_theater'].includes(category) ? 'performances' : 'dates';
  return `Also ${run.moreDates} more ${what} through ${spanLabel(run.lastDay, run.lastDay)}.`;
}

/** SQL prefilter for venues in a market: inside its bounding box, or in one of its cities. inMarket refines it. */
function marketFilter(market: Market) {
  const byCity = inArray(sql`lower(coalesce(${t.venues.city}, ''))`, market.cities.length ? market.cities : ['']);
  if (market.lat === null || market.lng === null) return byCity;
  const dLat = market.radiusMiles / 69;
  const dLng = market.radiusMiles / (69 * Math.cos((market.lat * Math.PI) / 180));
  return or(and(gte(t.venues.latitude, market.lat - dLat), lte(t.venues.latitude, market.lat + dLat), gte(t.venues.longitude, market.lng - dLng), lte(t.venues.longitude, market.lng + dLng)), byCity);
}

export function basketKeyFor(eventId: string, quantity: number, seatClass: string | null): string {
  return sha(`${eventId}|q=${quantity}|class=${seatClass ?? 'any'}|fees=verified_total`).slice(0, 24);
}

/** Later statements override earlier ones only when they carry a value; established facts are kept. */
export function mergeExtraction(prior: RequestExtraction, next: RequestExtraction): RequestExtraction {
  const out: RequestExtraction = { ...prior };
  for (const k of Object.keys(next) as Array<keyof RequestExtraction>) {
    const v = next[k];
    if (k === 'evidence' || k === 'submittedUrls' || k === 'negatedEntities') (out as Record<string, unknown>)[k] = [...(prior[k] as unknown[]), ...(v as unknown[])];
    else if (k === 'ambiguities') out.ambiguities = next.ambiguities;
    else if (k === 'intent') out.intent = next.intent === 'clarification' ? prior.intent : next.intent;
    else if (k === 'wantsMore') out.wantsMore = next.wantsMore; // about this message's list, never the next one's
    else if (k === 'notifyAsked') out.notifyAsked = next.notifyAsked; // this message's ask; a later reply must not re-arm a cancelled or sent alert
    else if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * What we understood, one line each. Once the event is resolved the email already names it exactly, so the
 * customer's own looser wording ("Miami Dolphins in Miami (in october)") is left out rather than repeated.
 */
export function describeKnown(x: RequestExtraction, opts: { eventResolved?: boolean } = {}): string[] {
  const parts: string[] = [];
  if (x.performerOrTeam && !opts.eventResolved) parts.push(`Event: ${x.performerOrTeam}${x.city ? ` in ${x.city}` : ''}${x.dateExpression ? ` (${x.dateExpression})` : ''}`);
  if (x.quantity) parts.push(`Tickets: ${x.quantity}${x.togetherRequired ? ', together' : ''}`);
  if (x.budgetCents !== null && x.budgetBasis) parts.push(`Budget: ${formatUsd(x.budgetCents)} ${x.budgetBasis === 'whole_party' ? 'total' : 'per ticket'}`);
  return parts;
}

function observationToOffer(obs: typeof t.offerObservations.$inferSelect, off: typeof t.offers.$inferSelect): Offer {
  const ev = (obs.evidence ?? {}) as { seatClass?: string | null };
  return {
    id: obs.id,
    sourceId: off.sourceId,
    providerListingId: off.providerListingId,
    eventId: obs.eventId,
    observedAt: obs.fetchedAt.toISOString(),
    providerUpdatedAt: obs.sourceAsOf?.toISOString() ?? null,
    expiresAt: null,
    quantity: obs.quantity,
    currency: 'USD',
    baseTotalCents: obs.baseTotalCents,
    mandatoryFeeTotalCents: obs.mandatoryFeeTotalCents,
    taxTotalCents: obs.taxTotalCents,
    deliveryTotalCents: obs.deliveryTotalCents,
    payableTotalCents: obs.payableTotalCents,
    priceCompleteness: obs.priceCompleteness as Offer['priceCompleteness'],
    section: obs.section,
    row: obs.rowLabel,
    seatNumbers: obs.seatNumbers,
    seatsTogether: obs.seatsTogether,
    admissionType: obs.admissionType as Offer['admissionType'],
    restrictions: obs.restrictions,
    deliveryMethod: obs.deliveryMethod,
    expectedDeliveryAt: obs.expectedDeliveryAt?.toISOString() ?? null,
    directPurchaseUrl: off.directPurchaseUrl,
    affiliateUrl: off.affiliateUrl,
    evidenceId: obs.id,
    collectionMode: obs.verificationMethod as Offer['collectionMode'],
    availability: obs.availability as Offer['availability'],
    seatClass: ev.seatClass ?? null,
  };
}

/** Tickets assumed when the customer does not say: the most common party, and cheap to correct. */
export const DEFAULT_QUANTITY = 2;

/**
 * Fills the two gaps that used to cost a round trip. Nothing is filled when the customer signalled doubt
 * ("a few tickets" sets quantity_unclear), and a stated value is never replaced. Returns what was assumed
 * so the reply can say it; the stored brief carries the value, so a later "actually four" overrides it.
 */
export function applyDefaults(x: RequestExtraction): { brief: RequestExtraction; assumed: Array<'quantity' | 'budget_basis'> } {
  const assumed: Array<'quantity' | 'budget_basis'> = [];
  let brief = x;
  if (brief.quantity === null && !brief.ambiguities.includes('quantity_unclear')) {
    brief = { ...brief, quantity: DEFAULT_QUANTITY };
    assumed.push('quantity');
  }
  if (brief.budgetCents !== null && brief.budgetBasis === null) {
    brief = { ...brief, budgetBasis: 'whole_party', ambiguities: brief.ambiguities.filter((a) => a !== 'budget_basis_unknown') };
    // One ticket has no difference between each and total, so there is nothing to say.
    if ((brief.quantity ?? 1) > 1) assumed.push('budget_basis');
  }
  return { brief, assumed };
}

export function assumptionLines(assumed: Array<'quantity' | 'budget_basis'>, x: RequestExtraction): string[] {
  const lines: string[] = [];
  if (assumed.includes('quantity')) lines.push(`I've assumed ${QTY_WORDS[DEFAULT_QUANTITY]?.toLowerCase() ?? DEFAULT_QUANTITY} tickets. Just tell me if you need a different number.`);
  if (assumed.includes('budget_basis') && x.budgetCents !== null) {
    const n = x.quantity ?? DEFAULT_QUANTITY;
    lines.push(`I've read ${formatUsd(x.budgetCents)} as the total for ${n === 2 ? 'both' : `all ${n}`}. Tell me if you meant per ticket.`);
  }
  return lines;
}

/** Why a request is waiting on a person, in words for the staff alert. */
export function staffReasonLabel(reason: string): string {
  if (reason === 'clarification_limit_reached') return 'three rounds of questions did not settle the request';
  if (reason.startsWith('extraction_failed:budget_exceeded')) return 'the AI budget for this request ran out';
  if (reason.startsWith('extraction_failed:')) return `the AI could not read the message (${reason.split(':')[1] ?? 'unknown'})`;
  return reason.split(':')[0]!.replace(/_/g, ' ');
}

/** "9am–9pm ET" from the staffed-hours settings, for the holding reply. */
export function staffedHoursLabel(e: { STAFFED_HOURS_START: number; STAFFED_HOURS_END: number; STAFFED_HOURS_TIMEZONE: string }): string {
  const h = (n: number) => (n === 0 || n === 24 ? '12am' : n === 12 ? '12pm' : n < 12 ? `${n}am` : `${n - 12}pm`);
  const zone = e.STAFFED_HOURS_TIMEZONE === 'America/New_York' ? 'ET' : e.STAFFED_HOURS_TIMEZONE;
  return `${h(e.STAFFED_HOURS_START)} to ${h(e.STAFFED_HOURS_END)} ${zone}`;
}
