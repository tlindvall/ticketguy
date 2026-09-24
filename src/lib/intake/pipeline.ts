import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
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
import type { Drafter } from '@/lib/ai/drafting';
import { AMBIGUITY_KINDS, RequestExtractionSchema, type HardConstraints, type Offer, type RequestExtraction, type SourceResult } from '@/lib/domain/types';
import { wholePartyBudgetCents, formatUsd } from '@/lib/domain/money';
import { eventLocalDate, monthWindowFor } from '@/lib/domain/dates';
import { compareOffers, independentOptionCount, type Evaluated } from '@/lib/domain/comparison';
import { checkFreshness } from '@/lib/domain/freshness';
import { deriveInterestObservations } from '@/lib/domain/interests';
import { classifyOptOutText, revokeMarketing, stopAll } from '@/lib/domain/suppression';
import { sourcePlan } from '@/lib/sources/routing';
import { buildAdapter, type AdapterActivation, type TicketSourceAdapter } from '@/lib/sources/adapters';
import { computeBenchmark, type HistoricalSnapshot, type DatasetRights, type EventContext, type BenchmarkResult } from '@/lib/advice/benchmark';
import { computeTrend, type TrendResult } from '@/lib/advice/trend';
import { decide, type CustomerPriorities } from '@/lib/advice/policy';
import { buildPacket, packetHash } from '@/lib/advice/packet';
import { validateAndRender, renderEvidenceOnly } from '@/lib/advice/renderer';
import { createSendIntent, claimSendIntent, releaseClaim, recordProviderAccepted, uncertainRetryDecision } from '@/lib/email/send-intents';
import { evaluateGate, loadSwitches, loadSuppressionScopes, type MessageClass } from '@/lib/email/send-gate';
import { renderTemplate } from '@/lib/email/templates';
import { loadActiveTemplates } from '@/lib/email/template-store';
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
};

export type IngestOutcome = { kind: 'stored_auto_response'; messageId: string } | { kind: 'ignored_recipient'; messageId: string } | { kind: 'duplicate'; messageId: string } | { kind: 'queued'; messageId: string; conversationId: string; requestId: string; contactId: string; isNewConversation: boolean };

const RAW_RETENTION_DAYS = 30;
const OBSERVATION_RETENTION_DAYS = 90;

type NoMatchReason = 'no_performer' | 'unknown_performer' | 'no_scheduled_event';

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
      const openStates = ['received', 'interpreting', 'needs_clarification', 'resolving_event', 'researching', 'awaiting_review', 'recommendation_sent', 'monitoring', 'manual_attention'];
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
        await this.transition(req.id, 'manual_attention', reason.slice(0, 500));
        return { state: 'manual_attention', revision: req.currentRevision, extraction: null };
      }
      throw e;
    }

    // Merge with prior revision when this is a follow-up (never re-ask established facts).
    const merged = priorVersion ? mergeExtraction(RequestExtractionSchema.parse(priorVersion.brief), extraction) : extraction;

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
      await audit(this.db, { actor: 'customer', action: 'watch.cancelled_by_customer', entityKind: 'contact', entityId: contact!.id, diff: { messageId: msg.id } });
    }

    // New revision.
    const revision = priorVersion ? req.currentRevision + 1 : 1;
    if (extraction.countryStatement) {
      const isUs = /\b(us|usa|united states|america)\b/i.test(extraction.countryStatement);
      await this.db.update(t.contacts).set({ countryConfirmed: isUs ? 'US' : 'NON_US' }).where(eq(t.contacts.id, contact!.id));
      await this.db.update(t.requests).set({ countryConfirmed: isUs ? 'US' : 'NON_US' }).where(eq(t.requests.id, req.id));
      if (!isUs) {
        await this.db.insert(t.requestVersions).values({ requestId: req.id, revision, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: [], createdBy: 'system' });
        await this.db.update(t.requests).set({ currentRevision: revision }).where(eq(t.requests.id, req.id));
        await this.transition(req.id, 'unsupported', 'customer_outside_us');
        await this.queueSend({ messageClass: 'no_result', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Ticket Guy is US-only for now'), template: 'unsupported', vars: { reason: 'We currently serve US customers and US events only.' }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
        return { state: 'unsupported', revision, extraction: merged };
      }
    }

    // Event resolution.
    const resolution = await this.resolveEvent(merged);
    const eventResolved = resolution.kind === 'resolved';
    const missing = missingMandatoryFields(merged, { eventResolved });
    const unresolved = [...missing, ...(resolution.kind === 'ambiguous' ? ['event_ambiguous'] : []), ...merged.ambiguities];

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

    if (unresolved.some((u) => CLARIFIABLE.includes(u))) {
      const count = req.clarificationCount + 1;
      if (count > 3) {
        await this.db.update(t.requests).set({ clarificationCount: count }).where(eq(t.requests.id, req.id));
        await this.transition(req.id, 'manual_attention', 'clarification_limit_reached');
        return { state: 'manual_attention', revision, extraction: merged };
      }
      const qMissing = [...missing];
      if (resolution.kind === 'ambiguous') qMissing.unshift('event');
      if (merged.ambiguities.includes('date_near_midnight') && !qMissing.includes('event')) qMissing.unshift('event');
      if (!contact!.countryConfirmed && qMissing.length < 3) qMissing.push('country');
      const questions = clarificationQuestions([...new Set(qMissing)], merged);
      const knownFacts = describeKnown(merged);
      const eventNote = resolution.kind === 'no_match' ? noMatchNote(resolution.reason, merged) : resolution.kind === 'ambiguous' ? `We found ${resolution.candidates.length} possible matches: ${resolution.candidates.map((c) => c.label).join('; ')}.` : null;
      await this.db.update(t.requests).set({ clarificationCount: count }).where(eq(t.requests.id, req.id));
      await this.transition(req.id, 'needs_clarification', unresolved.join(','));
      await this.queueSend({ messageClass: 'clarification', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'A couple of quick questions'), template: 'clarification', vars: { knownFacts, questions, eventNote }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
      return { state: 'needs_clarification', revision, extraction: merged };
    }

    if (resolution.kind !== 'resolved') throw new Error('unreachable');
    await this.transition(req.id, 'researching', 'brief_complete');
    if (revision === 1) {
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Got it — checking your options'), template: 'acknowledgment', vars: { knownFacts: describeKnown(merged), eventLabel: resolution.label, countryUnconfirmed: !contact!.countryConfirmed }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
    }
    await this.db.transaction((tx) => enqueueOutbox(tx, { eventType: 'research.requested', eventKey: `research:${req.id}:${revision}`, entityId: req.id, revision, payload: { requestId: req.id, revision }, now }));

    if (merged.intent === 'watch_request') await this.maybeCreateWatch({ requestId: req.id, revision, contactId: contact!.id, eventId: resolution.event.id, eventStartAt: resolution.event.localStartAt, brief: merged, consentMessageId: msg.id });
    return { state: 'researching', revision, extraction: merged };
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

  async transition(requestId: string, toState: string, reason: string, actor = 'system'): Promise<void> {
    const [r] = await this.db.select({ state: t.requests.state, rev: t.requests.currentRevision }).from(t.requests).where(eq(t.requests.id, requestId));
    await this.db.update(t.requests).set({ state: toState, updatedAt: this.now(), failureReason: toState === 'failed' || toState === 'unsupported' ? reason : null }).where(eq(t.requests.id, requestId));
    await this.db.insert(t.requestTransitions).values({ requestId, fromState: r?.state ?? null, toState, revision: r?.rev ?? 1, actor, reason });
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
  async resolveEvent(x: RequestExtraction): Promise<{ kind: 'resolved'; event: typeof t.events.$inferSelect; venue: typeof t.venues.$inferSelect; label: string; entityKind: 'artist' | 'team' | null } | { kind: 'ambiguous'; candidates: Array<{ id: string; label: string }> } | { kind: 'no_match'; reason: NoMatchReason } | { kind: 'non_us' }> {
    if (!x.performerOrTeam) return { kind: 'no_match', reason: 'no_performer' };
    const [entity] = await this.db.select().from(t.entities).where(sql`lower(${t.entities.name}) = ${x.performerOrTeam.toLowerCase()}`);
    // Not on file at all is a different fact from on file with nothing scheduled, and the customer is told
    // which: claiming we searched listings we do not have is a claim about our own diligence.
    if (!entity) return { kind: 'no_match', reason: 'unknown_performer' };
    const now = this.now();
    const rows = await this.db.select({ e: t.events, v: t.venues }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(and(eq(t.events.primaryEntityId, entity.id), gte(t.events.localStartAt, now), eq(t.events.status, 'scheduled'))).orderBy(asc(t.events.localStartAt)).limit(20);
    let cands = rows;
    if (x.resolvedLocalDate) {
      cands = cands.filter(({ e, v }) => eventLocalDate(e.localStartAt, v.timezone) === x.resolvedLocalDate);
    } else if (x.dateExpression) {
      // A month named without a day still rules events out. Ignoring it let a request for November
      // bind silently to the only October event on file, and every downstream claim inherited that event.
      const win = monthWindowFor(x.dateExpression, now);
      if (win) {
        cands = cands.filter(({ e, v }) => {
          const d = eventLocalDate(e.localStartAt, v.timezone);
          return d >= win.from && d <= win.to;
        });
      }
    }
    if (x.city) cands = cands.filter(({ v }) => (v.city ?? '').toLowerCase() === x.city!.toLowerCase());
    if (cands.length === 0) return { kind: 'no_match', reason: 'no_scheduled_event' };
    if (cands.length > 1) return { kind: 'ambiguous', candidates: cands.slice(0, 5).map(({ e, v }) => ({ id: e.id, label: eventLabel(e, v) })) };
    const { e, v } = cands[0]!;
    if (v.country !== 'US') return { kind: 'non_us' };
    return { kind: 'resolved', event: e, venue: v, label: eventLabel(e, v), entityKind: entity.kind === 'team' ? 'team' : 'artist' };
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
    const policy = decide({ now, eventStartAt: event.localStartAt, offers: { bestEligibleTotalCents: best?.comparableTotalCents ?? null, bestEligibleObservationId: best?.offer.id ?? null, eligibleCount: cmp.eligible.length, needsReviewCount: cmp.needsReview.length, alternativeAvailable: alternatives.length > 0 || cmp.needsReview.length > 0, deliveryFeasible: best ? (best.offer.deliveryMethod ? true : null) : null, safeDeliveryBufferMinutes: null }, benchmark, trend, priorities, monitoringCoverageAvailable: monitoringCoverage, staffedUntil: null });

    const isFixtureRun = allOffers.some((o) => o.collectionMode === 'fixture') || this.env.APP_MODE === 'fixture';
    const packet = buildPacket({ requestId: req.id, revision: args.revision, quantity, eventLabel: eventLabel(event, venue), best, alternatives, entryReference: entryRef, benchmark, benchmarkRunId, trend, trendRunId, policy, priorities, sourcesChecked: checked, sourcesUnavailable: unavailable, independentOptionCount: independentOptionCount(cmp), observedAt: now, evidenceExpiresAt: new Date(now.getTime() + 15 * 60_000), basketKey, watchConsentReference: brief.intent === 'watch_request' ? version!.sourceMessageIds[0] ?? null : null, isFixture: isFixtureRun });
    const hash = packetHash(packet);
    const [adviceRun] = await this.db.insert(t.adviceRuns).values({ requestId: req.id, revision: args.revision, benchmarkRunId, trendRunId, verifiedOfferObservationIds: packet.verifiedOfferObservationIds, customerPriorities: packet.customerPriorities, policyVersion: policy.policyVersion, decision: policy.decision, reasonCodes: policy.reasonCodes, abstentions: policy.abstentions, nextCheckpointAt: policy.nextCheckpointAt, stopConditions: policy.stopConditions, packet: packet as unknown as Record<string, unknown>, packetHash: hash, evidenceExpiresAt: new Date(now.getTime() + 15 * 60_000) }).returning({ id: t.adviceRuns.id });

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
          const v = validateAndRender(packet, blocks);
          if (v.ok) body = { textBody: v.textBody, htmlBody: v.htmlBody };
          else draftNote = `draft rejected: ${v.errors.join('; ')}`;
        } else {
          const blocks = await this.deps.drafter.draft(packet, { quantity, mustAttend: brief.mustAttend, waitRiskTolerance: brief.waitRiskTolerance, togetherRequired: brief.togetherRequired });
          const v = validateAndRender(packet, blocks);
          if (v.ok) body = { textBody: v.textBody, htmlBody: v.htmlBody };
          else draftNote = `draft rejected: ${v.errors.join('; ')}`;
        }
      } catch (e) {
        draftNote = `draft failed: ${e instanceof Error ? e.message : String(e)}`;
        if (e instanceof BudgetExceededError) break;
      }
    }
    if (!body) body = renderEvidenceOnly(packet);

    const isNoResult = !best && alternatives.length === 0;
    const subject = isNoResult ? `Ticket Guy: what we found for ${eventLabel(event, venue)}` : `Ticket Guy: ${quantity} for ${event.name}`;
    const draftHash = sha(body.textBody + body.htmlBody);
    const [rec] = await this.db.insert(t.recommendations).values({ requestId: req.id, revision: args.revision, draftHash, chosenObservationIds: packet.verifiedOfferObservationIds, adviceRunId: adviceRun!.id, computedSavingsCents: null, bodyText: body.textBody, bodyHtml: body.htmlBody, subject, reviewStatus: 'pending', reviewNote: [draftNote, isFixtureRun ? 'FIXTURE DATA — cannot be sent' : null, contact?.countryConfirmed ? null : 'customer country unconfirmed'].filter(Boolean).join(' | ') || null, expiresAt: new Date(now.getTime() + 15 * 60_000) }).returning({ id: t.recommendations.id });
    await this.db.update(t.researchRuns).set({ status: 'completed', completedAt: now }).where(eq(t.researchRuns.id, runId));
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
    const overrides = await loadActiveTemplates(this.db);
    const rendered = renderTemplate(a.template, a.vars, { appUrl: this.env.APP_URL, postalAddress: this.env.BUSINESS_POSTAL_ADDRESS ?? null, overrides });
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

export function eventLabel(e: { name: string; localStartAt: Date }, v: { name: string; city: string | null; timezone: string }): string {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(e.localStartAt);
  return `${e.name} — ${v.name}${v.city ? `, ${v.city}` : ''} — ${when}`;
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
    else if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function describeKnown(x: RequestExtraction): string[] {
  const parts: string[] = [];
  if (x.performerOrTeam) parts.push(`Event: ${x.performerOrTeam}${x.city ? ` in ${x.city}` : ''}${x.dateExpression ? ` (${x.dateExpression})` : ''}`);
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
