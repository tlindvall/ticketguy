import { concertBudget, concertQuestion, similarMusicGoal } from '@/lib/advice/concert-terms';
import { noDashes } from '@/lib/email/punctuation';
import { headerFirstName, statedFirstName } from '@/lib/domain/names';
import { MARKETPLACE_NAMES, ticketLinksIn } from '@/lib/domain/ticket-links';
import { problemTypesFor } from '@/lib/domain/problem-types';
import { classifyOutcomeReply } from '@/lib/domain/outcome-replies';
import { OFF_TOPIC_REPLY_EVERY_HOURS, isOffTopic, overInboundLimit } from './boundaries';
import { raPointer } from '@/lib/sources/resident-advisor';
import { and, asc, desc, eq, gte, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import type { Env } from '@/lib/config/env';
import type { NormalizedInbound } from './contract';
import { detectAutoResponse } from './autoreply';
import { normalizeEmailLookup, resolveThread, stripQuotedContent, buildReferencesChain, normalizeMessageId } from './threading';
import { enqueueOutbox } from './outbox';
import { inspectImage, selectProcessableImages } from '@/lib/media/image-validation';
import { createMediaStore } from '@/lib/media/storage';
import { fieldsFromRead, looksLikeListingText, usableListing, type ListingFields, type ListingImage, type ListingReader } from '@/lib/ai/listing-evidence';
import { audit } from '@/lib/util/audit';
import { type Extractor, FixtureExtractor, missingMandatoryFields, clarificationQuestions, titleCaseName, NO_ACCESS_NEED, readDate } from '@/lib/ai/extraction';
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
import { asksAboutOptOut, classifyOptOutText, revokeMarketing, stopAll } from '@/lib/domain/suppression';
import { sourcePlan } from '@/lib/sources/routing';
import { buildAdapter, TicketmasterDiscoveryAdapter, type AdapterActivation, type TicketSourceAdapter } from '@/lib/sources/adapters';
import { MarketTracker, marketForGroup, marketLicence, marketUses } from '@/lib/market/tracker';
import { findAlternatives } from '@/lib/market/alternatives';
import { syncFromDiscovery, NON_ADMISSION_SUBTYPES, isNonGameName, DISCOVERY_SOURCE_ID } from '@/lib/catalog/sync';
import { exploreLink, sellerLink, type EmailLink } from '@/lib/email/links';
import { geohash, inMarket, isOutsideUs, marketById, marketFor, milesBetween, teamHomeMarket, type Market } from '@/lib/domain/markets';
import { normalizePlace, stateCodeFor, stateOnly, US_STATES } from '@/lib/domain/us-states';
import { cleanSeatField, flat, offerHistory, offersInText, partyTerms, sameOffer, statedFeeBasis, timeLabel, type TextOffer } from '@/lib/advice/text-offers';
import { breaks, eventConstraints, unglue, type EventConstraints } from '@/lib/domain/event-constraints';
import { suppliedOffersAnswer } from '@/lib/advice/packet';
import { computeBenchmark, type HistoricalSnapshot, type DatasetRights, type EventContext, type BenchmarkResult } from '@/lib/advice/benchmark';
import { computeTrend, type TrendResult } from '@/lib/advice/trend';
import { decide, type CustomerPriorities } from '@/lib/advice/policy';
import { buildPacket, packetHash, type QuotedPrice, type SubjectListing } from '@/lib/advice/packet';
import { validateAndRender, renderEvidenceOnly } from '@/lib/advice/renderer';
import { createSendIntent, claimSendIntent, releaseClaim, recordProviderAccepted, uncertainRetryDecision } from '@/lib/email/send-intents';
import { evaluateGate, loadSwitches, loadSuppressionScopes, type MessageClass } from '@/lib/email/send-gate';
import { capturedIds, isTestConversation, testConversationIds, testModeFrom, TEST_PROVIDER } from '@/lib/email/test-mode';
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
  /** Reads the listing a customer shows us (screenshot or pasted text). Absent: stored, never read. */
  listingReader?: ListingReader;
};

export type IngestOutcome = { kind: 'stored_auto_response'; messageId: string } | { kind: 'ignored_recipient'; messageId: string } | { kind: 'duplicate'; messageId: string } | { kind: 'queued'; messageId: string; conversationId: string; requestId: string; contactId: string; isNewConversation: boolean };

const RAW_RETENTION_DAYS = 30;
const OBSERVATION_RETENTION_DAYS = 90;

type NoMatchReason = 'no_performer' | 'unknown_performer' | 'no_scheduled_event' | 'discovery_no_results' | 'constraint_conflict';

/** The customer's rules on which event they mean (event-constraints.ts), plus the event ids their links carry. */
export type ResolveRules = EventConstraints & { linkedEventIds: string[] };
/** Events that matched the name and date but break one of their rules, and the nearest one that doesn't. */
export type ConstraintConflict = {
  label: string;
  why: string;
  dateNamed: boolean;
  /** The next event that keeps every rule but the date. */
  suggestion: { event: typeof t.events.$inferSelect; venue: typeof t.venues.$inferSelect; label: string } | null;
  /** Against the opponent they named, when that is a different event: "they do play the 76ers at MSG, on Oct 20". */
  sameOpponent?: { event: typeof t.events.$inferSelect; venue: typeof t.venues.$inferSelect; label: string } | null;
};

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
  // "on Fri, Oct 2" when we know the day, not 'for "Friday"'.
  const when = brief.resolvedLocalDate ? ` on ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${brief.resolvedLocalDate}T12:00:00Z`))}` : brief.dateExpression ? ` for "${brief.dateExpression}"` : '';
  const where = brief.city ? ` in ${brief.city}` : stateOnly(brief) ? ` in ${US_STATES[stateOnly(brief)!]}` : '';
  if (reason === 'no_performer') return null; // nothing was named; the questions carry it
  if (reason === 'unknown_performer') return `We don't have ${who ?? 'that performer or team'} in our event list yet, so we haven't looked at any prices.`;
  // This one is earned: the official listings were actually queried for this name and window.
  if (reason === 'discovery_no_results') return `We checked the official listings and couldn't find a scheduled ${who ?? 'matching'} event${where}${when}, so we haven't looked at prices yet.`;
  return `We don't have a scheduled ${who ?? 'matching'} event${where}${when} on file, so we haven't looked at prices yet.`;
}

/** Who approves a draft when review is off during testing; its emails carry the automated disclosure. */
export const AUTO_APPROVER = 'system:auto-approve';

/** Drafts approve themselves while only named testers can be emailed (env AUTO_APPROVE_WHILE_TESTING). */
export function autoApproveActive(e: Pick<Env, 'AUTO_APPROVE_WHILE_TESTING' | 'EMAIL_TEST_RECIPIENT_ALLOWLIST'>): boolean {
  return e.AUTO_APPROVE_WHILE_TESTING && e.EMAIL_TEST_RECIPIENT_ALLOWLIST.length > 0;
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
      // "Tobias here" beats the account name; a name they give later replaces the one we had.
      const stated = statedFirstName(msg.text);
      const fromHeader = headerFirstName(msg.fromName);
      if (!contactId) {
        const [c] = await tx.insert(t.contacts).values({ emailOriginal: msg.from, emailLookup: senderLookup, lastInboundAt: now, firstName: stated ?? fromHeader }).returning({ id: t.contacts.id });
        contactId = c!.id;
      } else {
        await tx.update(t.contacts).set({ lastInboundAt: now, ...(stated ? { firstName: stated } : !existingContact!.firstName && fromHeader ? { firstName: fromHeader } : {}) }).where(eq(t.contacts.id, contactId));
      }

      // Thread resolution with participant authorization (A20).
      const refs = await (async () => {
        const ids = [msg.inReplyTo, msg.references].filter((x): x is string => !!x).flatMap((x) => [...x.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]));
        if (!ids.length) return new Map<string, { conversationId: string; contactEmailLookup: string; rfcMessageId: string }>();
        // Messages stored before IDs were normalised may hold them without brackets.
        const lookupIds = [...ids, ...ids.map((id) => id.slice(1, -1))];
        const rows = await tx.select({ conversationId: t.messages.conversationId, rfc: t.messages.rfcMessageId, providerRfc: t.sendIntents.providerRfcMessageId, email: t.contacts.emailLookup }).from(t.messages).innerJoin(t.conversations, eq(t.conversations.id, t.messages.conversationId)).innerJoin(t.contacts, eq(t.contacts.id, t.conversations.contactId)).leftJoin(t.sendIntents, eq(t.sendIntents.conversationId, t.conversations.id)).where(inArray(t.messages.rfcMessageId, lookupIds));
        const m = new Map<string, { conversationId: string; contactEmailLookup: string; rfcMessageId: string }>();
        for (const r of rows) if (r.rfc) m.set(normalizeMessageId(r.rfc)!, { conversationId: r.conversationId, contactEmailLookup: r.email, rfcMessageId: r.rfc });
        // Outbound provider-assigned Message-IDs are also valid anchors.
        const outbound = await tx.select({ conversationId: t.sendIntents.conversationId, rfc: t.sendIntents.providerRfcMessageId, email: t.contacts.emailLookup }).from(t.sendIntents).innerJoin(t.contacts, eq(t.contacts.id, t.sendIntents.contactId)).where(inArray(t.sendIntents.providerRfcMessageId, lookupIds));
        for (const r of outbound) if (r.rfc && r.conversationId) m.set(normalizeMessageId(r.rfc)!, { conversationId: r.conversationId, contactEmailLookup: r.email, rfcMessageId: r.rfc });
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
      for (const u of msg.unretrieved ?? []) await tx.insert(t.attachments).values({ messageId, providerAttachmentId: u.id, filename: u.filename, declaredMimeType: u.declaredMimeType, detectedMimeType: null, byteLength: null, mediaId: null, validationState: 'rejected', validationReason: `not_retrieved:${u.reason}`, purgeAt: new Date(now.getTime() + RAW_RETENTION_DAYS * 86_400_000) });

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

    // A sender over the inbound limits gets no model call and no reply until the window passes; staff hear once a day.
    // The addresses on the test allowlist are ours, testing on purpose, and are not held to them.
    const tester = !!contact && this.env.EMAIL_TEST_RECIPIENT_ALLOWLIST.map((a) => a.trim().toLowerCase()).includes(contact.emailLookup);
    // A cancellation, opt-out or deletion is never held behind the limit: "stop watching" must work on the
    // busiest day (TG-B06).
    // Three a day at most, so "cancel" in every email is not a way round the limit.
    let stopping = false;
    if (contact && (STOP_WORDS.test(msg.sanitizedText ?? '') || classifyOptOutText(msg.sanitizedText ?? '') !== null)) {
      const [used] = await this.db.select({ n: sql<number>`count(*)::int` }).from(t.auditLog).where(and(eq(t.auditLog.action, 'intake.limit_skipped_for_stop'), eq(t.auditLog.entityKind, 'contact'), eq(t.auditLog.entityId, contact.id), gte(t.auditLog.createdAt, new Date(msg.receivedAt.getTime() - 86_400_000))));
      stopping = (used?.n ?? 0) < 3;
      if (stopping) await audit(this.db, { actor: 'system', action: 'intake.limit_skipped_for_stop', entityKind: 'contact', entityId: contact.id, diff: { at: msg.receivedAt.toISOString(), messageId: msg.id } });
    }
    if (contact && !tester && !stopping) {
      const over = await this.inboundLimitHit(contact.id, msg);
      if (over) {
        const told = await this.recentAudit('intake.rate_limited', contact.id, msg.receivedAt, 24);
        await audit(this.db, { actor: 'system', action: 'intake.rate_limited', entityKind: 'contact', entityId: contact.id, diff: { at: msg.receivedAt.toISOString(), window: over, messageId: msg.id, staffTold: !told } });
        if (!told) {
          await this.transition(req.id, 'manual_attention', `rate_limited:${over}`);
          // The customer hears, once, that a person has it; the staff alert says so only when that is true.
          await this.queueSend({
            messageClass: 'acknowledgment', contactId: contact.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact.emailOriginal,
            subject: reSubject(msg.subject, 'A person is picking this up'), template: 'holding', vars: { hours: staffedHoursLabel(this.env) },
            inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `holding:${req.id}`,
          });
          await enqueueOutbox(this.db, { eventType: 'staff.alert', eventKey: `staff_alert:${req.id}:${req.currentRevision}:rate_limited`, entityId: req.id, payload: { requestId: req.id, revision: req.currentRevision }, now });
          return { state: 'manual_attention', revision: req.currentRevision, extraction: null };
        }
        return { state: req.state, revision: req.currentRevision, extraction: null };
      }
    }

    // A deletion they asked for is answered before anything else is read: "CONFIRM" verifies it, and a reply about
    // it gets its status, never a restarted ticket search (TGQA-R6 1013). No model call is made for either.
    if (contact) {
      const done = await this.pendingDeletionReply({ req, msg, contact });
      if (done) return done;
    }

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
    // The day they named, read without the model when the model left it open: "Monday October 5", "This coming
    // Friday", "knicks fri" (TGQA-R8 S03, S08). Its own words first, then the email's; in the venue's zone, else
    // the team's home venue or market, else the pilot market's. A day is only ever filled in, never changed.
    if (!extraction.resolvedLocalDate) {
      const team = extraction.performerOrTeam?.toLowerCase() ?? null;
      const entityHome = team ? entities.find(({ e }) => [e.name, ...e.aliases].some((n) => n.toLowerCase() === team))?.v : null;
      const tz = venueTz ?? entityHome?.timezone ?? (extraction.performerOrTeam ? teamHomeMarket(extraction.performerOrTeam)?.timezone : null) ?? marketById(this.env.DEFAULT_MARKET).timezone;
      const own = extraction.dateExpression ? readDate(unglue(extraction.dateExpression), msg.receivedAt, tz) : null;
      const read = own?.resolvedLocalDate ? own : !extraction.dateExpression ? readDate(unglue(msg.sanitizedText ?? ''), msg.receivedAt, tz) : null;
      // A weekday out of "Saturday or Sunday, not Monday" is a kind of day, not a date to pin.
      const source = own?.resolvedLocalDate ? extraction.dateExpression! : msg.sanitizedText ?? '';
      const kindOfDay = /^(?:this |next |on )?(?:sun|mon|tues|wednes|thurs|fri|satur)day$/i.test(read?.dateExpression?.trim() ?? '') && ((source.match(/\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?s?\b/gi)?.length ?? 0) >= 2 || /\bweekends?\b|\bany\s+(?:sun|mon|tue|wed|thu|fri|sat)/i.test(source));
      if (read?.resolvedLocalDate && !kindOfDay) extraction = { ...extraction, resolvedLocalDate: read.resolvedLocalDate, dateExpression: extraction.dateExpression ?? read.dateExpression, ambiguities: (extraction.ambiguities as string[]).filter((x) => !['date_venue_timezone_unknown', 'date_unsupported_expression'].includes(x)) as typeof extraction.ambiguities };
    }
    // "Connecticut" as the city is the state of Connecticut, not a town of that name.
    extraction = normalizePlace(extraction);
    // Deterministic guards over what either extractor read (audit replay A07-R1, A03): an explicit "cancel the
    // watch" is a cancellation, and "neither of us needs wheelchair seating" is no access need.
    const latestText = msg.sanitizedText ?? '';
    if (asksToCancelWatch(latestText)) extraction = { ...extraction, intent: 'cancel_watch' };
    if (extraction.accessibilityNeeds && NO_ACCESS_NEED.test(latestText)) extraction = { ...extraction, accessibilityNeeds: null };
    // An offer's price is not their budget: "Offer A: $90 per ticket" read as "Budget: $90 a ticket" ruled out
    // every offer they sent (post-#54 replay). A budget is kept only when it isn't one of their offers' prices.
    const latestOffers = offersInText(latestText);
    if (latestOffers.length >= 2 && extraction.budgetCents !== null && latestOffers.some((o) => o.perTicketCents === extraction.budgetCents || o.totalCents === extraction.budgetCents)) extraction = { ...extraction, budgetCents: null, budgetBasis: null, ambiguities: (extraction.ambiguities as string[]).filter((x) => !x.startsWith('budget_basis')) as typeof extraction.ambiguities };
    // Without a budget word, a price they quote from a listing or offer is that listing's price, not a budget:
    // "a listing … PARKING ONLY at $20 each" was read as "Budget: $20 a ticket" (live V03), and "Offer B … $210
    // total" as "up to $210" (live R05-F1).
    if (extraction.budgetCents !== null && !BUDGET_WORDS.test(latestText) && isListingPrice(flat(latestText), extraction.budgetCents, latestOffers)) extraction = { ...extraction, budgetCents: null, budgetBasis: null, ambiguities: (extraction.ambiguities as string[]).filter((x) => !x.startsWith('budget_basis')) as typeof extraction.ambiguities };
    // A follow-up about a listing we already read ("the image says $72 per ticket BEFORE fees…") is about that
    // listing's price: without budget words it sets no budget (live A11-F1 replay: $72 × 3 became "up to $216").
    if (priorVersion && extraction.budgetCents !== null && (priorVersion.brief as RequestExtraction).budgetCents !== extraction.budgetCents && !BUDGET_WORDS.test(latestText) && (await this.db.select({ id: t.listingEvidence.id }).from(t.listingEvidence).where(and(eq(t.listingEvidence.requestId, req.id), sql`${t.listingEvidence.fields} is not null`)).limit(1)).length) extraction = { ...extraction, budgetCents: null, budgetBasis: null, ambiguities: (extraction.ambiguities as string[]).filter((x) => !x.startsWith('budget_basis')) as typeof extraction.ambiguities };
    // "My BUDGET stayed $200": the same amount keeps the basis it had, and isn't asked about again (TGQA-R6 15).
    const priorBrief = priorVersion ? (priorVersion.brief as RequestExtraction) : null;
    if (priorBrief && extraction.budgetCents !== null && extraction.budgetCents === priorBrief.budgetCents && extraction.budgetBasis === null && priorBrief.budgetBasis) extraction = { ...extraction, budgetBasis: priorBrief.budgetBasis, ambiguities: (extraction.ambiguities as string[]).filter((x) => !x.startsWith('budget_basis')) as typeof extraction.ambiguities };
    // "$72 per ticket" is a price, not 72 tickets (live A11-F1 replay): a quantity that is one of the prices named.
    if (extraction.quantity !== null && new RegExp(`\\$\\s?${extraction.quantity}(?:\\.\\d{2})?\\b`).test(flat(latestText)) && !new RegExp(`\\b${extraction.quantity}\\s+(?:tickets?|seats?)\\b`, 'i').test(flat(latestText).replace(/\$\s?\d[\d,.]*/g, ''))) extraction = { ...extraction, quantity: null };
    // Likewise a quoted price: with offers side by side there is no single price they're asking about.
    if (latestOffers.length >= 2 && extraction.quotedPriceCents != null) extraction = { ...extraction, quotedPriceCents: null, quotedPriceBasis: null };

    // Music quotes often put the real budget after several product prices. Bind it to its own words.
    if (/\bconcert|festival|house night|entry|VIP|parking\b/i.test(latestText) && latestOffers.length) {
      const budget = concertBudget(latestText);
      if (budget) extraction = { ...extraction, budgetCents: budget.cents, budgetBasis: budget.basis ?? (priorBrief?.budgetCents === budget.cents ? priorBrief.budgetBasis : null), ambiguities: extraction.ambiguities.filter((x) => !x.startsWith('budget_basis')) };
    }

    // A pasted ticket link names the date, the party size and often the team, as surely as typed words do.
    extraction = applyTicketLinks(extraction, known);
    // So does the listing they show us: a screenshot, or listing text pasted into the email. What it showed is
    // kept as evidence; what it didn't show stays unknown.
    const listing = await this.readListingEvidence(msg, req);
    if (listing.fields) extraction = applyListingFields(extraction, listing.fields, known);
    const listingNotes = listing.redacted ? [REDACTED_NOTE] : [];
    // An image they sent (or say they attached) that we couldn't read is said plainly, and nothing is assumed
    // in its place: "Two tickets. Got it" to a screenshot of three was answering an email they didn't send
    // (post-#54 QA, R3-B09).
    const imageUnread = !listing.fields && !listing.redacted && (await this.unreadImage(msg, req.id));

    // A first message that isn't about tickets ("tell me something about New York", "are you an idiot?") gets
    // one short "I only do tickets" reply a day, and nothing is assumed about a request that isn't there.
    if (!priorVersion && !listing.images && !imageUnread && isOffTopic(extraction, msg.sanitizedText ?? '')) {
      const replied = await this.recentAudit('intake.off_topic_replied', contact!.id, msg.receivedAt, OFF_TOPIC_REPLY_EVERY_HOURS);
      if (!replied) {
        await this.queueSend({ messageClass: 'no_result', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Ticket Guy does tickets'), template: 'off_topic', vars: {}, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `off_topic:${req.id}` });
        await audit(this.db, { actor: 'system', action: 'intake.off_topic_replied', entityKind: 'contact', entityId: contact!.id, diff: { at: msg.receivedAt.toISOString(), messageId: msg.id } });
      } else {
        await audit(this.db, { actor: 'system', action: 'intake.off_topic_ignored', entityKind: 'contact', entityId: contact!.id, diff: { at: msg.receivedAt.toISOString(), messageId: msg.id } });
      }
      await this.transition(req.id, 'closed', replied ? 'off_topic_repeat' : 'off_topic');
      return { state: 'closed', revision: req.currentRevision, extraction };
    }

    // Merge with prior revision when this is a follow-up (never re-ask established facts).
    let merged = priorVersion ? mergeExtraction(RequestExtractionSchema.parse(priorVersion.brief), extraction) : extraction;
    if (similarMusicGoal(latestText)) merged = { ...merged, performerOrTeam: null, eventName: null, intent: 'browse', categoryHint: 'concert', genreHint: extraction.genreHint ?? (/\bpop\b/i.test(latestText) ? 'pop' : merged.genreHint), resolvedLocalDate: extraction.resolvedLocalDate, dateExpression: extraction.dateExpression, submittedUrls: extraction.submittedUrls };


    // Intents with side effects but no research. Their words decide, whatever the extractor read: "stop emailing me".
    const stopsOnFile = await this.db.select({ scope: t.suppressions.scope, at: t.suppressions.createdAt }).from(t.suppressions).where(eq(t.suppressions.emailLookup, contact!.emailLookup));
    // "Please confirm what you stopped" after an opt-out: its status, from what is stored (TGQA-R8 S09).
    const statusAsked = stopsOnFile.length > 0 && asksAboutOptOut(latestText);
    if (classifyOptOutText(latestText) || statusAsked) extraction = { ...extraction, intent: 'marketing_opt_out' };
    if (extraction.intent === 'marketing_opt_out') {
      const kind = classifyOptOutText(msg.sanitizedText ?? '') ?? (statusAsked && stopsOnFile.some((b) => b.scope === 'watch') ? 'stop_all' : 'unsubscribe_marketing');
      const before = stopsOnFile;
      const already = kind === 'stop_all' ? before.some((b) => b.scope === 'watch') && before.some((b) => b.scope === 'marketing') : before.some((b) => b.scope === 'marketing');
      const running = kind === 'stop_all' ? (await this.db.select({ id: t.watches.id }).from(t.watches).where(and(eq(t.watches.contactId, contact!.id), eq(t.watches.state, 'active')))).length + (await this.db.select({ id: t.eventAlerts.id }).from(t.eventAlerts).where(and(eq(t.eventAlerts.contactId, contact!.id), eq(t.eventAlerts.state, 'active')))).length : 0;
      if (kind === 'stop_all') await stopAll(this.db, { contactId: contact!.id, emailLookup: contact!.emailLookup, evidence: { messageId: msg.id } });
      else await revokeMarketing(this.db, { contactId: contact!.id, emailLookup: contact!.emailLookup, method: 'natural_language', evidence: { messageId: msg.id }, noticeVersion: 'n/a' });
      await audit(this.db, { actor: 'system', action: kind === 'stop_all' ? 'contact.stop_all' : 'contact.marketing_opt_out', entityKind: 'contact', entityId: contact!.id, diff: { messageId: msg.id, alreadyRecorded: already } });
      // One plain confirmation of what was recorded, from the stored state; asked again, the same answer, and
      // nothing starts up again (TGQA-R6 1014: two opt-outs went unanswered).
      const since = before.map((b) => b.at).sort((x, y) => x.getTime() - y.getTime())[0];
      const what = kind === 'stop_all' ? 'no ticket suggestions, no price-watch or event alerts, no follow-ups and no marketing' : 'no marketing emails';
      const line = already
        ? `Yes, that’s recorded${since ? ` (since ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(since)})` : ''}: this address gets ${what} from Ticket Guy.`
        : `Done: this address now gets ${what} from Ticket Guy.${running ? ` I’ve also stopped ${running === 1 ? 'the watch that was running' : `the ${running} watches and alerts that were running`}.` : ''}`;
      const tail = kind === 'stop_all' ? 'If you write to me about tickets again, I’ll answer that email and nothing more. Your past requests stay on file unless you ask me to delete them.' : 'Replies about requests you send me will still come.';
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Stopped'), template: 'raw_auto', vars: { text: ['Hey,', line, tail].join('\n\n'), html: [`<p style="margin:0 0 18px;">Hey,</p>`, `<p style="margin:0 0 18px;"><strong>${line}</strong></p>`, `<p style="margin:0 0 18px;">${tail}</p>`].join('\n') }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `opt_out:${msg.id}` });
      await this.transition(req.id, 'closed', kind === 'stop_all' ? 'customer_stopped_all' : 'opt_out_only');
      return { state: 'closed', revision: req.currentRevision, extraction };
    }
    if (extraction.intent === 'delete_data') {
      await this.db.insert(t.deletionLedger).values({ emailLookupHash: sha(contact!.emailLookup), contactId: contact!.id, requestedAt: now, actor: 'customer', scope: ['messages', 'attachments', 'requests', 'interests', 'watches'] });
      await this.queueSend({ messageClass: 'verification', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Confirm your deletion request'), template: 'deletion_verification', vars: {}, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
      await this.transition(req.id, 'manual_attention', 'deletion_requested_pending_verification');
      return { state: 'manual_attention', revision: req.currentRevision, extraction };
    }
    if (extraction.intent === 'cancel_watch') {
      // Only what this thread set up is stopped: another request's watch, and their email preferences, are
      // untouched. A "stop" in a thread of its own, with nothing set up in it, stops what they have running.
      const threadReqs = (await this.db.select({ id: t.requests.id }).from(t.requests).where(eq(t.requests.conversationId, req.conversationId))).map((r) => r.id);
      const inThread = (col: typeof t.watches.requestId | typeof t.eventAlerts.requestId) => inArray(col, threadReqs);
      const [wIn] = await this.db.select({ n: sql<number>`count(*)::int` }).from(t.watches).where(and(inThread(t.watches.requestId), eq(t.watches.state, 'active')));
      const [aIn] = await this.db.select({ n: sql<number>`count(*)::int` }).from(t.eventAlerts).where(and(inThread(t.eventAlerts.requestId), eq(t.eventAlerts.state, 'active')));
      // A reply in a thread (an earlier request there, even a closed one) is about that thread (retest R04).
      const scoped = (wIn?.n ?? 0) + (aIn?.n ?? 0) > 0 || !!priorVersion || threadReqs.length > 1;
      const watchScope = scoped ? inThread(t.watches.requestId) : eq(t.watches.contactId, contact!.id);
      const alertScope = scoped ? inThread(t.eventAlerts.requestId) : eq(t.eventAlerts.contactId, contact!.id);
      const stoppedWatches = await this.db.update(t.watches).set({ state: 'cancelled', generation: sql`${t.watches.generation} + 1` }).where(and(watchScope, eq(t.watches.state, 'active'))).returning({ id: t.watches.id });
      const stoppedAlerts = await this.db.update(t.eventAlerts).set({ state: 'cancelled' }).where(and(alertScope, eq(t.eventAlerts.state, 'active'))).returning({ id: t.eventAlerts.id });
      await this.stopWatchAlerts(stoppedWatches.map((w) => w.id));
      await audit(this.db, { actor: 'customer', action: 'watch.cancelled_by_customer', entityKind: 'contact', entityId: contact!.id, diff: { messageId: msg.id, scope: scoped ? 'thread' : 'contact', watches: stoppedWatches.length, alerts: stoppedAlerts.length } });
      // Always answered, from what was actually stored and changed (TG-B10): never silence, never a guess.
      const n = stoppedWatches.length + stoppedAlerts.length;
      const line = n
        ? `Done: I’ve stopped ${[stoppedWatches.length ? `${stoppedWatches.length === 1 ? 'the price watch' : `${stoppedWatches.length} price watches`}` : '', stoppedAlerts.length ? `${stoppedAlerts.length === 1 ? 'the event alert' : `${stoppedAlerts.length} event alerts`}` : ''].filter(Boolean).join(' and ')}${scoped ? ' on this request' : ''}. You won’t get any more alerts for ${n === 1 ? 'it' : 'them'}.`
        : `There was no active price watch or alert${scoped ? ' on this request' : ''}, so nothing was being monitored and there’s nothing to stop.`;
      const tail = 'Nothing else has changed: your other requests and your email preferences are as they were.';
      // Kept as a revision and an outcome, as any reply is: "stop, we bought them" is also a reported purchase.
      const rev = priorVersion ? req.currentRevision + 1 : 1;
      await this.db.insert(t.requestVersions).values({ requestId: req.id, revision: rev, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: [], createdBy: 'system' });
      await this.db.update(t.requests).set({ currentRevision: rev, updatedAt: now }).where(eq(t.requests.id, req.id));
      const said = classifyOutcomeReply(msg.sanitizedText ?? '');
      await this.db.insert(t.requestOutcomes).values([
        { requestId: req.id, kind: 'stop_watching', source: 'customer_reply', messageId: msg.id, details: { watches: stoppedWatches.length, alerts: stoppedAlerts.length }, actor: 'customer', at: msg.receivedAt },
        ...(said?.bought === true ? [{ requestId: req.id, kind: 'user_reported_purchase', source: 'customer_reply', messageId: msg.id, details: {}, actor: 'customer', at: msg.receivedAt }] : []),
      ]);
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: rev, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Stopped'), template: 'raw_auto', vars: { text: ['Hey,', line, tail].join('\n\n'), html: [`<p style="margin:0 0 18px;">Hey,</p>`, `<p style="margin:0 0 18px;">${line}</p>`, `<p style="margin:0 0 18px;">${tail}</p>`].join('\n') }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `cancel:${msg.id}` });
      // Stopping it ends what this request was waiting on: closed, as a customer's own stop.
      await this.transition(req.id, 'closed', said?.bought === true ? 'customer_bought' : 'customer_stopped');
      return { state: 'closed', revision: rev, extraction: merged };
    }

    // Already bought, and asking about getting in ("the seller sent a PDF screenshot of a mobile barcode"): entry
    // help, from the sources that say it, never an event search or more shopping (live G03).
    if (entryHelpAsked(latestText)) {
      const t0 = flat(latestText);
      const two = /\b(?:two|2)\s+(?:\w+\s+){0,3}(?:tickets?|seats?)\b/i.test(t0);
      const msg0 = /\b(?:msg|madison square garden)\b/i.test(t0);
      const TM_GUIDE = 'https://blog.ticketmaster.com/new-mobile-ticket-safety/';
      const MSG_GUIDE = 'https://assets.msg.com/uploads/2025/03/Mobile-Ticketing-Tutorial.pdf';
      const lead = 'Ask the seller for an official mobile transfer; don’t count on the PDF or screenshot of the barcode to get you in.';
      const why = 'Ticketmaster says screenshots aren’t valid for entry, and that someone who bought from another fan should get the tickets by official transfer.';
      const msgLine = msg0 ? 'Madison Square Garden’s mobile ticket guide shows how to accept a transferred ticket into your account and add it to your phone’s wallet.' : '';
      const next = `Next step: contact the seller or the marketplace’s support now and ask them to transfer ${two ? 'both tickets' : 'the tickets'} to your account. Once you’ve accepted it, check the event and ${two ? 'both seats' : 'your seats'} show there, then add them to your phone’s wallet.`;
      // An image of their barcode that came with it was deleted unread; they are told, and not asked to resend it.
      const deleted = listing.redacted ? 'The image you sent looked like it showed a barcode, so I deleted it without reading it. You don’t need to send it again.' : '';
      const text = ['Hey,', lead, `${why}\nTicketmaster’s guidance: ${TM_GUIDE}`, ...(msgLine ? [`${msgLine}\nMSG’s guide: ${MSG_GUIDE}`] : []), next, ...(deleted ? [deleted] : [])].join('\n\n');
      const P0 = (x: string) => `<p style="margin:0 0 18px;">${x}</p>`;
      const html = [P0('Hey,'), P0(`<strong>${lead}</strong>`), P0(`${why} <a href="${TM_GUIDE}">Read Ticketmaster’s guidance</a>.`), ...(msgLine ? [P0(`${msgLine} <a href="${MSG_GUIDE}">Open MSG’s mobile ticket guide</a>.`)] : []), P0(next), ...(deleted ? [P0(deleted)] : [])].join('\n');
      const rev = priorVersion ? req.currentRevision + 1 : 1;
      await this.db.insert(t.requestVersions).values({ requestId: req.id, revision: rev, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: [], createdBy: 'system' });
      await this.db.update(t.requests).set({ currentRevision: rev, updatedAt: now }).where(eq(t.requests.id, req.id));
      await this.db.insert(t.requestOutcomes).values({ requestId: req.id, kind: 'user_reported_purchase', source: 'customer_reply', messageId: msg.id, details: { entryHelp: true }, actor: 'customer', at: msg.receivedAt });
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: rev, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Getting in with your tickets'), template: 'raw_auto', vars: { text, html }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `entry_help:${msg.id}` });
      await this.transition(req.id, 'closed', 'post_purchase_help');
      return { state: 'closed', revision: rev, extraction: merged };
    }

    // A question outside tickets from someone who has theirs ("easy dinner spots near MSG? We already have the game
    // tickets"): said plainly that it isn't something we do, never a ticket search and never "glad you got them,
    // I've stopped watching" (TGQA-R6 1010).
    if (asksOutsideTickets(latestText)) {
      const venueWord = /\b(msg|madison square garden)\b/i.test(latestText) ? 'Madison Square Garden' : /\bbarclays\b/i.test(latestText) ? 'Barclays Center' : 'the venue';
      const line = `Restaurant and bar suggestions are outside what I do: I only help with tickets, so I don’t have anything reliable on places to eat near ${venueWord}.`;
      const tail = /\b(?:already|have|bought|got)\b[^.?!]{0,30}\btickets?\b/i.test(latestText) ? 'Enjoy the game.' : 'If you need tickets, tell me what you want to see, roughly when, and how many.';
      const rev = priorVersion ? req.currentRevision + 1 : 1;
      await this.db.insert(t.requestVersions).values({ requestId: req.id, revision: rev, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: [], createdBy: 'system' });
      await this.db.update(t.requests).set({ currentRevision: rev, updatedAt: now }).where(eq(t.requests.id, req.id));
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: rev, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Not something I do'), template: 'raw_auto', vars: { text: ['Hey,', line, tail].join('\n\n'), html: [`<p style="margin:0 0 18px;">Hey,</p>`, `<p style="margin:0 0 18px;">${line}</p>`, `<p style="margin:0 0 18px;">${tail}</p>`].join('\n') }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `outside:${msg.id}` });
      await this.transition(req.id, 'closed', 'outside_tickets');
      return { state: 'closed', revision: rev, extraction: merged };
    }

    // What they need help with, accumulated over the conversation (pilot measurement).
    const tags = problemTypesFor(extraction, msg.sanitizedText ?? '', { listing: !!listing.fields || listing.images > 0, link: ticketLinksIn(extraction.submittedUrls).length > 0 });
    const allTags = [...new Set([...(req.problemTypes ?? []), ...tags])];
    if (allTags.length !== (req.problemTypes ?? []).length) await this.db.update(t.requests).set({ problemTypes: allTags }).where(eq(t.requests.id, req.id));

    // How it ended: "I bought them", "stop watching", or the answer to our one follow-up. Recorded as the
    // customer's own report; a reply that brings something new (a link, a listing, a price, another event)
    // is a request and carries on below.
    if (priorVersion) {
      const done = await this.recordOutcomeReply({ req, msg, contact: contact!, extraction, prior: RequestExtractionSchema.parse(priorVersion.brief), listingSent: !!listing.fields || listing.images > 0 });
      if (done) return { state: done, revision: req.currentRevision, extraction };
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

    // Concert quote decisions run before discovery: entry and product terms need no catalog match.
    // Other unresolved offer questions retain the same comparison path (TGQA-R6 1006: "you don't need the event date to add these up").
    const threadTexts = (await this.db.select({ text: t.messages.sanitizedText }).from(t.messages).where(and(eq(t.messages.conversationId, req.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(asc(t.messages.receivedAt))).map((m) => m.text ?? '');
    const supplied = suppliedOffers(latestText, threadTexts, venueTz ?? 'America/New_York');
    const answerSupplied = async (recordVersion: boolean) => {
      const tz = venueTz ?? 'America/New_York';
      const terms = partyTerms(threadTexts, tz);
      const quantity = terms.attendees ?? merged.quantity ?? DEFAULT_QUANTITY;
      const threadFlat = flat(threadTexts.join('\n'));
      const comparison = suppliedOffersAnswer({
        offers: supplied.textOffers, quantity, offersSetAside: supplied.offersSetAside, accessibilityRequired: !!merged.accessibilityNeeds, timeZone: tz, observedAt: now,
        // Their budget, whatever words carried it ("$500 TOTAL including fees"), but never one of their offers' own
        // prices (TGQA-R6 13: "$162 of your $412 budget"; R8 S01: a bare "$500 TOTAL" was dropped and C at $520 won).
        budgetTotalCents: customerBudget(merged, threadTexts, quantity, tz),
        needs: { noObstructed: NO_OBSTRUCTED.test(`${threadFlat}\n${merged.seatingPreference ?? ''}`), togetherRequired: !!merged.togetherRequired, baseline: comparedAgainst(latestText, supplied.textOffers.map((o) => o.label)), terms },
      });
      const { lead } = comparison;
      const items = [...comparison.items];
      if (/\b(?:correct|mixed up|exclude)\b/i.test(latestText) && supplied.textOffers.some((o) => o.admission === 'excluded')) items.push('To be clear: the non-admission product cannot beat an admission ticket at any fee level. Disregard any earlier comparison that treated it as admission.');
      if (/\bRed Rocks\b/i.test(threadFlat) && /\bMorrison\b/i.test(threadFlat)) items.push('The location you supplied is Red Rocks in Morrison, rather than Denver.');
      const links = musicSourceLinks(threadTexts);
      const text = ['Hey,', lead, items.map((i) => `- ${i}`).join('\n'), ...links.map((url) => `Link you supplied: ${url}`)].join('\n\n');
      const first = /^(.+?[.!?])(\s|$)/.exec(lead)?.[1] ?? lead;
      const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const html = [`<p style="margin:0 0 18px;">Hey,</p>`, `<p style="margin:0 0 18px;"><strong>${esc(first)}</strong>${esc(lead.slice(first.length))}</p>`, `<ul style="margin:0 0 18px;padding-left:22px;">${items.map((i) => `<li style="margin:0 0 8px;">${esc(i)}</li>`).join('')}</ul>`, ...links.map((url) => `<p><a href="${esc(url)}">Link you supplied</a></p>`)].join('\n');
      if (recordVersion) {
        await this.db.insert(t.requestVersions).values({ requestId: req.id, revision, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: [], createdBy: 'system' });
        await this.db.update(t.requests).set({ currentRevision: revision, updatedAt: now }).where(eq(t.requests.id, req.id));
        if (revision > 1) await this.invalidateForRevision(req.id, revision);
      }
      await this.transition(req.id, 'recommendation_sent', 'supplied_offers_compared');
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Your offers compared'), template: 'raw_auto', vars: { text, html }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `offers:${msg.id}` });
      return { state: 'recommendation_sent', revision, extraction: merged };
    };
    const concert = concertQuestion(threadTexts);
    if (concert) {
      await this.db.insert(t.requestVersions).values({ requestId: req.id, revision, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: [], createdBy: 'system' });
      await this.db.update(t.requests).set({ currentRevision: revision, updatedAt: now }).where(eq(t.requests.id, req.id));
      if (revision > 1) await this.invalidateForRevision(req.id, revision);
      const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const links = musicSourceLinks([latestText]);
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Your concert question'), template: 'raw_auto', vars: { text: [concert.lead, ...concert.items, ...links.map((url) => `Link you supplied: ${url}`)].join('\n\n'), html: `<p><strong>${esc(concert.lead)}</strong></p>${concert.items.map((i) => `<p>${esc(i)}</p>`).join('')}${links.map((url) => `<p><a href="${esc(url)}">Link you supplied</a></p>`).join('')}` }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `concert:${msg.id}` });
      await this.transition(req.id, 'recommendation_sent', 'concert_terms_answered');
      return { state: 'recommendation_sent', revision, extraction: merged };
    }

    if (supplied.textOffers.length && partyTerms(threadTexts).concertAdmission) return answerSupplied(true);

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
    const { brief: withDefaults, assumed } = imageUnread ? { brief: merged, assumed: [] as Array<'quantity' | 'budget_basis'> } : applyDefaults(merged);
    merged = withDefaults;
    const assumptions = [...listingNotes, ...(pickNote ? [pickNote] : []), ...assumptionLines(assumed, merged)];

    // An event outside the US ("Hamilton in London, UK") is out of scope whatever the listings say: we say so
    // straight away, instead of searching US listings and reporting that we couldn't find it. A US state beside
    // the city ("London, KY") keeps it in scope.
    // A place named with its country ("Hamilton in London, UK") is abroad even when the extractor also caught
    // "not New York" as the city (audit replay A09). Only then, though: "my sister in London, UK recommended
    // Hamilton in New York" is a New York request, and where they live is the residence rule's business.
    // A non-US city that only appears as where someone lives or is ("my sister in London, UK") isn't the event's.
    if (merged.city && isOutsideUs(merged.city) && onlyAsWhereSomeoneIs(latestText, merged.city)) merged = { ...merged, city: null, state: null };
    const abroad = namedAbroadEvent(latestText, merged.city);
    if (!picked && (eventOutsideUs(merged) || abroad)) {
      await this.db.insert(t.requestVersions).values({ requestId: req.id, revision, brief: merged, sourceMessageIds: [msg.id], unresolvedFields: [], createdBy: 'system' });
      await this.db.update(t.requests).set({ currentRevision: revision, updatedAt: now }).where(eq(t.requests.id, req.id));
      await this.transition(req.id, 'unsupported', 'event_outside_us');
      await this.queueSend({ messageClass: 'no_result', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Ticket Guy is US-only for now'), template: 'unsupported', vars: { reason: `We only cover events in the US for now, so I can’t help with ${merged.performerOrTeam ? `${titleCaseName(merged.performerOrTeam)} in ` : ''}${abroad ? `${abroad[1]}, ${abroad[2]}` : placeName(merged)}.` }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
      return { state: 'unsupported', revision, extraction: merged };
    }

    // Their rules on which event, from the whole thread (venue, home only, time, days, "the next one"), the
    // performance their link or screenshot names, checked before any event is chosen (TGQA-R6 1001, 1007).
    const rules = await this.resolveRules(req, merged, venueTz, msg.receivedAt);
    // Event resolution (a browse that found exactly one event has already resolved it).
    let found: Awaited<ReturnType<Concierge['resolveEvent']>> = picked
      ? { kind: 'resolved', event: picked.e, venue: picked.v, label: eventLabel(picked.e, picked.v), entityKind: null }
      : await this.resolveEventWithDiscovery(merged, { receivedAt: msg.receivedAt, venueTimeZone: venueTz, home: merged.city || stateOnly(merged) ? null : await this.contactMarket(contact!.id), rules });
    // The date came from an earlier message and breaks a rule they have now given ("Oct 5 is in Philadelphia; I
    // only want a HOME game at MSG, find one instead"): the nearest event that keeps every rule, said so.
    if (found.kind === 'no_match' && found.reason === 'constraint_conflict' && found.conflict?.suggestion && !extraction.dateExpression && !extraction.resolvedLocalDate) {
      const cf = found.conflict;
      found = { kind: 'resolved', event: cf.suggestion!.event, venue: cf.suggestion!.venue, label: cf.suggestion!.label, entityKind: null, assumed: `${cf.label}${/^None of/.test(cf.label) ? ' fits' : " doesn't fit"}: ${cf.why}. So I've gone with ${cf.suggestion!.label} instead. Tell me if you meant a different one.` };
    }
    // Not playing where they named it ("Metallica soon in NY" while the tour stops in Philadelphia and
    // Foxborough): the nearest shows elsewhere in the US, closest first. One that fits a date they named, or
    // one close enough to be the same trip, is the answer, said as such; otherwise they choose.
    let elsewhere: NearbyShow[] = [];
    // Not when they named the venue or asked for a home game: another city is then a different request, not a nearby option.
    if (!picked && found.kind === 'no_match' && found.reason !== 'no_performer' && found.reason !== 'constraint_conflict' && !rules.venueTerms && !rules.homeOnly && merged.city && merged.performerOrTeam) {
      elsewhere = await this.nearestElsewhere(merged, { receivedAt: msg.receivedAt, venueTimeZone: venueTz });
      const only = elsewhere.length === 1 ? elsewhere[0]! : null;
      if (only && (merged.resolvedLocalDate || (only.miles !== null && only.miles <= NEARBY_SAME_TRIP_MILES))) {
        found = { kind: 'resolved', event: only.e, venue: only.v, label: eventLabel(only.e, only.v), entityKind: only.kind, assumed: `${titleCaseName(merged.performerOrTeam)} isn’t playing in ${placeLabel(merged)} then, so I’ve gone with ${only.v.name}${only.v.city ? ` in ${only.v.city}` : ''}${milesAway(only.miles, merged)}. Tell me if that’s too far.` };
        elsewhere = [];
      }
    }
    // A game already settled stays settled unless this message moves it: "let's do 6 tickets" or a pasted link
    // to the same game must never reopen "which game?".
    const resolution = !picked && req.eventId ? ((await this.keepSettledEvent(req.eventId, found, extraction, rules)) ?? found) : found;
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
    if (this.env.EVENT_ALERTS_ENABLED && merged.notifyAsked) {
      const set = await this.maybeEventAlert({ req, msg, contact: contact!, merged, revision, resolution, home: merged.city || stateOnly(merged) ? null : await this.contactMarket(contact!.id) });
      if (set) return set;
    }

    if (supplied.textOffers.length && resolution.kind !== 'resolved') return answerSupplied(false);

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
      const eventQuestion = elsewhere.length ? elsewhereQuestion(elsewhere, merged) : resolution.kind === 'ambiguous' ? decisiveEventQuestion(resolution.candidates, merged) : null;
      const qKeys = [...new Set([...missing, ...ambiguities])].filter((k) => !(eventQuestion && (k === 'event' || k === 'performer_ambiguous')));
      if (ambiguities.includes('date_near_midnight') && !eventQuestion && !qKeys.includes('event')) qKeys.unshift('event');
      // They named the act, the date and the place and nothing is scheduled: asking "which date and venue?" asks
      // for what they already gave (post-#54 QA, R3-B10). One next step instead.
      const gaveWhenWhere = resolution.kind === 'no_match' && resolution.reason !== 'constraint_conflict' && !!merged.performerOrTeam && !!(merged.resolvedLocalDate || merged.dateExpression) && !!(merged.city || merged.state || merged.resolvedLocalDate) && !elsewhere.length;
      // No date announced and they said so: one next step, never "which date and venue?" for a show that doesn't exist yet.
      const noDateYet = resolution.kind === 'no_match' && resolution.reason !== 'constraint_conflict' && !!merged.performerOrTeam && (/\b(?:isn'?t|not|no)\s+(?:an?\s+)?(?:announced|on sale)\b|\bdoesn'?t exist yet\b/i.test(flat(latestText)) || !!merged.notifyAsked);
      const teamish = ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer', 'ncaaf', 'ncaab', 'sports'].includes(merged.categoryHint ?? '') || /\b(?:game|match|home|away)\b/i.test(flat(latestText));
      const nextStep = gaveWhenWhere
        ? `If you’ve seen a ${titleCaseName(merged.performerOrTeam!)} ${teamish ? 'game' : 'show'} announced for then, send me the link and I’ll check it. Or tell me another date or city and I’ll look there.`
        : noDateYet ? `If you see a ${titleCaseName(merged.performerOrTeam!)} date announced, send me the link and I’ll check it.` : null;
      const conflict = resolution.kind === 'no_match' ? resolution.conflict ?? null : null;
      // A named event that breaks their rules: the one that keeps them all, offered, not "which date?" again.
      // The alternative drops the date they gave, so it fits everything else, not everything (TGQA-R8 S04): said so, and
      // asked, never assumed.
      const conflictAsk = conflict
        ? conflict.suggestion && conflict.sameOpponent
          ? `Two that fit everything else: ${conflict.sameOpponent.label}, against the same opponent, or ${conflict.suggestion.label}, the next one. Which would you like?`
          : conflict.suggestion
            ? `${conflict.dateNamed ? 'On another date, the next one that fits everything else you said' : 'The next one that fits everything you said'} is ${conflict.suggestion.label}. Want that one instead?`
            : 'I haven’t found one that fits all of that. Tell me which of those to relax, or send a date or link.'
        : null;
      const questions = imageUnread ? [IMAGE_UNREAD_ASK] : conflictAsk ? [conflictAsk, ...clarificationQuestions(qKeys.filter((k) => !['event', 'performer_ambiguous'].includes(k) && !k.startsWith('date_')), merged)].slice(0, 2) : nextStep ? [nextStep, ...clarificationQuestions(qKeys.filter((k) => k !== 'event' && k !== 'performer_ambiguous'), merged)].slice(0, 3) : [...(eventQuestion ? [eventQuestion] : []), ...clarificationQuestions(qKeys, merged)].slice(0, 3);
      // Residency is an eligibility check, not part of the request: asked once, on its own line, on the first
      // clarification (ENGINEERING_SPEC §1), and remembered on the contact once answered.
      const countryCheck = !contact!.countryConfirmed && count === 1;
      const knownFacts = describeKnown(merged);
      const near = elsewhere.some((x) => x.miles !== null && x.miles <= NEARBY_TRAVEL_MILES);
      const noMatch = elsewhere.length ? `${titleCaseName(merged.performerOrTeam!)} isn’t playing in ${placeLabel(merged)}${merged.dateExpression ? ' around then' : ''}, ${near ? 'but there are shows not far off.' : 'and the nearest shows are a trip away.'}` : conflict ? `${conflict.label}${/^None of/.test(conflict.label) ? ' fits' : " doesn't fit"}: ${conflict.why}.` : resolution.kind === 'no_match' ? noMatchNote(resolution.reason, merged) : null;
      // Nothing scheduled at all (not merely on that date): offer to tell them when there is.
      const offerAlert = noMatch && this.env.EVENT_ALERTS_ENABLED && !!merged.performerOrTeam && (await this.nothingScheduled(merged, merged.city || stateOnly(merged) ? null : await this.contactMarket(contact!.id)));
      // Their own questions about what we can do come first, answered as they stand (TGQA-R6 1011, 1012).
      const alertsOff = !this.env.EVENT_ALERTS_ENABLED && (merged.notifyAsked || ON_SALE_ASKED.test(flat(latestText)));
      const capability = [
        alertsOff ? `I can’t email you when tickets go on sale: automatic on-sale alerts are switched off for now, so nothing is watching this for you. ${merged.performerOrTeam ? `Check ${titleCaseName(merged.performerOrTeam)}’s official website or Ticketmaster` : 'Check the official website or Ticketmaster'} for the on-sale date; I haven’t seen one announced.` : null,
        TREND_ASKED.test(flat(latestText)) ? `On buy or wait: I don’t have usable price history for ${merged.quantity && merged.quantity > 1 ? `${countWordLower(merged.quantity)} seats together` : 'these seats'} at ${merged.performerOrTeam ? `${titleCaseName(merged.performerOrTeam)} games` : 'these events'}, so I can’t tell you whether prices are rising or falling, and waiting would be a guess.${NO_ALERTS.test(flat(latestText)) ? ' I haven’t set an alert.' : ''}` : null,
      ].filter(Boolean).join(' ');
      // The event is settled and only something else is missing (how many tickets): say which one, so "the next home
      // game" is answered, not just filed (TGQA-R6 1007).
      const settled = resolution.kind === 'resolved' ? `${resolution.assumed ? `${resolution.assumed} ` : ''}That’s ${resolution.label}.` : null;
      const eventNote = [capability || null, settled, noMatch ? `${noMatch}${offerAlert ? (elsewhere.length ? ` If you’d rather wait for a ${placeLabel(merged)} date, reply "let me know" and I’ll email you when one is announced.` : ' If they haven’t announced it yet, reply "let me know" and I’ll email you when a date is out.') : ''}` : null].filter(Boolean).join('\n\n') || null;
      // An electronic act we can't find is often only on Resident Advisor: point there for the customer's city.
      const ra = noMatch && genreFamilyFor(merged.genreHint)?.key === 'electronic' ? raPointer((await this.marketForRequest(merged, contact!.id))?.market.id) : null;
      await this.db.update(t.requests).set({ clarificationCount: count }).where(eq(t.requests.id, req.id));
      await this.transition(req.id, 'needs_clarification', unresolved.join(','));
      await this.queueSend({ messageClass: 'clarification', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'A couple of quick questions'), template: 'clarification', vars: { acknowledgement: imageUnread ? imageUnreadLine(imageUnread) : acknowledgementLine(merged), eventNote: imageUnread ? null : eventNote, questions, assumptions: imageUnread ? listingNotes : assumptions, countryCheck, knownFacts, ra: imageUnread ? null : ra }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
      return { state: 'needs_clarification', revision, extraction: merged };
    }

    if (resolution.kind !== 'resolved') throw new Error('unreachable');

    // Still on general sale at the official seller, and resale not asked about: that is the answer. Buy/wait
    // advice is for resale only (official prices are fixed or rise), so no research runs; the customer is
    // pointed at the sale, told resale can be cheaper for events that are not sold out, and "compare" opens
    // the resale comparison. No prices are quoted, so this goes without review (DECISION_LOG #36).
    // A price to judge ("is $106 a good deal?") gets the full answer, which includes the official sale.
    // Their offers (or a listing they showed) are the question: compared, never answered with "it's on general sale".
    const official = merged.resaleAsked || merged.quotedPriceCents != null || merged.intent === 'watch_request' || merged.submittedUrls.length || supplied.textOffers.length || listing.fields ? null : await this.officialSale(resolution.event, now);
    if (official) {
      await this.transition(req.id, 'referred', 'official_sale_open');
      await this.queueSend({
        messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal,
        subject: reSubject(msg.subject, 'Still on general sale'), template: 'official_sale',
        vars: { unverified: withFaceValueCheck(unverifiedRequirements(merged, latestText), merged, resolution.event), opening: pickNote, recheck: revision > 1 && /\b(?:have|did|could) you (?:actually |already )?(?:check|checked|verif\w*|look(?:ed)? at)\b|\bhaven'?t (?:you )?checked\b/i.test(flat(latestText)), eventLabel: resolution.label, eventTitle: resolution.event.name, eventWhen: shortWhen(resolution.event.localStartAt, resolution.venue.timezone, resolution.event.subtype === 'time_tba'), venueName: resolution.venue.name, seller: official.seller, url: this.env.APP_MODE === 'fixture' ? official.buyUrl : await this.trackLink(req.id, official.buyUrl, `Buy on ${official.seller}`, official.affiliate), eventUrl: official.url, affiliate: official.affiliate, quantity: merged.quantity, notes: [...(resolution.assumed ? [resolution.assumed] : []), ...[categoryBuyingNote(resolution.event.category, resolution.venue.name)].filter((x): x is string => !!x)], sportsGame: ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer'].includes(resolution.event.category), countryUnconfirmed: !contact!.countryConfirmed },
        inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null,
        // One per revision: a follow-up ("have you checked the seats are together?") is answered, not deduplicated
        // into silence (audit replay A05-R1).
        dedupeKey: `official_sale:${req.id}:${resolution.event.id}:${revision}`,
      });
      return { state: 'referred', revision, extraction: merged };
    }

    const cameFromReferral = req.state === 'referred';
    await this.transition(req.id, 'researching', 'brief_complete');
    // A browse that settled on its only match is answered here too, whichever revision it came on, and so is
    // a "compare" after the official-sale reply.
    // A question answered from what they sent (their offers side by side, a screenshot, delivery against their
    // trip) gets its answer once, seconds later: "I'll look at how the tickets are trading" was promising work
    // that wasn't the job (post-#55 writing review). Anything we assumed still gets the acknowledgment.
    const selfContained = !assumptions.length && (latestOffers.length >= 2 || !!listing.fields || questionsAsked(latestText).deliveryRisk || !!questionsAsked(latestText).parking);
    if ((revision === 1 || picked || cameFromReferral) && !selfContained) {
      await this.queueSend({ messageClass: 'acknowledgment', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision, recipient: contact!.emailOriginal, subject: reSubject(msg.subject, 'Got it, checking your options'), template: 'acknowledgment', vars: { knownFacts: acknowledgedFacts(resolution.event, resolution.venue, merged, msg.sanitizedText ?? ''), eventLabel: resolution.label, assumptions, countryUnconfirmed: !contact!.countryConfirmed }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null });
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
    let res;
    try {
      res = await reserveBudget(this.db, { requestId: req.id, revision: req.currentRevision, runId: null, jobName: 'extract', model, estimatedUsdMicros: est, limits: this.limits(), now: this.now() });
    } catch (e) {
      // Out of AI budget: the email is still read, by the rules reader, rather than handed to a person with
      // nothing done (post-#56 live QA: two simple comparisons became "a person will reply", and they answer
      // from what the customer wrote). The draft falls back to the evidence-only email the same way.
      if (!(e instanceof BudgetExceededError)) throw e;
      await audit(this.db, { actor: 'system', action: 'ai.budget_rules_fallback', entityKind: 'request', entityId: req.id, revision: req.currentRevision, diff: { job: 'extract', scope: e.scope, detail: e.detail } });
      return new FixtureExtractor().extract(input);
    }
    let out: RequestExtraction;
    try {
      out = await this.deps.extractor.extract(input);
    } catch (e) {
      // Nothing was billed when the call never reached the model, so the reservation must not stand: a
      // run of transport failures would otherwise eat the daily cap without producing one extraction.
      // A refusal, a malformed response or a truncated one did consume tokens, so those keep theirs.
      if (e instanceof ModelOutputError && (e.kind === 'transport' || e.kind === 'rejected')) {
        await releaseBudget(this.db, { requestId: req.id, revision: req.currentRevision, model, estimatedUsdMicros: est, jobName: 'extract' });
      }
      // A refused call (unknown model, bad key, no billing) is the same for every email, not this one, so
      // retrying it or handing it to a person changes nothing: the rules reader answers, and the operations
      // page counts each one so the setting gets fixed.
      if (e instanceof ModelOutputError && e.kind === 'rejected') {
        console.error('[ai] provider refused the extraction call; reading by rules', e.message.slice(0, 200));
        await audit(this.db, { actor: 'system', action: 'ai.provider_rules_fallback', entityKind: 'request', entityId: req.id, revision: req.currentRevision, diff: { job: 'extract', model, error: e.message.slice(0, 300) } });
        return new FixtureExtractor().extract(input);
      }
      throw e;
    }
    const usage = (this.deps.extractor as { lastUsage?: { inputTokens: number; outputTokens: number } | null }).lastUsage ?? null;
    if (usage) await settleBudget(this.db, res.ledgerId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: 0, actualUsdMicros: estimateUsdMicros(model, usage.inputTokens, usage.outputTokens, 0, this.env.modelPrices) });
    return out;
  }

  /**
   * Reads the listing this message shows: each accepted screenshot (up to the per-message limit), or, when there
   * is none, listing text pasted into the email. A screenshot is re-encoded first (metadata stripped, bounded
   * size). One that shows a barcode, payment card or ID is deleted and quarantined, and nothing read from it is
   * kept. A read that fails never fails the request; the customer is asked for the details instead.
   */
  /**
   * Whether this message carries an image we didn't read: one attached (fetched or not) with nothing usable
   * read from it, or an email that says it attaches one when none reached us. 'missing' when it never arrived.
   */
  private async unreadImage(msg: typeof t.messages.$inferSelect, requestId?: string): Promise<'unread' | 'missing' | null> {
    const rows = await this.db.select().from(t.attachments).where(eq(t.attachments.messageId, msg.id));
    const images = rows.filter((a) => a.validationState !== 'quarantined' && (/^image\//i.test(a.detectedMimeType ?? a.declaredMimeType ?? '') || /\.(png|jpe?g|gif|webp|heic)$/i.test(a.filename ?? '')));
    if (images.length) return 'unread';
    if (!SAYS_ATTACHED.test(msg.sanitizedText ?? '')) return null;
    // "The screenshot still says $52 each" is the one we already read, not an attachment that went missing
    // (TGQA-R6 1009): its facts are kept and used.
    if (requestId && (await this.db.select({ id: t.listingEvidence.id }).from(t.listingEvidence).where(and(eq(t.listingEvidence.requestId, requestId), sql`${t.listingEvidence.fields} is not null`)).limit(1)).length) return null;
    return 'missing';
  }

  private async readListingEvidence(msg: typeof t.messages.$inferSelect, req: typeof t.requests.$inferSelect): Promise<{ fields: ListingFields | null; source: 'screenshot' | 'listing_text' | null; images: number; redacted: number }> {
    const atts = await this.db.select().from(t.attachments).where(and(eq(t.attachments.messageId, msg.id), eq(t.attachments.validationState, 'accepted')));
    const images = atts.filter((a) => a.mediaId);
    const reader = this.deps.listingReader;
    if (!reader) return { fields: null, source: null, images: images.length, redacted: 0 };
    const media = createMediaStore(this.db, this.env.MEDIA_PROVIDER, this.env.MEDIA_MAX_TOTAL_BYTES);
    let best: ListingFields | null = null;
    let source: 'screenshot' | 'listing_text' | null = null;
    let redacted = 0;
    const read = async (input: { image?: ListingImage; text?: string }) => {
      const model = this.env.modelName ?? 'rules';
      const est = estimateUsdMicros(model, input.image ? 2200 : Math.ceil((input.text?.length ?? 0) / 3) + 900, 600, 0, this.env.modelPrices);
      const r = await reserveBudget(this.db, { requestId: req.id, revision: req.currentRevision, runId: null, jobName: 'listing_read', model, estimatedUsdMicros: est, limits: this.limits(), now: this.now() });
      try {
        const out = await reader.read({ ...input, receivedAt: msg.receivedAt });
        const usage = (reader as { lastUsage?: { inputTokens: number; outputTokens: number } | null }).lastUsage ?? null;
        if (usage) await settleBudget(this.db, r.ledgerId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: 0, actualUsdMicros: estimateUsdMicros(model, usage.inputTokens, usage.outputTokens, 0, this.env.modelPrices) });
        return out;
      } catch (e) {
        if (e instanceof ModelOutputError && (e.kind === 'transport' || e.kind === 'rejected')) await releaseBudget(this.db, { requestId: req.id, revision: req.currentRevision, model, estimatedUsdMicros: est, jobName: 'listing_read' });
        throw e;
      }
    };
    for (const a of images) {
      const stored = await media.get(a.mediaId!);
      if (!stored) continue;
      let image: ListingImage;
      try {
        const sharp = (await import('sharp')).default;
        const jpeg = await sharp(stored.bytes).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        image = { mimeType: 'image/jpeg', base64: jpeg.toString('base64') };
      } catch {
        await audit(this.db, { actor: 'system', action: 'listing.image_unreadable', entityKind: 'attachment', entityId: a.id, diff: { messageId: msg.id } });
        continue;
      }
      let r;
      try {
        r = await read({ image });
      } catch (e) {
        if (e instanceof BudgetExceededError) break;
        await audit(this.db, { actor: 'system', action: 'listing.read_failed', entityKind: 'attachment', entityId: a.id, diff: { messageId: msg.id, error: e instanceof ModelOutputError ? e.kind : 'error' } });
        continue;
      }
      if (r.sensitiveContent || r.kind === 'payment_or_id') {
        await this.db.update(t.attachments).set({ mediaId: null, validationState: 'quarantined', validationReason: 'sensitive_content' }).where(eq(t.attachments.id, a.id));
        await media.delete(a.mediaId!);
        await this.db.insert(t.listingEvidence).values({ requestId: req.id, messageId: msg.id, attachmentId: a.id, source: 'screenshot', observedAt: msg.receivedAt, sensitive: true, kind: r.kind, confidence: null, fields: null, readBy: reader.name });
        await audit(this.db, { actor: 'system', action: 'listing.sensitive_quarantined', entityKind: 'attachment', entityId: a.id, diff: { messageId: msg.id } });
        redacted += 1;
        continue;
      }
      const fields = usableListing(r) ? fieldsFromRead(r) : null;
      await this.db.insert(t.listingEvidence).values({ requestId: req.id, messageId: msg.id, attachmentId: a.id, source: 'screenshot', observedAt: msg.receivedAt, kind: r.kind, confidence: r.confidence, fields: fields as unknown as Record<string, unknown> | null, readBy: reader.name });
      if (fields && !best) {
        best = fields;
        source = 'screenshot';
      }
    }
    const text = msg.sanitizedText ?? '';
    // Two or more offers in their words are compared one by one (text-offers); read as one listing, their fields
    // run together (post-#54 QA, R3-B01).
    if (!best && looksLikeListingText(text) && reader.name !== 'none' && offersInText(text).length < 2) {
      try {
        const r = await read({ text });
        let fields = usableListing(r) ? fieldsFromRead(r) : null;
        // "Neither seat is a wheelchair or companion space": their correction wins over any reading of the
        // word itself (post-#54 QA, R3-B08).
        if (fields && SEATS_NOT_ACCESSIBLE.test(text)) fields = { ...fields, restrictionCodes: fields.restrictionCodes.filter((c) => c !== 'accessible_seating'), restrictions: fields.restrictions.filter((x) => !/\b(wheelchair|accessible|accessibility|ada|companion)\b/i.test(x)) };
        await this.db.insert(t.listingEvidence).values({ requestId: req.id, messageId: msg.id, source: 'listing_text', observedAt: msg.receivedAt, kind: r.kind, confidence: r.confidence, fields: fields as unknown as Record<string, unknown> | null, readBy: reader.name });
        if (fields) {
          best = fields;
          source = 'listing_text';
        }
      } catch (e) {
        if (!(e instanceof BudgetExceededError)) await audit(this.db, { actor: 'system', action: 'listing.read_failed', entityKind: 'message', entityId: msg.id, diff: { source: 'listing_text', error: e instanceof ModelOutputError ? e.kind : 'error' } });
      }
    }
    return { fields: best, source, images: images.length, redacted };
  }

  /**
   * A reply that reports how it ended. Returns the new state when it was one (the request is closed and
   * acknowledged), or null when the message should be handled as part of the request.
   */
  private async recordOutcomeReply(a: { req: typeof t.requests.$inferSelect; msg: typeof t.messages.$inferSelect; contact: typeof t.contacts.$inferSelect; extraction: RequestExtraction; prior: RequestExtraction; listingSent: boolean }): Promise<string | null> {
    const { req, msg, contact, extraction: x, prior } = a;
    const changed = (k: 'quantity' | 'dateExpression') => x[k] != null && x[k] !== prior[k];
    const bringsSomethingNew = a.listingSent || x.submittedUrls.length > 0 || x.quotedPriceCents != null || changed('quantity') || changed('dateExpression') || (!!x.performerOrTeam && !!prior.performerOrTeam && x.performerOrTeam.toLowerCase() !== prior.performerOrTeam.toLowerCase());
    if (bringsSomethingNew) return null;
    const outcomes = await this.db.select({ kind: t.requestOutcomes.kind }).from(t.requestOutcomes).where(eq(t.requestOutcomes.requestId, req.id));
    const followUpOpen = outcomes.some((o) => o.kind === 'follow_up_sent') && !outcomes.some((o) => o.kind === 'follow_up_reply');
    // A question is a request ("we got them, but can you check parking?"), except in answer to our follow-up.
    if (!followUpOpen && /\?/.test(msg.sanitizedText ?? '')) return null;
    const reply = classifyOutcomeReply(msg.sanitizedText ?? '');
    if (!reply && !followUpOpen) return null;
    const at = msg.receivedAt;
    const rows: Array<typeof t.requestOutcomes.$inferInsert> = [];
    if (followUpOpen) rows.push({ requestId: req.id, kind: 'follow_up_reply', source: 'customer_reply', messageId: msg.id, details: { bought: reply?.bought ?? null, changedWhat: reply?.changedWhat ?? null, changedWhen: reply?.changedWhen ?? null }, actor: 'customer', at });
    if (reply?.bought === true) rows.push({ requestId: req.id, kind: 'user_reported_purchase', source: 'customer_reply', messageId: msg.id, details: {}, actor: 'customer', at });
    if (reply?.bought === false) rows.push({ requestId: req.id, kind: 'user_reported_no_purchase', source: 'customer_reply', messageId: msg.id, details: {}, actor: 'customer', at });
    if (reply?.stopWatching && reply.bought !== true) rows.push({ requestId: req.id, kind: 'stop_watching', source: 'customer_reply', messageId: msg.id, details: {}, actor: 'customer', at });
    if (rows.length) await this.db.insert(t.requestOutcomes).values(rows);
    // Bought or stop: nothing more to watch for this request.
    let stoppedN = 0;
    if (reply?.bought === true || reply?.stopWatching) {
      const stopped = await this.db.update(t.watches).set({ state: 'cancelled', generation: sql`${t.watches.generation} + 1` }).where(and(eq(t.watches.requestId, req.id), eq(t.watches.state, 'active'))).returning({ id: t.watches.id });
      await this.stopWatchAlerts(stopped.map((w) => w.id));
      const alerts = await this.db.update(t.eventAlerts).set({ state: 'cancelled' }).where(and(eq(t.eventAlerts.requestId, req.id), eq(t.eventAlerts.state, 'active'))).returning({ id: t.eventAlerts.id });
      stoppedN = stopped.length + alerts.length;
    }
    const kind = reply?.bought === true ? 'bought' : reply?.stopWatching ? 'stopped' : 'thanks';
    // "I've stopped keeping an eye on this one" only when something was running (TGQA-R6 1015).
    const watched = stoppedN > 0;
    await this.queueSend({ messageClass: 'acknowledgment', contactId: contact.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact.emailOriginal, subject: reSubject(msg.subject, 'Thanks'), template: 'outcome_ack', vars: { kind, watched }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `outcome_ack:${msg.id}` });
    await audit(this.db, { actor: 'customer', action: 'request.outcome_reported', entityKind: 'request', entityId: req.id, diff: { kinds: rows.map((r) => r.kind) } });
    await this.transition(req.id, 'closed', kind === 'bought' ? 'customer_bought' : kind === 'stopped' ? 'customer_stopped' : 'follow_up_answered');
    return 'closed';
  }

  /**
   * The one follow-up per request, the day after the event: did the advice change what or when they bought?
   * Only for requests we actually answered with advice or a referral, never after "stop", and only once.
   * The send gate keeps it off until FOLLOW_UP_ENABLED is set.
   */
  async sendFollowUps(opts: { limit?: number } = {}): Promise<{ queued: number; considered: number }> {
    const now = this.now();
    const from = new Date(now.getTime() - 14 * 86_400_000);
    const to = new Date(now.getTime() - 18 * 3_600_000);
    const rows = await this.db.select({ r: t.requests, e: t.events, v: t.venues, c: t.contacts }).from(t.requests).innerJoin(t.events, eq(t.events.id, t.requests.eventId)).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).innerJoin(t.contacts, eq(t.contacts.id, t.requests.contactId)).where(and(notInArray(t.requests.state, ['unsupported', 'needs_clarification', 'manual_attention']), gte(t.events.localStartAt, from), lte(t.events.localStartAt, to), sql`not exists (select 1 from ${t.requestOutcomes} o where o.request_id = ${t.requests.id} and o.kind in ('follow_up_sent', 'stop_watching'))`)).limit(opts.limit ?? 50);
    let queued = 0;
    for (const { r, e, c } of rows) {
      if (c.status === 'deleted') continue;
      const outs = await this.db.select({ kind: t.requestOutcomes.kind }).from(t.requestOutcomes).where(eq(t.requestOutcomes.requestId, r.id));
      if (outs.some((o) => o.kind === 'follow_up_sent' || o.kind === 'stop_watching')) continue;
      // Closed without advice (off-topic, opted out, unsupported) is not a request we helped with.
      if (r.state === 'closed' && !outs.some((o) => o.kind === 'user_reported_purchase')) continue;
      // Only after an answer actually reached them: advice, a price check or an official-sale referral.
      const answered = await this.db.select({ id: t.sendIntents.id }).from(t.sendIntents).where(and(eq(t.sendIntents.requestId, r.id), inArray(t.sendIntents.messageClass, ['recommendation', 'no_result', 'acknowledgment']), or(sql`${t.sendIntents.dedupeKey} like 'rec:%'`, sql`${t.sendIntents.dedupeKey} like 'official_sale:%'`), inArray(t.sendIntents.state, ['provider_accepted', 'delivered']))).limit(1);
      if (!answered.length) continue;
      const [last] = await this.db.select().from(t.messages).where(and(eq(t.messages.conversationId, r.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(desc(t.messages.receivedAt)).limit(1);
      await this.queueSend({ messageClass: 'follow_up', contactId: c.id, conversationId: r.conversationId, requestId: r.id, revision: r.currentRevision, recipient: c.emailOriginal, subject: reSubject(last?.subject ?? null, `How was ${e.name}?`), template: 'follow_up', vars: { what: e.name }, inReplyTo: last?.rfcMessageId ?? null, approvalId: null, approvedHash: null, dedupeKey: `follow_up:${r.id}` });
      await this.db.insert(t.requestOutcomes).values({ requestId: r.id, kind: 'follow_up_sent', source: 'system', details: {}, at: now });
      queued += 1;
    }
    return { queued, considered: rows.length };
  }

  /** A link for a customer email, behind /go/<id> so a click can be counted; the id carries nothing personal. */
  private async trackLink(requestId: string, url: string, label: string | null, affiliate: boolean): Promise<string> {
    const [row] = await this.db.insert(t.trackedLinks).values({ requestId, url, label, affiliate }).returning({ id: t.trackedLinks.id });
    return `${this.env.APP_URL.replace(/\/$/, '')}/go/${row!.id}`;
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
  /**
   * Which inbound limit this sender is over, counting this message and the ones stored before it (a backlog
   * interpreted late must not count the emails that came after); null when within both.
   */
  private async inboundLimitHit(contactId: string, msg: { receivedAt: Date; createdAt: Date }): Promise<'hour' | 'day' | null> {
    const at = msg.receivedAt;
    const since = (h: number) => new Date(at.getTime() - h * 3_600_000);
    const count = async (h: number) => {
      const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(t.messages).innerJoin(t.conversations, eq(t.conversations.id, t.messages.conversationId)).where(and(eq(t.conversations.contactId, contactId), eq(t.messages.direction, 'inbound'), gte(t.messages.receivedAt, since(h)), lte(t.messages.receivedAt, at), lte(t.messages.createdAt, msg.createdAt)));
      return r?.n ?? 0;
    };
    return overInboundLimit({ lastHour: await count(1), lastDay: await count(24) });
  }

  /** Whether this action was recorded for the contact within the last `hours`, by the message time it carries. */
  private async recentAudit(action: string, contactId: string, at: Date, hours: number): Promise<boolean> {
    const rows = await this.db.select({ diff: t.auditLog.diff }).from(t.auditLog).where(and(eq(t.auditLog.action, action), eq(t.auditLog.entityKind, 'contact'), eq(t.auditLog.entityId, contactId))).orderBy(desc(t.auditLog.createdAt)).limit(20);
    const from = at.getTime() - hours * 3_600_000;
    return rows.some((r) => {
      const when = Date.parse(String((r.diff as { at?: string } | null)?.at ?? ''));
      return Number.isFinite(when) && when >= from && when <= at.getTime();
    });
  }

  /**
   * A customer's request whose work was dead-lettered (its model calls kept failing): handed to a person with the
   * error, once, and the customer told a person has it. Replaying the dead event later still answers it.
   */
  async handOffFailedWork(a: { eventType: string; payload: Record<string, unknown>; error: string }): Promise<'handed_off' | 'not_customer_work' | 'already_handled'> {
    if (!['request.interpret', 'research.requested'].includes(a.eventType)) return 'not_customer_work';
    const requestId = String(a.payload.requestId ?? '');
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    if (!req || ['closed', 'manual_attention', 'recommendation_sent', 'unsupported'].includes(req.state)) return 'already_handled';
    const [contact] = await this.db.select().from(t.contacts).where(eq(t.contacts.id, req.contactId));
    const msgId = typeof a.payload.messageId === 'string' ? a.payload.messageId : null;
    const [msg] = msgId
      ? await this.db.select().from(t.messages).where(eq(t.messages.id, msgId))
      : await this.db.select().from(t.messages).where(and(eq(t.messages.conversationId, req.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(desc(t.messages.receivedAt)).limit(1);
    if (!contact || !msg) return 'already_handled';
    await this.parkForStaff({ req, revision: req.currentRevision, reason: `work_failed:${a.eventType}: ${a.error.slice(0, 300)}`, contact, msg });
    return 'handed_off';
  }

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
    const allRecipients = this.env.STAFF_ALERT_ADDRESSES.length ? this.env.STAFF_ALERT_ADDRESSES : this.env.STAFF_EMAIL_ALLOWLIST;
    if (!allRecipients.length) return skip('no_staff_addresses');
    if (!this.deps.emailProvider) return skip('sending_disabled');
    const switches = await loadSwitches(this.db);
    if (switches.all_outbound === false) return skip('kill_switch_all_outbound');
    // Test mode sends nothing; the request shows as needing a person on the board, which is where testing watches.
    if (testModeFrom(switches)) return skip('test_mode');
    const [req] = await this.db.select().from(t.requests).where(eq(t.requests.id, args.requestId));
    if (!req) return skip('request_not_found');
    if (req.state !== 'manual_attention') return skip('no_longer_waiting');
    const [last] = await this.db.select({ reason: t.requestTransitions.reason, at: t.requestTransitions.createdAt }).from(t.requestTransitions).where(and(eq(t.requestTransitions.requestId, req.id), eq(t.requestTransitions.toState, 'manual_attention'))).orderBy(desc(t.requestTransitions.createdAt)).limit(1);
    const why = staffReasonLabel(last?.reason ?? 'unknown');
    // A promised comparison goes to the person who owns it.
    const comparison = last?.reason === 'staff_comparison';
    const recipients = comparison && this.env.STAFF_COMPARISON_OWNER ? [this.env.STAFF_COMPARISON_OWNER] : allRecipients;
    const link = `${this.env.APP_URL.replace(/\/$/, '')}/admin/requests/${req.id}`;
    // What the customer has actually been sent, from the send record, never assumed (TG-B06).
    const [holding] = comparison
      ? await this.db.select({ state: t.sendIntents.state }).from(t.sendIntents).where(and(eq(t.sendIntents.requestId, req.id), sql`${t.sendIntents.dedupeKey} like 'rec:%'`)).orderBy(desc(t.sendIntents.createdAt)).limit(1)
      : await this.db.select({ state: t.sendIntents.state }).from(t.sendIntents).where(and(eq(t.sendIntents.requestId, req.id), eq(t.sendIntents.dedupeKey, `holding:${req.id}`))).limit(1);
    const told = comparison && holding && ['provider_accepted', 'delivered'].includes(holding.state)
      ? 'The customer has been told a person is looking for seats that meet their requirements and will reply in the thread. Record each option you check under Manual offers (source, time checked, exact quantity, seats together, all-in total, restrictions), then re-run research to send the comparison; or reply that nothing fits.'
      : !holding
      ? 'The customer has not been told anything yet: reply to them from the request page.'
      : ['provider_accepted', 'delivered'].includes(holding.state)
        ? 'The customer has been told a person is picking it up.'
        : ['queued', 'claimed', 'submitted', 'uncertain'].includes(holding.state)
          ? 'A reply telling the customer a person is picking it up is on its way.'
          : `The reply telling the customer a person is picking it up was not sent (${holding.state}): reply to them from the request page.`;
    const subject = `Needs a person: ${why}`;
    const text = [
      `A request is waiting on a person: ${why}.`,
      `Request ${req.id.slice(0, 8)}, revision ${args.revision}. ${told}`,
      `Open it: ${link}`,
      'This is an automatic alert. Reply to the customer from the request page, not to this email.',
    ].join('\n\n');
    const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = `<p>A request is waiting on a person: <strong>${esc(why)}</strong>.</p><p>Request ${esc(req.id.slice(0, 8))}, revision ${args.revision}. ${esc(told)}</p><p><a href="${esc(link)}">Open the request</a></p><p style="color:#666;font-size:12px;">This is an automatic alert. Reply to the customer from the request page, not to this email.</p>`;
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
    // Their rules from the whole thread, latest word winning: "NOVEMBER 2026 only, Saturday or Sunday, start after
    // 7pm, not at 7", "MSG or Barclays ONLY" (TGQA-R6 1004). Every pick must keep all of them.
    const threadMsgs = (await this.db.select({ text: t.messages.sanitizedText }).from(t.messages).where(and(eq(t.messages.conversationId, req.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(asc(t.messages.receivedAt))).map((m) => m.text ?? '');
    const venueNames = (await this.db.select({ name: t.venues.name, aliases: t.venues.aliases }).from(t.venues).limit(5000)).map((v) => ({ name: v.name.length >= 6 ? v.name : '', aliases: v.aliases.filter((x) => x.length >= 6 || /^[A-Z]{3,4}$/.test(x)) }));
    const goalChange = threadMsgs.findLastIndex(similarMusicGoal);
    const rules = eventConstraints(goalChange >= 0 ? threadMsgs.slice(goalChange) : threadMsgs, { receivedAt: msg.receivedAt, timeZone: tz, venues: venueNames });
    let win = rules.window ? { from: rules.window.from, to: rules.window.to } : merged.dateExpression ? dateWindowFor(merged.dateExpression, msg.receivedAt, tz) : null;
    if (!win && merged.resolvedLocalDate) win = { from: merged.resolvedLocalDate, to: merged.resolvedLocalDate };
    // A window they fenced ("November ONLY", "not September or October", "say so rather than give me other dates")
    // or a venue they named is not widened: nothing in it is the answer (TGQA-R6 10, 19). A plain "Oct 12-18"
    // may still show the next ones after it, said as such.
    const fenced = threadMsgs.some((m) => /\bonly\b|\bnot\s+(?:in\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\brather than\b|\bdon'?t\s+(?:widen|broaden|change)\b|\bthat actual (?:window|day)\b/i.test(flat(m)));
    const bounded = (!!rules.window && fenced) || !!rules.venueTerms;
    const assumedWindow = !win;
    win ??= { from: today, to: day(today, 13) };
    if (win.from < today) win = { from: today, to: win.to };

    // The borough they named and the kind of music narrow the list; either is dropped, and the reply says so,
    // when nothing on file fits it.
    // A venue they named is narrower than its borough: "Barclays only" is not "anything in Brooklyn".
    const area = market.id === 'new-york' && !rules.venueTerms ? areaFor(merged.city) : null;
    const genre = merged.categoryHint === 'concert' || merged.categoryHint === null ? genreFamilyFor(merged.genreHint) : null;

    // Ask the provider about a window once per city (fresh results are reused), then read the catalog. A kind
    // of music is also asked for by name, so a busy week's first hundred shows do not crowd it out.
    const discovery = await this.discoveryAvailability();
    const threadText = threadMsgs.join('\n');
    const ruledOut = exclusionsIn(threadText);
    const startsAt = { after: rules.after?.minutes ?? null, before: rules.before?.minutes ?? null };
    const dayRule = { ...rules, window: null };
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
        // Start time ("after 7pm" is later than 7pm), days, venue: the same rules the resolver keeps.
        if (breaks(dayRule, e, v, { team: false }).length) return false;
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
      // What they ruled out ("no pop concerts, tribute acts or kids' events") goes before any ranking, so an
      // excluded show is never one of the picks (post-#54 QA, R3-B07).
      const allowed = ruledOut.length ? placed.filter(({ e }) => !ruledOut.some((k) => excludedBy(k, e))) : placed;
      const ofGenre = genre ? allowed.filter(({ e }) => genreMatches(genre, e.genre)) : allowed;
      const genreKept = !genre || ofGenre.length > 0;
      // Bounded by venue or dates, a kind of music with nothing on is "none found", not everything else instead (TGQA-R6 19).
      return { providerChecked, all, placed, areaKept, areaUsed, genreKept, events: genreKept ? ofGenre : bounded ? [] : allowed };
    };
    // Nothing in the window is not a dead end: a team that plays at home every other week, or a quiet week,
    // gets the next few after it (six weeks on), said as such.
    const within = await lookIn(win);
    const after = within.events.length || bounded ? null : await lookIn({ from: day(win.to, 1), to: day(win.to, 42) });
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
      // What we found, not a claim about everything on in the city (live G02: "the only show in Manhattan").
      const found = `the only ${oneOfLabel(merged.categoryHint, genre)} I found in ${areaUsed?.label ?? market.label} for ${spanLabel(win.from, win.to)}${rules.after ? ` starting ${rules.after.strict ? 'after' : 'at or after'} ${timeLabel(rules.after.minutes)}` : ''}`;
      // With a requirement nothing here can check (a teenager's admission), it is one possibility, not a choice made
      // for them (post-#56 QA G02).
      // The time is what we can check; the rest is said as still to check (writing review: "This is one evening option
      // I found", not a pick made for them).
      const evening = startsAt.after !== null && startsAt.after >= 17 * 60 ? 'evening ' : '';
      return { pick: only, note: ageNeed(threadText) ? `This is one ${evening}option: ${found}. ${startsAt.after !== null || startsAt.before !== null ? 'The time fits; ' : ''}I haven't confirmed it works for your group yet, so the checks it still needs are below.` : `It's ${found}, so I've gone ahead with it. Tell me if you had something else in mind.` };
    }
    await recordVersion();
    // Three picks that fit best, on different days where possible, each with why it fits and where to go next.
    const dayOf = ({ e, v }: (typeof events)[number]) => eventLocalDate(e.localStartAt, v.timezone);
    const shown = choosePicks(events, 3, (x) => ({ day: dayOf(x), score: genreFitScore(x.e.genre, merged.genreHint) }));
    const options = shown.map(({ e, v }) => `${new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(e.localStartAt)}: ${e.name} at ${v.name}`);
    const picks = await this.picksFor(shown, options, shown.map(({ e }) => runNote(runOf.get(e.id), e.category)));
    const label = genre && (genreKept || bounded) ? genre.label : browseLabel(merged.categoryHint);
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
      genre && !genreKept && placed.length && !bounded ? `I couldn't find any ${genre.words} listed for those dates, so here's everything that's on.` : null,
    ].filter(Boolean);
    const assumption = notes.length ? notes.join(' ') : null;
    // A place we don't know is searched as a town of that name; finding nothing there says more about the name.
    const unknownPlace = market.id.startsWith('city:') && !all.length;
    const startsAfter = `${rules.venueTerms ? ` at ${rules.venueTerms.map((n) => (n.length <= 4 ? n.toUpperCase() : n.replace(/\b\w/g, (c) => c.toUpperCase()))).join(' or ')}` : ''}${rules.weekdays?.length === 2 && rules.weekdays.includes(6) && rules.weekdays.includes(0) ? ' on a Saturday or Sunday' : ''}${rules.after ? ` starting ${rules.after.strict ? 'after' : 'at or after'} ${timeLabel(rules.after.minutes)}` : startsAt.before !== null ? ` starting before ${timeLabel(startsAt.before)}` : ''}`;
    const emptyNote = unknownPlace
      ? `I couldn't find ${market.label} as a place in the official listings. Which city is it in or near? I'll look there.`
      : providerChecked
      ? `I checked the official listings and couldn't find any ${label.toLowerCase()} in ${place} for ${span}${startsAfter}.`
      : `I don't have any ${label.toLowerCase()} in ${place} on file for ${span}${startsAfter}.`;
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

  async resolveEvent(x: RequestExtraction, home?: Market | null, rules?: ResolveRules | null): Promise<{ kind: 'resolved'; event: typeof t.events.$inferSelect; venue: typeof t.venues.$inferSelect; label: string; entityKind: 'artist' | 'team' | null; assumed?: string | null } | { kind: 'ambiguous'; candidates: EventCandidate[] } | { kind: 'no_match'; reason: NoMatchReason; conflict?: ConstraintConflict } | { kind: 'non_us' }> {
    if (!x.performerOrTeam) return { kind: 'no_match', reason: 'no_performer' };
    // The performance a pasted link names ("…/event/0300643DF03B25CE") is that performance, not the first show that day.
    // Links are read lower-cased; provider ids are compared the same way ("0300643DF03B25CE").
    const linked = rules?.linkedEventIds.length ? new Set((await this.db.select({ id: t.eventSourceMappings.eventId }).from(t.eventSourceMappings).where(inArray(sql`lower(${t.eventSourceMappings.sourceEventId})`, rules.linkedEventIds.map((x) => x.toLowerCase())))).map((r) => r.id)) : new Set<string>();
    // A month, a range or "next Saturday" (read both ways) they named wins over a single date or weekday the
    // extractor pinned from the same words, and over a date that falls outside it.
    // A bare weekday the extractor pinned ("Saturday") beside "any Saturday or Sunday in October" or "find a weekend
    // that works" is the kind of day, not that date (TGQA-R6 02, 04).
    const bareDay = /^(?:this |next |on )?(?:sun|mon|tues|wednes|thurs|fri|satur)day$/i.test((x.dateExpression ?? '').trim());
    const ruleWindow = rules?.window && (!x.resolvedLocalDate || bareDay || rules.window.source === 'next_weekday' || x.resolvedLocalDate < rules.window.from || x.resolvedLocalDate > rules.window.to) ? rules.window : null;
    const ignoreDate = !ruleWindow && !!rules && bareDay && ((rules.weekdays?.length ?? 0) > 1 || rules.next);
    const dropped: Array<{ e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect; why: string[] }> = [];
    // A matchup ("Rangers vs Lightning") is tried side by side: the side we know is the team, the other side
    // narrows its games. The first-named side goes first because it is usually the home team.
    const matchup = splitMatchup(x.performerOrTeam);
    const attempts = matchup
      ? [{ name: matchup.first, opponent: matchup.second }, { name: matchup.second, opponent: matchup.first }]
      : [{ name: x.performerOrTeam, opponent: opponentFor(x.performerOrTeam, x.eventName) }];
    const now = this.now();

    const asked = [x.performerOrTeam, x.eventName, x.dateExpression].filter(Boolean).join(' ');
    const windowFilter = (rows: Array<{ e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect }>, isTeam: boolean, opponent: string | null, entity?: typeof t.entities.$inferSelect) => {
      // Home is the team's home venue, or its market when the catalog doesn't know the venue (TGQA-R8 S03).
      const homeMk = entity && isTeam ? teamHomeMarket(entity.name) : null;
      const atHome = (v: typeof t.venues.$inferSelect): boolean | null => {
        if (entity?.homeVenueId === v.id) return true;
        if (homeMk) return inMarket(v, homeMk) ? (entity?.homeVenueId ? null : true) : false;
        return entity?.homeVenueId ? false : null;
      };
      let cands = rows.filter(({ e }) => !e.subtype || !NON_ADMISSION_SUBTYPES.includes(e.subtype)); // parking and packages are not "tickets to the game"
      if (isTeam && !isNonGameName(asked)) cands = cands.filter(({ e }) => !isNonGameName(e.name));
      // A named opponent is a hard filter: "vs Lightning" never resolves to the game against someone else.
      if (opponent) cands = cands.filter(({ e }) => isAgainst(e.name, opponent));
      // A span the customer named ("Oct 1-7", "first week of October") wins over a single date the extractor
      // may have pinned from it: the words are the evidence, and the 1st is not "the first week".
      const spanNamed = !!x.dateExpression && rows.some(({ v }) => dateWindowFor(x.dateExpression!, now, v.timezone) !== null);
      if (ruleWindow) {
        cands = cands.filter(({ e, v }) => {
          const d = eventLocalDate(e.localStartAt, v.timezone);
          return d >= ruleWindow.from && d <= ruleWindow.to;
        });
      } else if (ignoreDate) {
        // Any date: the days of the week they allow decide.
      } else if (x.resolvedLocalDate && !spanNamed) {
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
        cands = cands.filter(({ e, v }) => {
          const ok = (mk ? inMarket(v, mk) : false) || (v.city ?? '').toLowerCase() === x.city!.toLowerCase();
          // Kept as a reason: "Oct 5 at MSG" is a game in Philadelphia, and the reply says so (TGQA-R6 1001).
          if (!ok && rules && (rules.venueTerms || rules.homeOnly)) dropped.push({ e, v, why: [rules.venueTerms ? `it's in ${v.city ?? v.name}, not at ${rules.venueTerms.map((n) => (n.length <= 4 ? n.toUpperCase() : n.replace(/\b\w/g, (c) => c.toUpperCase()))).join(' or ')}` : `it's in ${v.city ?? v.name}, not ${mk?.label ?? x.city}`] });
          return ok;
        });
      } else if (stateOnly(x)) {
        const code = stateOnly(x)!;
        cands = cands.filter(({ v }) => (v.state ?? '').toUpperCase() === code);
      }
      // The provider lists one show more than once (package and presale variants under the same name); one
      // show at one venue on one day is one candidate, or the customer is asked to choose between twins.
      // The link's performance, when it is among them, is the one.
      if (linked.size && cands.some(({ e }) => linked.has(e.id))) cands = cands.filter(({ e }) => linked.has(e.id));
      // Their rules before any choice: a candidate at the wrong venue or time, away when they want home, on a day
      // they ruled out, is set aside with the reason, never chosen or linked (TGQA-R6 1001).
      if (rules) {
        cands = cands.filter(({ e, v }) => {
          const why = breaks(rules, e, v, { team: isTeam, atHome: atHome(v) });
          if (why.length) dropped.push({ e, v, why });
          return !why.length;
        });
      }
      // Two performances on one day are two events (4pm and 7pm), not twins; the provider's duplicates of one
      // performance still are.
      const seen = new Set<string>();
      const twinsOut = cands.filter(({ e, v }) => {
        const key = `${e.name.toLowerCase()}|${e.localStartAt.toISOString()}|${v.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const shows = oneListingPerShow(twinsOut, ({ e, v }) => ({ name: e.name, venueId: v.id, startAt: e.localStartAt, entityId: e.primaryEntityId }));
      // "The next home game": the earliest that fits, not a menu of every game after it.
      return rules?.next && shows.length > 1 ? shows.slice(0, 1) : shows;
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
        perEntity.push({ entity, cands: windowFilter(rows, entity.kind === 'team', attempt.opponent, entity) });
      }
      if (perEntity.some((p) => p.cands.length > 0)) break;
    }
    // Not on file at all is a different fact from on file with nothing scheduled, and the customer is told
    // which: claiming we searched listings we do not have is a claim about our own diligence.
    if (!sawEntity) return { kind: 'no_match', reason: 'unknown_performer' };
    let withEvents = perEntity.filter((p) => p.cands.length > 0);
    if (withEvents.length === 0 && dropped.length && rules) {
      // What they named exists but breaks their rules ("Oct 5 at MSG" is in Philadelphia): say which rule, and the
      // nearest event that keeps them all, dates aside.
      const sorted = dropped.sort((a, b) => a.e.localStartAt.getTime() - b.e.localStartAt.getTime());
      const first = sorted[0]!;
      // The opponent they named went with the date ("Knicks vs 76ers on Oct 5"): the alternative is any game that
      // keeps the venue and home rules.
      // Against the same opponent first ("Knicks vs 76ers on Oct 5 at MSG": they do play the 76ers at MSG, on Oct 20).
      const relaxed = { ...rules, window: null, next: true, weekdays: rules.weekdays, exactTime: null };
      const vsSame = opponentFor(x.performerOrTeam, x.eventName) || splitMatchup(x.performerOrTeam) ? await this.resolveEvent({ ...x, dateExpression: null, resolvedLocalDate: null }, home, relaxed) : null;
      const alt = await this.resolveEvent({ ...x, performerOrTeam: splitMatchup(x.performerOrTeam)?.first ?? x.performerOrTeam, eventName: null, dateExpression: null, resolvedLocalDate: null }, home, relaxed);
      const sameOpponent = vsSame?.kind === 'resolved' && (alt.kind !== 'resolved' || vsSame.event.id !== alt.event.id) ? { event: vsSame.event, venue: vsSame.venue, label: vsSame.label } : null;
      // Two or three that each break a rule are named together: "Mon, Oct 5: it's in Philadelphia; Thu, Oct 8: it's on a Thursday".
      const distinct = [...new Map(sorted.map((d) => [d.e.id, d])).values()];
      if (distinct.length > 1) {
        const day = (d: (typeof distinct)[number]) => new Intl.DateTimeFormat('en-US', { timeZone: d.v.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(d.e.localStartAt);
        return { kind: 'no_match', reason: 'constraint_conflict', conflict: { label: `None of the ${distinct.length === 2 ? 'two' : distinct.length} ${titleCaseName(splitMatchup(x.performerOrTeam)?.first ?? x.performerOrTeam)} dates I found then`, why: distinct.slice(0, 3).map((d) => `${day(d)}, ${d.why[0]}`).join('; '), dateNamed: true, suggestion: alt.kind === 'resolved' ? { event: alt.event, venue: alt.venue, label: alt.label } : null, sameOpponent } };
      }
      return { kind: 'no_match', reason: 'constraint_conflict', conflict: { label: eventLabel(first.e, first.v), why: first.why[0]!, dateNamed: !!(x.resolvedLocalDate || x.dateExpression || rules.window), suggestion: alt.kind === 'resolved' ? { event: alt.event, venue: alt.venue, label: alt.label } : null, sameOpponent } };
    }
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
   * The performer's shows outside the place the customer named, nearest first (by distance from that
   * market's centre; by date when the place has no coordinates), in the window they asked about, at most
   * three. The local catalog is read first; when it has none, the provider is asked once, nationally.
   */
  private async nearestElsewhere(x: RequestExtraction, ctx: { receivedAt: Date; venueTimeZone: string | null }): Promise<NearbyShow[]> {
    const mk = marketFor(x.city, x.state);
    const name = splitMatchup(x.performerOrTeam)?.first ?? x.performerOrTeam;
    if (!mk || !name) return [];
    const now = this.now();
    const load = async (): Promise<NearbyShow[]> => {
      const out: NearbyShow[] = [];
      for (const entity of await this.matchEntities(name)) {
        const rows = await this.db.select({ e: t.events, v: t.venues }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(and(eq(t.events.primaryEntityId, entity.id), gte(t.events.localStartAt, now), eq(t.events.status, 'scheduled'))).orderBy(asc(t.events.localStartAt)).limit(60);
        for (const { e, v } of rows) {
          if (e.subtype && NON_ADMISSION_SUBTYPES.includes(e.subtype)) continue;
          if (v.country !== 'US' || inMarket(v, mk)) continue;
          const day = eventLocalDate(e.localStartAt, v.timezone);
          if (x.resolvedLocalDate && day !== x.resolvedLocalDate) continue;
          const win = !x.resolvedLocalDate && x.dateExpression ? dateWindowFor(x.dateExpression, now, v.timezone) : null;
          if (win && (day < win.from || day > win.to)) continue;
          const miles = mk.lat !== null && mk.lng !== null && v.latitude != null && v.longitude != null ? milesBetween(mk.lat, mk.lng, v.latitude, v.longitude) : null;
          out.push({ e, v, miles, kind: entity.kind === 'team' ? 'team' : 'artist' });
        }
      }
      const shows = oneListingPerShow(out, ({ e, v }) => ({ name: e.name, venueId: v.id, startAt: e.localStartAt, entityId: e.primaryEntityId }));
      const sorted = shows.sort((a, b) => (a.miles ?? Infinity) - (b.miles ?? Infinity) || a.e.localStartAt.getTime() - b.e.localStartAt.getTime());
      // A drive or a short hop is worth offering beside nothing; Seattle beside Philadelphia is not.
      const reachable = sorted.filter((s) => s.miles !== null && s.miles <= NEARBY_TRAVEL_MILES);
      return (reachable.length ? reachable : sorted).slice(0, 3);
    };
    const local = await load();
    if (local.length) return local;
    const discovery = await this.discoveryAvailability();
    if (!discovery) return [];
    // "Soon" names no window; a tour stop a few months out, with its date, beats "couldn't find one".
    const win = this.discoveryWindow(x, ctx, 180);
    const sync = await syncFromDiscovery(this.db, discovery.adapter, { keyword: name, city: null, size: 50, startDateTime: win.start, endDateTime: win.end, trigger: 'interpret', dailyCallLimit: discovery.dailyCallLimit, now });
    await audit(this.db, { actor: 'system', action: 'catalog.discovery_synced', entityKind: 'catalog', entityId: name.toLowerCase(), diff: { status: sync.status, eventsSeen: sync.eventsSeen, eventsUpserted: sync.eventsUpserted, window: win, scope: 'national_fallback' } });
    return sync.status === 'success' || sync.status === 'skipped_fresh' ? load() : [];
  }

  /**
   * A reply while their deletion request is open. "CONFIRM" verifies it: everything but this conversation stops,
   * a person is alerted to complete it, and the customer is told it's verified and not yet done. A reply about it
   * after that gets its status. Anything else they write is handled as usual.
   */
  private async pendingDeletionReply(a: { req: typeof t.requests.$inferSelect; msg: typeof t.messages.$inferSelect; contact: typeof t.contacts.$inferSelect }): Promise<{ state: string; revision: number; extraction: RequestExtraction | null } | null> {
    const { req, msg, contact } = a;
    const [pending] = await this.db.select().from(t.deletionLedger).where(and(eq(t.deletionLedger.contactId, contact.id), sql`${t.deletionLedger.completedAt} is null`)).orderBy(desc(t.deletionLedger.requestedAt)).limit(1);
    if (!pending) return null;
    const text = flat(msg.sanitizedText ?? '');
    const confirm = /^\W*confirm(?:ed)?\W*$/i.test(text) || (/\bconfirm\b/i.test(text) && /\b(?:delet\w*|erase|remove)\b/i.test(text) && !pending.verifiedAt);
    const aboutIt = /\b(?:delet\w*|erase|erasure|remove my|my data|preferences)\b/i.test(text);
    if (!confirm && !aboutIt) return null;
    const now = this.now();
    let line: string;
    if (confirm && !pending.verifiedAt) {
      await this.db.update(t.deletionLedger).set({ verifiedAt: now }).where(eq(t.deletionLedger.id, pending.id));
      await stopAll(this.db, { contactId: contact.id, emailLookup: contact.emailLookup, evidence: { messageId: msg.id, deletion: pending.id } });
      await audit(this.db, { actor: 'customer', action: 'deletion.verified', entityKind: 'contact', entityId: contact.id, diff: { ledgerId: pending.id, messageId: msg.id } });
      await this.transition(req.id, 'manual_attention', 'deletion_verified_pending_completion');
      await enqueueOutbox(this.db, { eventType: 'staff.alert', eventKey: `staff_alert:${req.id}:deletion:${pending.id}`, entityId: req.id, payload: { requestId: req.id, revision: req.currentRevision }, now });
      line = 'Thanks, that’s confirmed: your request to delete your Ticket Guy data and preferences is verified. A person on the team completes deletions by hand, so it’s with them now and isn’t done yet. Until then nothing else will come from me except about this.';
    } else if (pending.verifiedAt) {
      line = 'Your deletion request is verified and waiting for a person on the team to complete it; it isn’t done yet. Nothing else is running: I haven’t restarted your earlier request, and I won’t.';
    } else {
      line = 'Your deletion request is waiting for you to confirm it. Reply to this email with just the word CONFIRM and I’ll pass it to the team to complete.';
    }
    await this.queueSend({ messageClass: 'verification', contactId: contact.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact.emailOriginal, subject: reSubject(msg.subject, 'Your deletion request'), template: 'raw_auto', vars: { text: ['Hey,', line].join('\n\n'), html: [`<p style="margin:0 0 18px;">Hey,</p>`, `<p style="margin:0 0 18px;">${line}</p>`].join('\n') }, inReplyTo: msg.rfcMessageId, approvalId: null, approvedHash: null, dedupeKey: `deletion:${msg.id}` });
    return { state: 'manual_attention', revision: req.currentRevision, extraction: null };
  }

  /** The rules on which event they mean, from every message in the thread and what their links and screenshot show. */
  private async resolveRules(req: typeof t.requests.$inferSelect, x: RequestExtraction, venueTz: string | null, receivedAt: Date): Promise<ResolveRules> {
    const texts = (await this.db.select({ text: t.messages.sanitizedText }).from(t.messages).where(and(eq(t.messages.conversationId, req.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(asc(t.messages.receivedAt))).map((m) => m.text ?? '');
    // Venues matched by their own names: a long name, or a short all-capitals alias like MSG. "Home" or "Hall"
    // alone never makes a venue rule.
    const venues = (await this.db.select({ name: t.venues.name, aliases: t.venues.aliases }).from(t.venues).limit(5000)).map((v) => ({ name: v.name.length >= 6 ? v.name : '', aliases: v.aliases.filter((a) => a.length >= 6 || /^[A-Z]{3,4}$/.test(a)) }));
    const c = eventConstraints(texts, { receivedAt, timeZone: venueTz ?? 'America/New_York', venues });
    // The screenshot's start time is the performance they are looking at, unless they typed a different one.
    if (c.exactTime === null && !c.after && !c.partOfDay) {
      const [ev] = await this.db.select({ fields: t.listingEvidence.fields }).from(t.listingEvidence).where(and(eq(t.listingEvidence.requestId, req.id), eq(t.listingEvidence.sensitive, false))).orderBy(desc(t.listingEvidence.createdAt)).limit(1);
      const time = (ev?.fields as { eventTime?: string | null } | null)?.eventTime;
      if (time && /^\d{2}:\d{2}$/.test(time)) c.exactTime = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    }
    const linkedEventIds = ticketLinksIn(x.submittedUrls).map((l) => l.eventId).filter((id): id is string => !!id);
    return { ...c, linkedEventIds };
  }

  /**
   * The event this request had already settled on, when the new message does not move it: it names no other
   * team, show or date, or what it names still fits that event (it is one of the candidates). A settled event
   * that has since been cancelled or played is not kept.
   */
  private async keepSettledEvent(eventId: string, resolution: Awaited<ReturnType<Concierge['resolveEvent']>>, said: RequestExtraction, rules?: ResolveRules | null): Promise<Awaited<ReturnType<Concierge['resolveEvent']>> | null> {
    if (resolution.kind === 'resolved' || resolution.kind === 'non_us') return null;
    // A settled event that breaks a rule they have since given ("I only want a HOME game") is not kept.
    if (resolution.kind === 'no_match' && resolution.reason === 'constraint_conflict') return null;
    const saysNothingNew = !said.performerOrTeam && !said.eventName && !said.dateExpression && !said.resolvedLocalDate;
    const stillFits = resolution.kind === 'ambiguous' && resolution.candidates.some((c) => c.id === eventId);
    if (!saysNothingNew && !stillFits) return null;
    const [row] = await this.db.select({ e: t.events, v: t.venues, kind: t.entities.kind, teamName: t.entities.name, homeVenueId: t.entities.homeVenueId }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).leftJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId)).where(eq(t.events.id, eventId));
    if (!row || row.e.status !== 'scheduled' || row.e.localStartAt <= this.now() || row.v.country !== 'US') return null;
    const homeMk = row.kind === 'team' && row.teamName ? teamHomeMarket(row.teamName) : null;
    const atHome = row.homeVenueId === row.v.id ? true : homeMk ? inMarket(row.v, homeMk) : null;
    if (rules && breaks(rules, row.e, row.v, { team: row.kind === 'team', atHome }).length) return null;
    return { kind: 'resolved', event: row.e, venue: row.v, label: eventLabel(row.e, row.v), entityKind: row.kind === 'team' ? 'team' : row.kind ? 'artist' : null };
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

  /** The date window the provider is asked about: the customer's date when we have one, otherwise the next 90 days (or `openDays`). */
  private discoveryWindow(x: RequestExtraction, ctx: { receivedAt: Date; venueTimeZone: string | null }, openDays = 90): { start: string; end: string } {
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
    return { start: `${today}T00:00:00Z`, end: `${day(today, openDays)}T23:59:59Z` };
  }

  /**
   * Local catalog first; when it has nothing for this name, ask the provider once and look again. A provider
   * failure never fails the request — it is recorded and the customer gets the honest "not on file" answer.
   */
  async resolveEventWithDiscovery(x: RequestExtraction, ctx: { receivedAt: Date; venueTimeZone: string | null; home?: Market | null; rules?: ResolveRules | null }): Promise<Awaited<ReturnType<Concierge['resolveEvent']>>> {
    const local = await this.resolveEvent(x, ctx.home, ctx.rules);
    if (local.kind !== 'no_match' || local.reason === 'no_performer' || (local.reason === 'constraint_conflict' && local.conflict?.suggestion)) return local;
    const discovery = await this.discoveryAvailability();
    if (!discovery) return local;
    const win = this.discoveryWindow(x, ctx);
    // For a matchup the provider is asked about one team; its schedule includes the game against the other.
    const keyword = splitMatchup(x.performerOrTeam)?.first ?? x.performerOrTeam ?? x.eventName ?? '';
    // A named metro is searched by its centre and radius ("LA" finds Inglewood); a town by name; none, nationally.
    const mk = marketFor(x.city, x.state);
    const where = mk && mk.lat !== null && mk.lng !== null ? { geoPoint: geohash(mk.lat, mk.lng), radiusMiles: mk.radiusMiles } : stateOnly(x) ? { city: null, stateCode: stateOnly(x) } : { city: x.city };
    const sync = await syncFromDiscovery(this.db, discovery.adapter, { keyword, ...where, startDateTime: win.start, endDateTime: win.end, trigger: 'interpret', dailyCallLimit: discovery.dailyCallLimit, now: this.now() });
    await audit(this.db, { actor: 'system', action: 'catalog.discovery_synced', entityKind: 'catalog', entityId: keyword.toLowerCase(), diff: { status: sync.status, eventsSeen: sync.eventsSeen, eventsUpserted: sync.eventsUpserted, window: win } });
    if (sync.status !== 'success' && sync.status !== 'skipped_fresh') return local; // provider trouble: say what we have, not what we could not check
    const again = await this.resolveEvent(x, ctx.home, ctx.rules);
    if (again.kind === 'no_match' && again.reason === 'constraint_conflict') return again;
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
    const uses = marketUses(licence, this.env);
    let market: Awaited<ReturnType<typeof marketForGroup>> | null = null;
    if (licence.allows('tracking')) {
      await new MarketTracker({ db: this.db, env: this.env, now: this.now, fetchImpl: this.deps.marketFetch }).refreshEvent(event.id);
      market = await marketForGroup(this.db, { eventId: event.id, quantity, eventStartAt: event.localStartAt, now });
    }
    const marketSignal = market && uses.advice ? { basisMatchesGroup: !!market.context && market.context.adequacy === 'sufficient', direction: market.context?.direction ?? 'insufficient', supply: market.supplyScope === 'group' && market.supply.trend === 'unknown' ? market.single.supply.trend : market.supply.trend } : null;
    const policy = decide({ market: marketSignal, now, eventStartAt: event.localStartAt, offers: { bestEligibleTotalCents: best?.comparableTotalCents ?? null, bestEligibleObservationId: best?.offer.id ?? null, eligibleCount: cmp.eligible.length, needsReviewCount: cmp.needsReview.length, alternativeAvailable: alternatives.length > 0 || cmp.needsReview.length > 0, deliveryFeasible: best ? (best.offer.deliveryMethod ? true : null) : null, safeDeliveryBufferMinutes: null }, benchmark, trend, priorities, monitoringCoverageAvailable: monitoringCoverage, staffedUntil: null });

    const isFixtureRun = allOffers.some((o) => o.collectionMode === 'fixture') || this.env.APP_MODE === 'fixture';
    // What we know without listings: the official sale if it is open, the provider's face value, and the
    // price the customer asked about (per ticket; a total is divided by the party size).
    const official = await this.officialSale(event, now);
    const faceValue = event.faceMinCents != null && event.faceMaxCents != null ? { minCents: event.faceMinCents, maxCents: event.faceMaxCents } : null;
    // What they asked in the message behind this revision, not anywhere in the thread: a question answered
    // before, or quoted back, is not asked again (remediation review §1). Quoted history is already stripped.
    const latestIds = version?.sourceMessageIds ?? [];
    const said = latestIds.length ? (await this.db.select({ text: t.messages.sanitizedText }).from(t.messages).where(inArray(t.messages.id, latestIds))).map((m) => m.text ?? '').join('\n') : '';
    const asks = questionsAsked(said);
    // Two or more offers laid out in their words: compared as the question, each kept apart (retest R2-B02).
    const threadMessages = (await this.db.select({ text: t.messages.sanitizedText, at: t.messages.receivedAt }).from(t.messages).where(and(eq(t.messages.conversationId, req.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(asc(t.messages.receivedAt))).map((m) => m.text ?? '');
    const saidInThread = threadMessages.join('\n');
    // The offers they laid out stay the question when a follow-up changes a requirement without restating them
    // ("I'm now happy to buy six… which of the same offers?", "I can raise it to $230… using only my supplied
    // offers"): the same offers, judged again on the changed terms, never a fresh market search (live M01-F1,
    // M03-F1). A follow-up that names an offer itself ("ignore Offer A, only B") is its own question.
    const { textOffers, offersSetAside } = suppliedOffers(said, threadMessages, venue.timezone);
    const judged = textOffers.length >= 2 || offersSetAside.length > 0;
    // The listing they showed us, newest first: what it displayed is the price being checked, with its source.
    const [ev] = await this.db.select().from(t.listingEvidence).where(and(eq(t.listingEvidence.requestId, req.id), eq(t.listingEvidence.sensitive, false), sql`${t.listingEvidence.fields} is not null`)).orderBy(desc(t.listingEvidence.createdAt)).limit(1);
    // "section Offer B: 211" was the label read as the seat (retest R2-B06): the seat fields keep the value only.
    const evFields = ev ? (ev.fields as unknown as ListingFields) : null;
    // With two or more of their offers, the comparison is the answer: a single-listing read of the same email
    // mixes their fields (A's price and access with B's seat) and contradicts it (post-#54 QA, R3-B01).
    const read: SubjectListing | null = judged ? null : ev && evFields ? { ...evFields, section: cleanSeatField(evFields.section), row: cleanSeatField(evFields.row), source: ev.source as SubjectListing['source'], observedAt: ev.observedAt, confidence: (ev.confidence as SubjectListing['confidence']) ?? null } : null;
    // What they typed about that listing since it was read wins over the read: "the image says $72 per ticket
    // BEFORE fees, plus $48 for the whole order … delivery by 6pm" (live A11-F1 repeated the old summary).
    const corrected = read && ev && !latestIds.includes(ev.messageId ?? '') ? correctListing(read, said) : { fields: read, changes: [] as string[], matches: false };
    const shown = corrected.fields;
    // One price for the listing: a total that carries fees on top of a before-fees ticket price is compared as its
    // all-in share per ticket, with the breakdown kept (live A11: $72 + $48 / 3 = $88 each).
    const tickets = shown?.quantity ?? quantity;
    const withFees = shown?.perTicketCents != null && shown.wholePartyCents != null && tickets > 0 && shown.wholePartyCents > shown.perTicketCents * tickets + 50;
    const quote: QuotedPrice | null = shown?.perTicketCents != null
      ? withFees
        ? { perTicketCents: Math.round(shown.wholePartyCents! / tickets), assumedPerTicket: false, source: shown.source, feeBasis: 'all_in', seenAt: shown.observedAt, seller: shown.seller, base: { perTicketCents: shown.perTicketCents, feesCents: shown.wholePartyCents! - shown.perTicketCents * tickets, tickets, totalCents: shown.wholePartyCents! } }
        : { perTicketCents: shown.perTicketCents, assumedPerTicket: shown.priceBasis === 'unknown', source: shown.source, feeBasis: shown.feeBasis, seenAt: shown.observedAt, seller: shown.seller }
      : brief.quotedPriceCents != null && !judged
        ? { perTicketCents: brief.quotedPriceBasis === 'whole_party' && quantity > 0 ? Math.round(brief.quotedPriceCents / quantity) : brief.quotedPriceCents, assumedPerTicket: brief.quotedPriceBasis === null, source: 'customer_reported', feeBasis: statedFeeBasis(said, brief.quotedPriceCents) ?? statedFeeBasis(saidInThread, brief.quotedPriceCents) ?? undefined }
        : null;
    // Travelling to it (a flight, a drive in) makes waiting riskier than the market shows.
    const travelling = TRAVELLING.test(saidInThread);
    // The market around the listing they showed us: cheaper seats for their group, from one fresh listings read.
    const around = shown?.perTicketCents != null && licence.allows('tracking') ? await new MarketTracker({ db: this.db, env: this.env, now: this.now, fetchImpl: this.deps.marketFetch }).currentListings(event.id) : null;
    const marketAround = around && shown?.perTicketCents != null ? findAlternatives(around.listings, { perTicketCents: shown.perTicketCents, feeBasis: shown.feeBasis, section: shown.section, row: shown.row }, quantity) : null;
    // The link they sent is acknowledged by name; its listing's price is behind the marketplace, so it is asked for.
    const sentLink = ticketLinksIn(brief.submittedUrls)[0] ?? null;
    // A watch they asked for: running only when one is stored active and its alerts can actually be sent.
    let watchStatus: Parameters<typeof buildPacket>[0]['watchStatus'] = null;
    if (brief.intent === 'watch_request') {
      const [w] = await this.db.select().from(t.watches).where(and(eq(t.watches.requestId, req.id), eq(t.watches.state, 'active'))).orderBy(desc(t.watches.createdAt)).limit(1);
      watchStatus = w && this.env.WATCH_SEND_ENABLED && w.targetTotalCents != null ? { running: true, quantity: w.quantity, targetTotalCents: w.targetTotalCents, togetherRequired: w.togetherRequired, expiresAt: w.expiresAt } : { running: false };
    }
    // Cheaper offers the comparison rejected for a hard requirement: named with the reason, never offered.
    const perSeat = (o: Offer) => { const tot = o.payableTotalCents ?? o.baseTotalCents; return tot === null ? null : tot / o.quantity; };
    const ref = best?.comparableTotalCents != null ? best.comparableTotalCents / quantity : constraints.budgetTotalCents != null ? constraints.budgetTotalCents / quantity : Infinity;
    const leftOut: NonNullable<Parameters<typeof buildPacket>[0]['leftOut']> = [];
    for (const e of cmp.excluded) {
      const ps = perSeat(e.offer);
      if (ps === null || ps >= ref || e.exclusions.some((x) => ['wrong_event', 'parking_only', 'different_session', 'unavailable', 'currency', 'resale_deposit', 'vip_package'].includes(x))) continue;
      const reason = e.exclusions.includes('obstructed_view') ? 'obstructed_view' : e.exclusions.includes('accessible_only') ? 'accessible_only' : e.exclusions.includes('seats_not_together') ? 'seats_not_together' : e.exclusions.includes('section_not_acceptable') ? 'section_not_acceptable' : e.exclusions.includes('wrong_quantity') && e.offer.quantity > quantity ? 'bigger_block' : null;
      if (reason && !leftOut.some((l) => l.reason === reason && l.quantity === e.offer.quantity)) leftOut.push({ reason, quantity: e.offer.quantity });
    }
    const eventNoun = ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer', 'ncaaf', 'ncaab'].includes(event.category) ? 'game' as const : 'show' as const;
    // The staffed comparison pilot (DECISION_LOG #54): when nothing verified meets what they asked for, and a
    // named owner exists with room in the pilot, a person takes it on and the email says so.
    const requirements = unverifiedRequirements(brief, saidInThread);
    if (best && best.comparableTotalCents !== null && best.offer.collectionMode !== 'fixture') {
      const [offered] = await this.db.select().from(t.requestOutcomes).where(and(eq(t.requestOutcomes.requestId, req.id), eq(t.requestOutcomes.kind, 'staff_comparison_offered'))).limit(1);
      const [answered] = await this.db.select({ id: t.requestOutcomes.id }).from(t.requestOutcomes).where(and(eq(t.requestOutcomes.requestId, req.id), eq(t.requestOutcomes.kind, 'staff_comparison_answered'))).limit(1);
      if (offered && !answered) await this.db.insert(t.requestOutcomes).values({ requestId: req.id, kind: 'staff_comparison_answered', source: 'staff', details: { minutes: Math.round((now.getTime() - offered.at.getTime()) / 60_000), sourceId: best.offer.sourceId, totalCents: best.comparableTotalCents, checked: cmp.eligible.length + cmp.needsReview.length + cmp.excluded.length }, actor: 'system', at: now });
    }
    const staffFollowUp = !(best && best.comparableTotalCents !== null) && (requirements.length > 0 || brief.resaleAsked) && !judged
      ? await this.takeForStaffComparison({ requestId: req.id, contactEmail: contact?.emailLookup ?? '', requirements })
      : null;
    // Their terms read across the thread, latest word winning: how many go, extra tickets, the arrival deadline.
    const offerNeeds = judged ? { noObstructed: NO_OBSTRUCTED.test(`${saidInThread}\n${brief.seatingPreference ?? ''}`), togetherRequired: !!brief.togetherRequired, baseline: comparedAgainst(said, textOffers.map((o) => o.label)) ?? comparedAgainst(saidInThread, textOffers.map((o) => o.label)), terms: partyTerms(threadMessages, venue.timezone) } : null;
    // A made-up example they want read, not bought (A11: "this is a synthetic QA example, not an actual offer").
    const synthetic = !!shown && /\b(?:synthetic|fictional|made[- ]up|hypothetical|imaginary|pretend|mock|sample)\b[^.]{0,40}\b(?:example|offer|screenshot|image|listing)s?\b|\bnot (?:an? )?(?:actual|real) offer\b|\bdon'?t (?:search|check) live (?:inventory|listings)\b|\bnot a real offer\b/i.test(flat(saidInThread));
    const trendAsked = TREND_ASKED.test(flat(said)) ? { noAlerts: NO_ALERTS.test(flat(said)), riskOk: brief.waitRiskTolerance === 'high' } : null;
    const packet = buildPacket({ trendAsked, offersSetAside, synthetic, corrections: corrected.changes, correctionMatches: !!corrected.matches, staffFollowUp, requirements, textOffers, offerNeeds, eventNoun, leftOut, asks, watchStatus, subject: shown, marketAround, travelling, seatingPreference: brief.seatingPreference, timeZone: venue.timezone, eventLocalDate: eventLocalDate(event.localStartAt, venue.timezone), accessibilityRequired: !!brief.accessibilityNeeds, link: sentLink ? { marketplace: MARKETPLACE_NAMES[sentLink.marketplace] } : null, market: market ? { basis: market.basis, context: market.context, supply: market.supply, supplyScope: market.supplyScope, comparableLabel: ent?.name ?? null, visible: uses.display } : null, official: official ? { seller: official.seller, url: official.buyUrl } : null, faceValue, quote, requestId: req.id, revision: args.revision, quantity, eventLabel: eventLabel(event, venue), best, alternatives, entryReference: entryRef, benchmark, benchmarkRunId, trend, trendRunId, policy, priorities, sourcesChecked: checked, sourcesUnavailable: unavailable, independentOptionCount: independentOptionCount(cmp), observedAt: now, evidenceExpiresAt: new Date(now.getTime() + 15 * 60_000), basketKey, watchConsentReference: brief.intent === 'watch_request' ? version!.sourceMessageIds[0] ?? null : null, isFixture: isFixtureRun });
    // Seller links go through /go/<id>, so a click is counted as a click (never as a purchase).
    for (const c of packet.claimRecords) if (c.url && !isFixtureRun) c.url = await this.trackLink(req.id, c.url, c.linkLabel ?? null, c.id === 'C_OFFICIAL' ? !!official?.affiliate : false);
    const hash = packetHash(packet);
    const [adviceRun] = await this.db.insert(t.adviceRuns).values({ requestId: req.id, revision: args.revision, benchmarkRunId, trendRunId, verifiedOfferObservationIds: packet.verifiedOfferObservationIds, customerPriorities: packet.customerPriorities, policyVersion: policy.policyVersion, decision: policy.decision, reasonCodes: policy.reasonCodes, abstentions: policy.abstentions, nextCheckpointAt: policy.nextCheckpointAt, stopConditions: policy.stopConditions, packet: packet as unknown as Record<string, unknown>, packetHash: hash, evidenceExpiresAt: new Date(now.getTime() + 15 * 60_000) }).returning({ id: t.adviceRuns.id });

    // A price check with no listings of ours goes out without review (owner's decision, DECISION_LOG #42):
    // it compares the customer's own number with the provider's published face value and names the official
    // sale, and recommends no listing. Anything carrying a verified offer still waits for a person.
    const autoSend = packet.verifiedOfferObservationIds.length === 0 && quote !== null;
    // During testing every other draft is approved by the system too; it then says it wasn't reviewed.
    const autoApprove = !autoSend && autoApproveActive(this.env);
    const renderOpts = { reviewed: !autoSend && !autoApprove };
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
            if (e instanceof ModelOutputError && (e.kind === 'transport' || e.kind === 'rejected')) {
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
    if (autoApprove) {
      // The ordinary approval, by the system: the same freshness, revision and fixture checks apply, and a
      // draft that fails them stays in the queue for a person.
      const r = await this.approveRecommendation({ recommendationId: rec!.id, reviewerUserId: AUTO_APPROVER, expectedRevision: args.revision, draftHash, note: 'auto-approved while testing' });
      if (r.ok) return { recommendationId: rec!.id, state: 'awaiting_review' };
      await this.db.update(t.recommendations).set({ reviewNote: `auto-approve skipped: ${r.reason}` }).where(eq(t.recommendations.id, rec!.id));
    }
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
    const intent = await this.queueSend({ messageClass: obs.length ? 'recommendation' : 'no_result', contactId: contact!.id, conversationId: req.conversationId, requestId: req.id, revision: req.currentRevision, recipient: contact!.emailOriginal, subject: reSubject(lastInbound?.subject ?? null, rec.subject), template: args.reviewerUserId === AUTO_APPROVER ? 'raw_auto' : 'raw', vars: { text: rec.bodyText, html: rec.bodyHtml }, inReplyTo: lastInbound?.rfcMessageId ?? null, approvalId: rec.id, approvedHash: rec.draftHash, dedupeKey: `rec:${rec.id}:${rec.draftHash}`, containsFixtureData: containsFixture });
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
    // One thread in the customer's inbox: Gmail threads a reply only when its subject matches the thread's
    // (after "Re:") as well as its reply headers, so every email carries the conversation's subject. A customer
    // who wrote with no subject gets "Re:" back: a subject of our own ("A couple of quick questions") opened a
    // new thread beside theirs.
    const [conv] = await this.db.select({ subject: t.conversations.subject }).from(t.conversations).where(eq(t.conversations.id, a.conversationId));
    let subject = a.subject;
    if (conv?.subject?.trim()) subject = reSubject(conv.subject, a.subject);
    else if (conv && a.inReplyTo) subject = 'Re:';
    else if (conv) await this.db.update(t.conversations).set({ subject: a.subject.replace(/^re:\s*/i, '') }).where(eq(t.conversations.id, a.conversationId));
    const [who] = await this.db.select({ firstName: t.contacts.firstName }).from(t.contacts).where(eq(t.contacts.id, a.contactId));
    const vars = who?.firstName && a.vars.firstName === undefined ? { ...a.vars, firstName: who.firstName } : a.vars;
    const rendered = renderTemplate(a.template, vars, { appUrl: this.env.APP_URL, postalAddress: this.env.BUSINESS_POSTAL_ADDRESS ?? null, overrides, signature, brand });
    const headers: Record<string, string> = { 'Reply-To': this.env.CONCIERGE_FROM_ADDRESS };
    const inReplyTo = normalizeMessageId(a.inReplyTo);
    if (inReplyTo) {
      headers['In-Reply-To'] = inReplyTo;
      const priorRefs = await this.db.select({ r: t.messages.referencesHeader }).from(t.messages).where(inArray(t.messages.rfcMessageId, [a.inReplyTo!, inReplyTo]));
      headers['References'] = buildReferencesChain([...(priorRefs[0]?.r ?? '').matchAll(/<[^<>\s]+>/g)].map((m) => m[0]), inReplyTo);
    }
    if (a.containsFixtureData) headers['X-TicketGuy-Fixture'] = 'true';
    return await this.db.transaction(async (tx) => {
      const r = await createSendIntent(tx, { dedupeKey: a.dedupeKey ?? `${a.messageClass}:${a.requestId ?? a.conversationId}:${a.revision ?? 0}:${sha(rendered.text).slice(0, 12)}`, messageClass: a.messageClass, contactId: a.contactId, conversationId: a.conversationId, requestId: a.requestId, requestRevision: a.revision, approvalId: a.approvalId, approvedHash: a.approvedHash, recipient: a.recipient, fromAddress: `Ticket Guy <${this.env.messageClassFromAddresses[a.messageClass]}>`, subject, bodyText: rendered.text, bodyHtml: rendered.html, headers });
      if (r.created) await enqueueOutbox(tx, { eventType: 'email.send_requested', eventKey: `send:${r.id}`, entityId: r.id, payload: { sendIntentId: r.id }, now: this.now() });
      return r;
    });
  }

  /**
   * Dispatcher: claim → gate (current state) → provider → record. Never sends fixture content; never resends blindly.
   * In test mode the provider step is replaced by a recorded capture and everything else runs unchanged.
   */
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
      if (intent.approvalId && intent.messageClass === 'watch_alert') {
        // A watch alert's approval is the alert's, and a cancellation seen now wins over an approval given before
        // it (A26): a watch that is no longer active, or has moved on a generation, sends nothing.
        const [alert] = await this.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.id, intent.approvalId));
        const [w] = alert ? await this.db.select().from(t.watches).where(eq(t.watches.id, alert.watchId)) : [];
        approved = alert?.approvalState === 'approved' && w?.state === 'active' && w.generation === alert.generation;
      } else if (intent.approvalId) {
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
    const capture = testModeFrom(switches) || (await isTestConversation(this.db, intent.conversationId));
    const gate = evaluateGate(this.env, switches, suppressed, { messageClass: intent.messageClass as MessageClass, recipientLookup: normalizeEmailLookup(intent.recipient), containsFixtureData: containsFixture, approved, approvalHashMatches: hashMatches, revisionCurrent, evidenceFresh, marketingPermission, testMode: capture });
    if (!gate.allowed) {
      const suppressedOnly = gate.reasons.every((r) => r.startsWith('suppressed'));
      await releaseClaim(this.db, claim, suppressedOnly ? 'suppressed' : 'blocked', gate.reasons.join(','));
      await audit(this.db, { actor: 'system', action: 'send.blocked', entityKind: 'send_intent', entityId: intent.id, diff: { reasons: gate.reasons, messageClass: intent.messageClass } });
      return { outcome: suppressedOnly ? 'suppressed' : 'blocked', reasons: gate.reasons };
    }
    const provider = this.deps.emailProvider;
    if (!capture && !provider) {
      await releaseClaim(this.db, claim, 'blocked', 'no_email_provider_configured');
      return { outcome: 'blocked', reasons: ['no_email_provider_configured'] };
    }
    try {
      const captured = capture ? capturedIds() : null;
      const r = captured ?? (await provider!.send({ idempotencyKey: intent.dedupeKey, from: intent.fromAddress, to: intent.recipient, subject: intent.subject, text: intent.bodyText, html: intent.bodyHtml, headers: intent.headers }));
      await recordProviderAccepted(this.db, claim, r.providerMessageId, now);
      if (captured) {
        await this.db.update(t.sendIntents).set({ providerRfcMessageId: captured.rfcMessageId }).where(eq(t.sendIntents.id, intent.id));
        await audit(this.db, { actor: 'system', action: 'send.captured_test_mode', entityKind: 'send_intent', entityId: intent.id, diff: { messageClass: intent.messageClass } });
      }
      await this.db.insert(t.messages).values({ conversationId: intent.conversationId!, direction: 'outbound', provider: captured ? TEST_PROVIDER : 'resend', providerEmailId: r.providerMessageId, rfcMessageId: captured?.rfcMessageId ?? null, inReplyTo: intent.headers['In-Reply-To'] ?? null, referencesHeader: intent.headers['References'] ?? null, fromAddress: intent.fromAddress, toAddresses: [intent.recipient], subject: intent.subject, sanitizedText: intent.bodyText, receivedAt: now }).onConflictDoNothing();
      if (intent.approvalId) {
        await this.db.update(t.recommendations).set({ reviewStatus: 'sent' }).where(eq(t.recommendations.id, intent.approvalId));
        if (intent.requestId) await this.transition(intent.requestId, 'recommendation_sent', 'approved_recommendation_sent');
      }
      // An advice email that promised a person would look (DECISION_LOG #54), reviewed or auto-sent: the request
      // now waits on its owner, who is told.
      if (intent.requestId && intent.dedupeKey?.startsWith('rec:')) {
        const kinds = (await this.db.select({ kind: t.requestOutcomes.kind }).from(t.requestOutcomes).where(eq(t.requestOutcomes.requestId, intent.requestId))).map((o) => o.kind);
        if (kinds.includes('staff_comparison_offered') && !kinds.includes('staff_comparison_answered')) {
          await this.transition(intent.requestId, 'manual_attention', 'staff_comparison');
          await enqueueOutbox(this.db, { eventType: 'staff.alert', eventKey: `staff_alert:${intent.requestId}:${intent.requestRevision ?? 0}:staff_comparison`, entityId: intent.requestId, payload: { requestId: intent.requestId, revision: intent.requestRevision ?? 0 }, now });
        }
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
    // A watch whose alerts can't be sent would be "active" to staff and "stopped" on cancel while it never ran,
    // and the customer is told nothing is monitored (audit replay A07/A07-R1): none is stored until they can.
    if (!this.env.WATCH_SEND_ENABLED) {
      await audit(this.db, { actor: 'system', action: 'watch.not_created', entityKind: 'request', entityId: a.requestId, diff: { reason: 'watch_alerts_disabled' } });
      return null;
    }
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

  /**
   * A place in the staffed comparison pilot, if there is one: an owner who is staff, the request not already
   * taken, and fewer than the limit taken for customers (staff's own tests and test-mode customers are served but
   * not counted). Taking it records the promise as an outcome, so the pilot can be measured against it.
   */
  private async takeForStaffComparison(a: { requestId: string; contactEmail: string; requirements: string[] }): Promise<{ hours: string } | null> {
    const owner = this.env.STAFF_COMPARISON_OWNER;
    const staff = new Set(this.env.STAFF_EMAIL_ALLOWLIST.map((x) => x.toLowerCase()));
    if (!owner || !staff.has(owner)) return null;
    const hours = staffedHoursLabel(this.env);
    const taken = await this.db.select({ requestId: t.requestOutcomes.requestId, email: t.contacts.emailLookup, conversationId: t.requests.conversationId }).from(t.requestOutcomes).innerJoin(t.requests, eq(t.requests.id, t.requestOutcomes.requestId)).innerJoin(t.contacts, eq(t.contacts.id, t.requests.contactId)).where(eq(t.requestOutcomes.kind, 'staff_comparison_offered'));
    if (taken.some((x) => x.requestId === a.requestId)) return { hours };
    const [req] = await this.db.select({ conversationId: t.requests.conversationId }).from(t.requests).where(eq(t.requests.id, a.requestId));
    const isTest = await isTestConversation(this.db, req?.conversationId ?? null);
    const counted = !staff.has(a.contactEmail.toLowerCase()) && !isTest;
    const tests = await testConversationIds(this.db, [...new Set(taken.map((x) => x.conversationId))]);
    if (counted && taken.filter((x) => !staff.has(x.email.toLowerCase()) && !tests.has(x.conversationId)).length >= this.env.STAFF_COMPARISON_LIMIT) return null;
    await this.db.insert(t.requestOutcomes).values({ requestId: a.requestId, kind: 'staff_comparison_offered', source: 'system', details: { owner, requirements: a.requirements, counted }, actor: 'system', at: this.now() });
    await audit(this.db, { actor: 'system', action: 'pilot.staff_comparison_offered', entityKind: 'request', entityId: a.requestId, diff: { owner, counted } });
    return { hours };
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
    await this.stopWatchAlerts([args.watchId]);
    await audit(this.db, { actor: args.actor, action: 'watch.cancelled', entityKind: 'watch', entityId: args.watchId, diff: { reason: args.reason } });
  }

  /**
   * After watches stop, nothing they found goes out: pending alerts are invalidated and queued (not yet
   * provider-accepted) alert sends are blocked. Accepted ones cannot be recalled. Every cancellation path uses
   * this, the customer's own included (a correct "stopped" email proves nothing about what was queued).
   */
  private async stopWatchAlerts(watchIds: string[]): Promise<void> {
    if (!watchIds.length) return;
    await this.db.update(t.watchAlerts).set({ approvalState: 'invalidated' }).where(and(inArray(t.watchAlerts.watchId, watchIds), eq(t.watchAlerts.approvalState, 'pending')));
    const alerts = await this.db.select({ sendIntentId: t.watchAlerts.sendIntentId }).from(t.watchAlerts).where(inArray(t.watchAlerts.watchId, watchIds));
    const ids = alerts.map((a) => a.sendIntentId).filter((x): x is string => !!x);
    if (ids.length) await this.db.update(t.sendIntents).set({ state: 'blocked', lastError: 'watch_cancelled' }).where(and(inArray(t.sendIntents.id, ids), eq(t.sendIntents.state, 'queued')));
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
export type EventCandidate = { id: string; label: string; entityName: string; league: string | null; name: string; venueName: string; isHome: boolean | null; when: string; at?: string };

function candidateFrom(entity: { name: string; league: string | null }, e: { id: string; name: string; localStartAt: Date; isHome: boolean | null }, v: { name: string; timezone: string }, label: string): EventCandidate {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(e.localStartAt);
  const at = new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, hour: 'numeric', minute: '2-digit' }).format(e.localStartAt).replace(':00', '').replace(/\s?([AP])M/, (_m, x: string) => `${x.toLowerCase()}m`);
  return { id: e.id, label, entityName: entity.name, league: entity.league, name: e.name, venueName: v.name, isHome: e.isHome, when, at };
}

/**
 * The single question that separates the candidates, asked the way a person would. Two teams → which team.
 * Home and away games in the window → home at the venue, or would they travel. A few games → name them. More
 * than that → ask for the date. It never lists more than three events and never claims availability.
 */
/**
 * What they need that an on-sale event says nothing about: the seats, the total and access (TG-B01). The sale
 * being open is not a seat, so none of these is met by it; each is said back as still to check.
 */
export function unverifiedRequirements(x: RequestExtraction, text = ''): string[] {
  const out: string[] = [];
  const age = ageNeed(text);
  const q = x.quantity;
  // Pairs when each adult sits with a child (TGQA-R6 18), not "4 seats together".
  if (q && q > 1 && partyTerms([text]).seating === 'pairs') out.push(`${q === 4 ? 'Two adjacent pairs' : 'Seats in pairs'}, with each adult beside a child`);
  else if (q && q > 1 && x.togetherRequired) out.push(`${q} seats together`);
  const total = wholePartyBudgetCents(x.budgetCents, x.budgetBasis, x.quantity);
  if (total !== null) out.push(`${formatUsd(total)} in total${q && q > 1 ? (q === 2 ? ' for both' : ` for all ${q}`) : ''}, once fees are added`);
  if (x.accessibilityNeeds?.trim()) out.push(x.accessibilityNeeds.trim().replace(/^./, (c) => c.toUpperCase()));
  if (x.seatingPreference?.trim()) out.push(x.seatingPreference.trim().replace(/^./, (c) => c.toUpperCase()));
  if (age) out.push(age);
  // One admission check, not the same age rule said three ways (G02).
  return age ? out.filter((r) => r === age || !/\b(?:21|18)\s*\+|\bage\b|year[- ]old|\bteen/i.test(r)) : out;
}

/**
 * A child or teenager in the party, or a venue age rule they ruled out ("our 16-year-old", "no 21+ venues"): the
 * venue's age policy is a requirement nothing here has checked (live G02).
 */
export function ageNeed(text: string): string | null {
  const t = flat(text);
  const minor = /\b(1[0-7]|[5-9])[- ]?(?:year[- ]?old|yo)\b/i.exec(t);
  if (minor) return `Admission for your ${minor[1]}-year-old (the venue’s age policy)`;
  if (/\b(?:no\s+21\s*\+|no\s+18\s*\+|all[- ]ages|our (?:teen|teenager|kids?|child|children|son|daughter))\b/i.test(t)) return 'The venue’s age policy for your group';
  return null;
}

/**
 * A start-time window they gave ("after 6pm", "no earlier than 7", "before 9pm"), in minutes after midnight
 * local time. A show outside it isn't one of theirs, however few there are (live G02: a 4pm show for "after 6pm").
 */
export function startWindow(text: string): { after: number | null; before: number | null } {
  const t = flat(text);
  const at = (h: string, m: string | undefined, ap: string | undefined) => {
    let hh = Number(h) % 12;
    if ((ap ?? 'pm').toLowerCase().startsWith('p')) hh += 12; // "after 6" for a show means the evening
    return hh * 60 + Number(m ?? 0);
  };
  const a = /\b(?:after|from|no earlier than|not before|starting after|later than)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?!\s*(?:tickets?|seats?|people|of us|\$))/i.exec(t);
  const b = /(?<!\bdeliver\w*\s+)\b(?:before|by|no later than|ending before|finish(?:ed)? by)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)(?!\s*(?:tickets?|seats?))/i.exec(t);
  return { after: a ? at(a[1]!, a[2], a[3]) : null, before: b ? at(b[1]!, b[2], b[3]) : null };
}

/**
 * Questions that aren't about price, from their words: delivery against their travel or a refund, and wheelchair
 * or accessible spaces as one of the options. Both need the words; a passing "transfer" or "accessible" alone
 * is not a question about them.
 */
export function questionsAsked(text: string): { deliveryRisk: boolean; accessibleSpaces: boolean; salesAsked: boolean; parking: { admissionEachCents: number | null; admissionAllIn: boolean } | null; gapAgainst: { perTicketCents: number; beforeFees: boolean } | null } {
  const t = flat(text);
  const delivery = /\b(deliver(y|ed|s)?|transfer(red)?|arrive|in hand|get the tickets|reach (my|our|your) phones?|on (my|our) phones?|in (my|our) app|show up)\b/i.test(t);
  const stakes = /\b(flight|fly|flying|leave|leaving|depart|departure|set off|get on|travel(l?ing)?|trip|drive|driving|train|bus|refund|guarantee|miss(ing)? (it|the game|the show))\b/i.test(t);
  // Accessible spaces as one of the options on the table (a price or an offer beside them), not a mention
  // that turns them down: "I don't need wheelchair spaces; compare these two" asks nothing about access.
  const spaces = t.split(/[.?!;\n]+/).some((sentence) => /\b(wheelchair|accessible|ada|companion)[- ]?(accessible )?(spaces?|seats?|seating|section|spots?)\b/i.test(sentence) && /\$\s?\d|\b(offer|listing|option|section|row)\b/i.test(sentence));
  const sales = /\b(how many (?:tickets |seats )?(?:have |has )?(?:actually |really )?sold|completed sales|actual sales|sold for|sales data|tickets sold)\b/i.test(t);
  // A "parking only" listing weighed as a way in (post-#56 QA V03): it is a parking pass, and the answer is the
  // admission ticket they need, at the admission price they gave when they gave one.
  const parkingListing = /\bparking[- ]only\b|\bparking pass(?:es)?\b|\bparking (?:listing|ticket|spot)s?\b/i.test(t) && /\b(?:get (?:us |me |both of us |them )?in(?:to)?|attend|entry|admission|see the (?:game|show)|a (?:good |cheap )?way)\b/i.test(t);
  const adm = parkingListing ? /\b(?:admission|event ticket|game ticket|entry)\b[^$.]{0,50}\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:each|a ticket|per ticket)?([^.;]{0,40})/i.exec(t) : null;
  const parking = parkingListing ? { admissionEachCents: adm ? Math.round(Number(adm[1]!.replace(/,/g, '')) * 100) : null, admissionAllIn: adm ? /\b(?:including|incl\.?|with)\s+(?:all\s+)?fees\b|\ball[- ]in\b/i.test(adm[2] ?? '') : false } : null;
  // "If another offer is $98.89 each BEFORE fees, would adding its fees make its gap from our $88 all-in price
  // larger or smaller?" (live A11-F1): arithmetic on their numbers, answered without any market data.
  const gap = /\bgap\b[^?]{0,80}\b(?:larger|bigger|wider|smaller|narrower)\b/i.test(t) ? /\b(?:another|other|a second|a different|second)\s+(?:offer|listing|seller|price)\b[^.?]{0,40}?\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:each|a ticket|per ticket)?\s*(before fees|plus fees|excluding fees|including (?:all )?fees|all[- ]in)?/i.exec(t) : null;
  const gapAgainst = gap ? { perTicketCents: Math.round(Number(gap[1]!.replace(/,/g, '')) * 100), beforeFees: /before|plus|excluding/i.test(gap[2] ?? '') } : null;
  return { deliveryRisk: delivery && stakes, accessibleSpaces: spaces, salesAsked: sales, parking, gapAgainst };
}

/**
 * "Cancel only the price watch requested in this thread", "stop the alerts": a cancellation, whatever the
 * extractor read. "Stop this watch on September 30 at 6pm" is when a new watch should end, not a cancellation.
 */
export function asksToCancelWatch(text: string): boolean {
  if (/\b(don'?t|do not|never mind) (cancel|stop)\b/i.test(text)) return false;
  for (const m of text.matchAll(/\b(cancel|stop|end|turn off)\b[^.?!]{0,40}?\b(watch|watching|alerts?|monitoring|tracking)\b/gi)) {
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 12);
    if (!/^\s+(on|at|after|by|when|once)\b/i.test(after)) return true;
  }
  return false;
}

/** A reply that stops something: checked before the inbound limit, so it is never held behind it. */
const STOP_WORDS = /\b(cancel|stop (watching|tracking|checking|monitoring|looking)|no longer (need|interested)|don'?t need (them|it|tickets) any ?more)\b/i;

/** The place they named is outside the US: a non-US city or country, with no US state beside it. */
export function eventOutsideUs(x: Pick<RequestExtraction, 'city' | 'state'>): boolean {
  if (stateCodeFor(x.state)) return false;
  const place = [x.city, x.state].filter(Boolean).join(', ');
  return !!place && !/\bnew london\b/i.test(place) && isOutsideUs(place);
}

/** "in London, UK", "to Toronto, Canada": a city with a non-US country beside it. */
const NAMED_ABROAD = /\b(?:in|to)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?),?\s+(UK|U\.K\.|United Kingdom|England|Scotland|Wales|Ireland|Canada|Mexico|France|Germany|Spain|Italy|Portugal|Netherlands|Australia|Japan)\b/g;
/** Words before a place that make it where someone lives or is, not where the event is. */
const NOT_THE_EVENT = /\b(live|living|lives|based|from|home|sister|brother|friend|family|parents?|mum|mom|dad|visiting|staying|moved|born)\b[^.?!]{0,12}$/i;

/** Every mention of the place follows "live in", "my sister in", "visiting from"…: a person's place, not the event's. */
export function onlyAsWhereSomeoneIs(text: string, place: string): boolean {
  const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = [...text.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))];
  return hits.length > 0 && hits.every((m) => NOT_THE_EVENT.test(text.slice(Math.max(0, m.index! - 30), m.index!).replace(/\s+(?:in|to|at)\s*$/i, ' ')));
}

/**
 * The non-US place the event is in, when the message puts it there: a city with its country, not one they live
 * in or know someone in, and only when the city the extractor chose is negated ("not New York") or isn't a US
 * place. Anything else is a US request, and residence is decided by the residence rule on its own words.
 */
export function namedAbroadEvent(text: string, city: string | null): RegExpExecArray | null {
  const escaped = city?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cityNegated = !!escaped && new RegExp(`\\b(?:not|no|rather than|instead of)\\s+(?:in\\s+)?${escaped}\\b`, 'i').test(text);
  const cityIsUs = !!city && !isOutsideUs(city) && (!!marketFor(city) || !!stateCodeFor(city));
  if (city && cityIsUs && !cityNegated) return null;
  for (const m of text.matchAll(NAMED_ABROAD)) {
    if (!NOT_THE_EVENT.test(text.slice(Math.max(0, m.index! - 30), m.index!))) return m as RegExpExecArray;
  }
  return null;
}

const countWords = (n: number) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n);

/** "London, UK" as they'd write it, for the reply. */
function placeName(x: Pick<RequestExtraction, 'city' | 'state'>): string {
  return [x.city, x.state].filter(Boolean).join(', ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'That event';
}

/** A show this far from where they asked is the same trip, and is proposed rather than asked about. */
export const NEARBY_SAME_TRIP_MILES = 60;
/** Shows within this distance are offered on their own; farther ones only when there is nothing closer. */
export const NEARBY_TRAVEL_MILES = 300;
export type NearbyShow = { e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect; miles: number | null; kind: 'team' | 'artist' | null };

function placeLabel(x: RequestExtraction): string {
  return marketFor(x.city, x.state)?.label ?? x.city ?? (stateOnly(x) ? US_STATES[stateOnly(x)!]! : 'there');
}

/** " (about 95 miles from New York)"; nothing when the distance isn't known. */
function milesAway(miles: number | null, x: RequestExtraction): string {
  if (miles === null) return '';
  const rounded = miles < 20 ? Math.round(miles) : miles < 500 ? Math.round(miles / 5) * 5 : Math.round(miles / 100) * 100;
  return ` (about ${rounded.toLocaleString('en-US')} miles from ${placeLabel(x)})`;
}

/** "Would one of these work: Sat, Oct 10 at Lincoln Financial Field, Philadelphia (about 95 miles from New York), or …?" */
export function elsewhereQuestion(shows: NearbyShow[], x: RequestExtraction): string {
  const opts = shows.map(({ e, v, miles }) => {
    const when = new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(e.localStartAt);
    return `${when} at ${v.name}${v.city ? `, ${v.city}` : ''}${milesAway(miles, x)}`;
  });
  const list = opts.length === 1 ? opts[0]! : `${opts.slice(0, -1).join('; ')}; or ${opts[opts.length - 1]}`;
  return `${opts.length === 1 ? 'Would this one work' : 'Would one of these work'}: ${list}? Reply with the date, or tell me how far you’d travel.`;
}

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
    // Two performances on one day are told apart by the time: "Sat, Oct 3 at 4pm or at 7pm at Town Hall".
    const sameDay = new Set(cands.map((c) => c.when)).size < cands.length;
    const opts = cands.map((c) => (isGame ? `${c.when} (${c.name})` : `${c.when}${sameDay && c.at ? ` at ${c.at}` : ''} at ${c.venueName}`));
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

export function eventLabel(e: { name: string; localStartAt: Date; doorsAt?: Date | null }, v: { name: string; city: string | null; timezone: string }): string {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(e.localStartAt);
  // Doors and the show are different times, and neither is inferred from the other (live A04-F1: "8pm" was doors).
  const at = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, hour: 'numeric', minute: '2-digit' }).format(d);
  const doors = e.doorsAt ? (e.doorsAt.getTime() < e.localStartAt.getTime() ? ` (doors ${at(e.doorsAt)})` : e.doorsAt.getTime() === e.localStartAt.getTime() ? ' (that’s when doors open; the show starts later)' : '') : '';
  return `${e.name} at ${v.name}${v.city ? `, ${v.city}` : ''}, ${when}${doors}`;
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
// Once the catalog has settled the event, its date is known too: "the next home game" is no longer a question.
const SETTLED_BY_RESOLUTION = ['performer_ambiguous', 'event_location_unknown', 'date_unsupported_expression', 'date_venue_timezone_unknown'];

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
/**
 * Folds what pasted ticket links say into this message's extraction. The link's date is the event's own date,
 * so it wins over a looser phrase ("early October"); a quantity or team the customer typed wins over the link.
 */
export function applyTicketLinks(x: RequestExtraction, known: Array<{ name: string; aliases: string[] }>): RequestExtraction {
  const links = ticketLinksIn(x.submittedUrls);
  if (!links.length) return x;
  const out: RequestExtraction = { ...x, ambiguities: [...x.ambiguities] };
  const dated = links.find((l) => l.localDate);
  if (dated) {
    out.dateExpression = dated.localDate;
    out.resolvedLocalDate = dated.localDate;
    out.ambiguities = out.ambiguities.filter((a) => !a.startsWith('date_'));
  }
  const counted = links.find((l) => l.quantity);
  if (out.quantity == null && counted) {
    out.quantity = counted.quantity;
    out.ambiguities = out.ambiguities.filter((a) => a !== 'quantity_unclear');
  }
  if (!out.performerOrTeam) {
    // The longest name in the slug: "new york rangers new york" is the New York Rangers, not "New York".
    let best: { name: string; len: number } | null = null;
    for (const l of links) {
      if (!l.slugText) continue;
      const slug = ` ${l.slugText} `;
      for (const k of known) {
        for (const n of [k.name, ...k.aliases]) {
          const w = n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (w.length >= 4 && slug.includes(` ${w} `) && (!best || w.length > best.len)) best = { name: k.name, len: w.length };
        }
      }
    }
    if (best) out.performerOrTeam = best.name;
  }
  return out;
}

/** Words that say the customer is travelling to the event, so a missed purchase costs more than the ticket. */
const TRAVELLING = /\b(fly(ing)? in|flight|flying (in|out|to)|travel(l)?ing (in|to|from|for)|driving in|coming in from|road trip|booked (a|our) hotel|hotel booked)\b/i;

/** Told when a screenshot showed a barcode, card or ID: we deleted it and used nothing from it. */
type Exclusion = 'pop' | 'tribute' | 'kids';
/** Kinds of show they ruled out, from a "no …" / "not …" / "without …" clause. */
export function exclusionsIn(text: string): Exclusion[] {
  const out = new Set<Exclusion>();
  const t = text.replace(/[’‘]/g, "'");
  for (const m of t.matchAll(/\b(?:no|not|nothing|without|avoid|skip|exclude|excluding|none of)\b([^.!?;:]{0,80})/gi)) {
    const clause = m[1]!;
    if (/\b(?:k-?)?pop\b(?!-?up)/i.test(clause) && !/\bpop[- ]?punk\b/i.test(clause)) out.add('pop');
    if (/\btribute/i.test(clause)) out.add('tribute');
    if (/\b(?:kids?|kids'|children'?s?|family|families|all[- ]ages)\b/i.test(clause)) out.add('kids');
  }
  return [...out];
}
function excludedBy(k: Exclusion, e: { name: string; genre: string | null; category: string }): boolean {
  const g = e.genre ?? '';
  if (k === 'pop') return /\bpop\b/i.test(g) || /\bpop\b/i.test(e.name);
  if (k === 'tribute') return /\btribute\b/i.test(g) || /\btribute\b|\bthe music of\b|\bsalute to\b/i.test(e.name);
  return e.category === 'family' || /\b(?:children'?s?|kids|family)\b/i.test(g) || /\b(?:kids|children'?s|for kids|family show)\b/i.test(e.name);
}

/**
 * Their typed corrections to a listing we read earlier: a fee basis for the same ticket price, a per-order fee,
 * the total, a delivery time. Each change is said back in the reply, and nothing else in the read is touched.
 */
export function correctListing(fields: SubjectListing, text: string): { fields: SubjectListing; changes: string[]; matches?: boolean } {
  const t = flat(text);
  const out: SubjectListing = { ...fields };
  const changes: string[] = [];
  const cents = (x: string) => Math.round(Number(x.replace(/,/g, '')) * 100);
  const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  // A new version replaces the old numbers ("new version… now FOUR seats… $70 each… these replace the old
  // image's numbers"); a correction fixes how the same numbers were read ("$72 is BEFORE fees").
  const replacing = /\b(?:new version|now|replace[sd]?|instead|updated?|changed?)\b/i.test(t);
  if (replacing) {
    const qty = /\b(?:now\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:(?:seats?|tickets?)\b)/i.exec(t);
    const n = qty ? WORDS[qty[1]!.toLowerCase()] ?? Number(qty[1]) : null;
    if (n && n !== fields.quantity) {
      out.quantity = n;
      changes.push(`${countWordLower(n)} tickets`);
    }
    const seats = /\bseats?\s+(\d{1,3})\s*(?:[-–]|to|through)\s*(\d{1,3})\b/i.exec(t);
    if (seats) {
      const [from, to] = [Number(seats[1]), Number(seats[2])];
      const list = to >= from && to - from < 20 ? Array.from({ length: to - from + 1 }, (_, k) => String(from + k)) : null;
      if (list && list.join(',') !== (fields.seatNumbers ?? []).join(',')) {
        out.seatNumbers = list;
        changes.push(`seats ${from} to ${to}`);
      }
    }
    const each = /(?:base price is\s+)?\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:each|per ticket|a ticket)\b/i.exec(t);
    if (each && cents(each[1]!) !== fields.perTicketCents) {
      out.perTicketCents = cents(each[1]!);
      out.feeBasis = /\bbase\b|before fees|plus (?:a\s+)?\$/i.test(t) ? 'before_fees' : /including|incl\.?\s+fees|all[- ]in/i.test(t.slice(each.index, each.index + 60)) ? 'all_in' : 'unknown';
      changes.push(`${formatUsd(out.perTicketCents)} a ticket${out.feeBasis === 'before_fees' ? ' before fees' : out.feeBasis === 'all_in' ? ' including fees' : ''}`);
    }
  }
  const per = out.perTicketCents;
  if (per !== null && per === fields.perTicketCents) {
    const amt = `\\$\\s?${(per / 100).toFixed(per % 100 ? 2 : 0).replace('.', '\\.')}(?:\\.00)?`;
    if (new RegExp(`${amt}\\s*(?:per ticket|each|a ticket|/ticket)?\\s*(?:is\\s+)?(?:before|plus|excluding|not including)\\s+(?:any\\s+)?fees`, 'i').test(t) && fields.feeBasis !== 'before_fees') {
      out.feeBasis = 'before_fees';
      changes.push(`${formatUsd(per)} a ticket is before fees`);
    } else if (new RegExp(`${amt}\\s*(?:per ticket|each|a ticket)?\\s*(?:including|incl\\.?|with)\\s+(?:all\\s+|every\\s+)?fees?`, 'i').test(t) && fields.feeBasis !== 'all_in') {
      out.feeBasis = 'all_in';
      changes.push(`${formatUsd(per)} a ticket includes fees`);
    }
  }
  // Their budget is not the listing's price: "Keep the $200 total cap", "my BUDGET stayed $200" (TGQA-R6 1002).
  const t2 = t.replace(/\b(?:budget|cap|max(?:imum)?|up to|under|no more than|spend|afford)\b[^.?!$]{0,30}\$\s?\d[\d,]*(?:\.\d{2})?(?:\s*(?:in\s+)?total)?|\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:in\s+)?(?:total\s+)?(?:cap|budget|max(?:imum)?|limit)\b/gi, ' ');
  const fee = /\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:in\s+)?(?:fees?\s+)?(?:for|per|on)\s+(?:the\s+)?(?:whole\s+|entire\s+)?order\b/i.exec(t2) ?? /\$\s?(\d[\d,]*(?:\.\d{2})?)\s*fee\s+for\s+(?:the\s+)?(?:whole|entire)\s+order\b/i.exec(t2);
  const total = /\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:in\s+)?total\b|\btotal\s+\$\s?(\d[\d,]*(?:\.\d{2})?)/i.exec(t2);
  const q = out.quantity;
  if (total && cents((total[1] ?? total[2])!) !== fields.wholePartyCents) {
    out.wholePartyCents = cents((total[1] ?? total[2])!);
    changes.push(`${formatUsd(out.wholePartyCents)} in total`);
  } else if (!total && fee && per !== null && q) {
    const w = per * q + cents(fee[1]!);
    if (w !== fields.wholePartyCents) {
      out.wholePartyCents = w;
      changes.push(`${formatUsd(w)} in total`);
    }
  }
  // Restating the numbers we already read ("still $52 each plus a $24 fee, total $180") is not a correction.
  const restated = !changes.length && fee && per !== null && q && fields.feeBasis === 'before_fees' && fields.wholePartyCents === per * q + cents(fee[1]!);
  if (fee && per !== null && q && !restated && out.wholePartyCents !== null && out.wholePartyCents > per * q) changes.push(`that includes ${formatUsd(cents(fee[1]!))} in fees for the order, so ${formatUsd(Math.round(out.wholePartyCents / q))} each including fees`);
  const by = /\bdeliver(?:y|ed)?\s+(?:is\s+)?(?:now\s+)?(?:by|before)\s+(noon|midday|\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i.exec(t);
  if (by && !(fields.deliveryText ?? '').toLowerCase().replace(/\s+/g, '').includes(by[1]!.toLowerCase().replace(/\s+/g, '').replace(/:00/, ''))) {
    out.deliveryText = `delivery by ${by[1]!.replace(/\s+/g, '').toLowerCase()}${/game day|event day|on the day|on october|on oct/i.test(t) ? ' on the day' : ''}`;
    changes.push(`delivery by ${by[1]!.replace(/\s+/g, '').toLowerCase()}`);
  }
  return { fields: out, changes, matches: !!restated };
}

/**
 * The one price check we can make without seeing seats: the provider's lowest face value times the party, against
 * their total. When that alone is over, the budget line says so with the arithmetic instead of "check the total"
 * (live G02: 3 × $59.10 = $177.30 before fees, over a $150 cap). Face value is before fees, so it is a floor.
 */
export function withFaceValueCheck(reqs: string[], x: RequestExtraction, event: { faceMinCents: number | null }): string[] {
  const total = wholePartyBudgetCents(x.budgetCents, x.budgetBasis, x.quantity);
  const q = x.quantity;
  if (total === null || !q || event.faceMinCents == null || event.faceMinCents * q <= total) return reqs;
  const floor = event.faceMinCents * q;
  const line = `${formatUsd(total)} in total: Ticketmaster lists these from ${formatUsd(event.faceMinCents)} a ticket before fees, so ${countWordLower(q)} already come to ${formatUsd(floor)} before fees, over your ${formatUsd(total)}`;
  return reqs.map((r) => (r.startsWith(`${formatUsd(total)} in total`) ? line : r));
}

/** Keep supplied HTTPS references as references, without inventing a checkout or claiming a source was read. */
function musicSourceLinks(messages: string[]): string[] {
  return [...new Set(messages.flatMap((m) => flat(m).match(/https:\/\/[^\s<>"']+/g) ?? []))].slice(-3);
}

/** Latest explicit concert facts win; omitted facts stay bound to the same product. */
function mergeConcertOffer(old: TextOffer, next: TextOffer): TextOffer {
  const hasPrice = next.totalCents !== null || next.perTicketCents !== null;
  const samePrice = (next.totalCents ?? next.perTicketCents) === (old.totalCents ?? old.perTicketCents);
  const newAllInPrice = hasPrice && next.feeBasis === 'all_in';
  const retainPrice = !hasPrice || samePrice && !next.priceBasisStated;
  const replaced = next.productKind !== 'unknown' && old.productKind !== 'unknown' && next.productKind !== old.productKind;
  if (replaced) return next;
  return { ...next,
    admission: next.admissionStated ? next.admission : old.admission,
    admissionStated: next.admissionStated || old.admissionStated,
    productKind: next.productKind !== 'unknown' ? next.productKind : old.productKind,
    entry: next.entry ?? old.entry,
    totalCents: retainPrice ? old.totalCents : next.totalCents,
    perTicketCents: retainPrice ? old.perTicketCents : next.perTicketCents,
    feeBasis: next.feeBasis !== 'unknown' ? next.feeBasis : old.feeBasis,
    orderFeeCents: newAllInPrice ? next.orderFeeCents : next.orderFeeCents ?? old.orderFeeCents,
    perTicketFeeCents: newAllInPrice ? next.perTicketFeeCents : next.perTicketFeeCents ?? old.perTicketFeeCents,
    noOtherCharges: next.noOtherCharges || old.noOtherCharges,
    quantity: next.quantity ?? old.quantity,
    together: next.together ?? old.together,
    mustBuyAll: next.mustBuyAll || old.mustBuyAll,
    obstructed: next.obstructed ?? old.obstructed,
    section: next.section ?? old.section,
    row: next.row ?? old.row,
    deliveryStated: next.deliveryStated || old.deliveryStated,
    deliveryMinutes: next.deliveryMinutes ?? old.deliveryMinutes,
    deliveryAsWritten: next.deliveryAsWritten ?? old.deliveryAsWritten,
  };
}

/**
 * The offers this message is about: the ones it lays out; else, when it talks about offers without naming new ones
 * ("which of the same offers?", "just compare the three offers I pasted"), the ones laid out earlier in the thread;
 * else the one it keeps from an earlier comparison ("ignore Offer A, only B"), with the others set aside.
 */
export function suppliedOffers(said: string, threadMessages: string[], tz: string): { textOffers: TextOffer[]; offersSetAside: string[] } {
  // Fold each concert correction into the product records. A one-product correction must not erase the other
  // product, nor lose an exclusion after several price-only turns. An explicit "only B" still sets A aside.
  if (partyTerms(threadMessages).concertAdmission) {
    let retained: TextOffer[] = [];
    let offersSetAside: string[] = [];
    const history = threadMessages.at(-1) === said ? threadMessages : [...threadMessages, said];
    for (const message of history) {
      const updates = offersInText(message, tz, 1);
      if (!updates.length) continue;
      const only = /\b(?:only|just) (?:offer |option )?([A-E])\b/i.exec(message)?.[1]?.toUpperCase();
      if (only && updates.some((o) => o.label === only) && /\b(?:ignore|set aside|on its own|only|just)\b/i.test(message)) {
        offersSetAside = retained.filter((o) => o.label !== only).map((o) => o.name);
        retained = retained.filter((o) => o.label === only);
      }
      for (const update of updates) {
        if (only && update.label !== only) continue;
        const i = retained.findIndex((o) => o.label === update.label);
        if (i < 0) retained.push(update);
        else retained[i] = mergeConcertOffer(retained[i]!, update);
      }
    }
    const latestNames = offersInText(said, tz, 1).length > 0;
    const referringBack = /\b(?:offers?|options?|quotes?|listings?|same|those|these)\b/i.test(said);
    if ((latestNames || referringBack) && (retained.length >= 2 || offersSetAside.length)) return { textOffers: retained, offersSetAside };
  }
  // Every offer in the thread, one record each, later mentions folded in: a restatement that leaves something out
  // ("B is still immediate transfer") keeps it, a renamed offer ("Offer A (Gold)") is the same one, and a follow-up
  // that changes only their requirements ("scattered singles are now acceptable") is judged on the same offers
  // (TGQA-R8 S05). A new set of offers at new prices is read fresh, not inherited.
  const history = threadMessages.at(-1) === said ? threadMessages : [...threadMessages, said];
  const latest = offersInText(said, tz, 1, { priceless: true });
  const refersBack = REFERS_BACK.test(flat(said));
  const all = offerHistory(history, tz, { fresh: !refersBack });
  const pick = (ls: TextOffer[]) => all.filter((o) => ls.some((l) => sameOffer(o, l)));
  let textOffers: TextOffer[] = [];
  let offersSetAside: string[] = [];
  if (latest.length >= 2) textOffers = pick(latest);
  else if (latest.length === 1 && all.length >= 2) {
    const kept = pick(latest)[0];
    // "Ignore A, only B", "B on its own": that one alone, the others set aside and named (live R05-F1).
    if (kept && ONE_OFFER_ALONE.test(flat(said))) {
      textOffers = [kept];
      offersSetAside = all.filter((o) => o !== kept).map((o) => o.name);
    } else if (kept) textOffers = all;
  } else if (!latest.length && all.length >= 2 && ASKS_ABOUT_OFFERS.test(said)) textOffers = all;
  if (textOffers.length === 1 && !offersSetAside.length) textOffers = [];
  return { textOffers, offersSetAside };
}

/** A follow-up about the offers already sent: the same ones, maybe with a requirement changed. */
const REFERS_BACK = /\b(?:same|still|again|(?:not|haven'?t|hasn'?t|have not|has not) changed|unchanged|remains?|those|these|earlier|original|as before|you (?:correctly )?said|restor\w*|correct(?:ion|ed)?|the prices|my pick|your pick)\b/i;
/** "Ignore Offer A, only B", "B on its own", "just B". */
const ONE_OFFER_ALONE = /\b(?:ignore|set aside|forget|drop|disregard|on its own|by itself|only (?:offer |option )?[A-Z]\b|just (?:offer |option )?[A-Z]\b)/i;
/** They ask about the offers without naming one: "which of the offers I pasted?", "does that change your pick?" */
const ASKS_ABOUT_OFFERS = /\b(?:offers?|options?|listings?|sellers?|prices? I (?:pasted|gave|sent)|(?:change|changes) (?:your|the) pick|which (?:one|is cheaper|fits|costs less)|the totals?)\b/i;

/** "Better to buy now or wait?", "do you have price history showing prices falling?", "trending down or up". */
const TREND_ASKED = /\b(?:price history|history window|trend(?:ing|s)?|prices? (?:are |be )?(?:falling|dropping|rising|going (?:up|down))|buy (?:now|today) or wait|buy now or hold off|(?:is|would) waiting|should (?:I|we) wait|worth waiting|wait for (?:prices?|a drop))\b/i;
/** "Please don't set up any alerts". */
const NO_ALERTS = /\b(?:don'?t|do not|no need to)\s+set(?:\s+up)?\s+(?:any\s+)?(?:alerts?|a watch|watches)\b|\bno alerts?\b/i;
/** "Will you email me when tickets go on sale, or should I check myself?" */
const ON_SALE_ASKED = /\b(?:email|tell|let|notify|alert)\s+me\s+when\s+(?:the\s+)?(?:tickets?|they)\s+go\s+on\s+sale\b|\bwhen (?:they|tickets?) go on sale\b|\bon[- ]sale (?:date|alert)\b/i;

/**
 * The whole-party budget they gave, with its provenance checked: kept when budget words carry it, or when it is
 * none of the prices their offers carry anywhere in the thread; a price they saw is never their cap.
 */
export function customerBudget(merged: RequestExtraction, threadTexts: string[], quantity: number, tz: string): number | null {
  const cents = wholePartyBudgetCents(merged.budgetCents, merged.budgetBasis, quantity);
  if (cents === null || merged.budgetCents === null) return null;
  if (BUDGET_WORDS.test(flat(threadTexts.join('\n')))) return cents;
  const offers = threadTexts.flatMap((m) => offersInText(m, tz, 1));
  const amounts = new Set(offers.flatMap((o) => [o.totalCents, o.perTicketCents, o.perTicketCents !== null && o.quantity !== null ? o.perTicketCents * o.quantity : null]));
  return amounts.has(merged.budgetCents) || amounts.has(cents) ? null : cents;
}

/** Words that make a dollar figure their budget rather than a price they saw. */
const BUDGET_WORDS = /\b(?:budget|up to|max(?:imum)?|cap|limit|spend|no more than|at most|afford|willing to pay|under \$)\b/i;

/** Whether this amount is a price their offers or listings carry: an offer's own figure, or one said of a listing. */
function isListingPrice(text: string, cents: number, offers: TextOffer[]): boolean {
  if (offers.some((o) => o.perTicketCents === cents || o.totalCents === cents || (o.perTicketCents !== null && o.quantity !== null && o.perTicketCents * o.quantity === cents))) return true;
  const d = cents % 100 ? (cents / 100).toFixed(2).replace('.', '\\.') : String(cents / 100);
  const sellers = 'stubhub|ticketmaster|seatgeek|vivid(?: seats)?|tickpick|gametime|axs';
  // Before it ("StubHub, sec 112 row 8, $412") or after it ("$412 total including all fees on StubHub").
  return new RegExp(`\\b(?:listings?|offers?|sellers?|found|priced|costs?|selling|asking|looking at|${sellers})\\b[^.?!]{0,120}\\$\\s?${d}(?:\\.00)?\\b|\\$\\s?${d}(?:\\.00)?\\b[^.?!]{0,60}\\b(?:on|at|from|via)\\s+(?:${sellers})\\b`, 'i').test(text);
}

const countWordLower = (n: number) => (['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][n] ?? String(n));


/** They already have tickets and are asking how to get in with them (a barcode image, a transfer, entry). */
/**
 * A question about something other than tickets, asked around a game or show ("easy dinner spots near MSG before a
 * Rangers game?"): food, drink, parking directions. Only when they aren't also asking about tickets themselves.
 */
export function asksOutsideTickets(text: string): boolean {
  // A drink minimum or food spend is part of what the ticket costs, not a dinner question.
  const t = flat(text).replace(/\b(?:(?:any|the)\s+)?(?:compulsory|mandatory|required|minimum)?\s*(?:food|drinks?)(?:\s*(?:or|and|\/)\s*(?:food|drinks?))?\s+(?:spend|minimums?|charges?)\b|\b(?:two|2|one|1)?[-\s]*drink\s+minimums?\b/gi, ' ');
  const food = /\b(?:dinner|lunch|brunch|restaurants?|places? to eat|eat(?:ing)?|food|bars?|drinks? spots?|pre-?game (?:meal|drinks?))\b/i.test(t) && /\b(?:near|around|close to|walk(?:ing)? (?:of|from|distance)|before|after|spots?|places?|recommend|suggest)\b/i.test(t);
  if (!food) return false;
  // "Tickets and dinner nearby?" still asks for tickets; "we already have the tickets" doesn't.
  const shopping = /\b(?:need|want|looking for|find|get)\b[^.?!]{0,30}\b(?:tickets?|seats?)\b/i.test(t) && !/\b(?:don'?t|do not|no)\s+need\s+(?:any\s+)?(?:new\s+)?tickets?\b/i.test(t);
  return !shopping;
}

export function entryHelpAsked(text: string): boolean {
  const t = flat(text);
  // "Already paid", "the seller sent me this picture": bought, whichever word they use (TGQA-R6 1005).
  const bought = /\b(?:already\s+(?:bought|purchased|paid|have|got)|(?:I|we)\s+(?:just\s+|already\s+)?(?:bought|purchased|paid for)|(?:I|we)\s+have\s+(?:the|our|my)\s+tickets|got\s+(?:our|my)\s+tickets)\b/i.test(t);
  const sellerSent = /\bseller\s+(?:only\s+|just\s+)?(?:sent|has sent|gave)\b/i.test(t);
  const entry = /\b(?:barcode|bar code|screenshot|pdf|image|picture|transfer(?:red|s)?|get\s+(?:us|me|in)\b|into the (?:show|game|venue)|entry|scan(?:ned)?|let (?:us|me) in|at the gate|at the door)\b/i.test(t);
  // A seller's picture is only about getting in when they ask about getting in, not about a listing's price.
  const getIn = /\b(?:barcode|bar code|transfer(?:red|s)?|get\s+(?:us|me)\s+in(?:to)?\b|into the (?:show|game|venue)|entry|scan(?:ned)?|let (?:us|me) in|at the gate|at the door)\b/i.test(t);
  return (bought && entry) || (sellerSent && getIn);
}

/** They say the seats themselves aren't accessible spaces ("Neither seat is a wheelchair or companion space"). */
export const SEATS_NOT_ACCESSIBLE = /\b(?:neither|none|no)\b[^.!?]{0,40}\b(?:is|are|seats?)\b[^.!?]{0,12}\b(?:an?\s+)?(?:wheelchair|accessible|companion|ada)\b|\b(?:seats?|spaces?|they|these|those|it)\s+(?:is|are)(?:n't| not)\s+(?:an?\s+)?(?:wheelchair|accessible|companion|ada)\b|\bnon-?accessible\b|\bordinary seats?\b[^.!?]{0,30}\bnot\s+(?:wheelchair|accessible)\b/i;

/** "no obstructed views", "not an obstructed view", "without a limited view": a view they ruled out. */
export const NO_OBSTRUCTED = /\b(?:no|not|never|without|avoid|can't have|cannot have|can’t have|don't want|don’t want|do not want|won't take|won’t take)\s+(?:an?\s+|any\s+)?(?:obstructed|limited|restricted|partial)(?:[\s-]+views?)?\b|\bunobstructed (?:only|views? only)\b|\bmust (?:be|have) (?:an? )?(?:unobstructed|clear view)\b/i;

/** "how much less is it than A", "compared with Offer B": the offer they want the pick measured against. */
export function comparedAgainst(text: string, labels: string[]): string | null {
  // The label is a capital or digit: "cheaper than a ticket" isn't Offer A.
  const m = /\b(?:[Tt]han|[Cc]ompared (?:to|with)|[Vv]ersus|vs\.?|[Aa]gainst|[Rr]elative to)\s+(?:[Oo]ffer\s+|[Oo]ption\s+|[Ll]isting\s+)?([A-Z1-9])\b/.exec(text);
  const l = m?.[1] ?? null;
  return l && labels.includes(l) ? l : null;
}

/** "the attached image", "see attachment", "this screenshot": they meant to send us a picture. */
const SAYS_ATTACHED = /\b(?:attached|attachment|enclosed)\b|\b(?:this|the|my)\s+(?:screenshot|screen shot|image|picture|photo)\b/i;
export const IMAGE_UNREAD_ASK = 'Could you type out what it shows: the event and date, how many tickets, the section and row, and the total including fees? Those few details are all I need.';
export function imageUnreadLine(kind: 'unread' | 'missing'): string {
  return kind === 'missing'
    ? 'Your email mentions an attachment, but no image reached me, so I haven’t assumed anything about the tickets.'
    : 'I couldn’t read the image you attached, so I haven’t used anything from it or assumed anything about the tickets.';
}
export const REDACTED_NOTE = 'One of your screenshots looked like it showed a ticket barcode, card details or an ID, so I deleted it and didn’t use it. A screenshot of the listing page (price, section, row) is all I need.';

/** The name of a known team or artist inside some text, longest match first ("New York Rangers" over "New York"). */
function knownNameIn(text: string, known: Array<{ name: string; aliases: string[] }>): string | null {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  let best: { name: string; len: number } | null = null;
  for (const k of known) {
    for (const n of [k.name, ...k.aliases]) {
      const w = n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (w.length >= 4 && hay.includes(` ${w} `) && (!best || w.length > best.len)) best = { name: k.name, len: w.length };
    }
  }
  return best?.name ?? null;
}

/**
 * Folds what a listing showed into this message's extraction, only where the customer's words left a gap:
 * what they typed wins. A price whose wording didn't say per ticket or total stays "basis unknown", so the
 * reply says how it was read.
 */
export function applyListingFields(x: RequestExtraction, f: ListingFields, known: Array<{ name: string; aliases: string[] }>): RequestExtraction {
  const out: RequestExtraction = { ...x, ambiguities: [...x.ambiguities] };
  if (out.quantity == null && f.quantity) {
    out.quantity = f.quantity;
    out.ambiguities = out.ambiguities.filter((a) => a !== 'quantity_unclear');
  }
  if (out.quotedPriceCents == null && f.perTicketCents) {
    out.quotedPriceCents = f.perTicketCents;
    out.quotedPriceBasis = f.priceBasis === 'unknown' ? null : 'per_ticket';
  }
  if (!out.resolvedLocalDate && f.eventDate) {
    out.resolvedLocalDate = f.eventDate;
    out.dateExpression ??= f.eventDate;
    out.ambiguities = out.ambiguities.filter((a) => !a.startsWith('date_'));
  }
  // A matchup ("Rangers vs. Islanders") is the first-named team's game, as when the customer types it.
  if (!out.performerOrTeam && f.eventName) out.performerOrTeam = knownNameIn(splitMatchup(f.eventName)?.first ?? f.eventName, known) ?? knownNameIn(f.eventName, known);
  if (!out.eventName && f.eventName) out.eventName = f.eventName;
  if (!out.city && f.city) out.city = f.city;
  return out;
}

export function mergeExtraction(prior: RequestExtraction, next: RequestExtraction): RequestExtraction {
  const out: RequestExtraction = { ...prior };
  for (const k of Object.keys(next) as Array<keyof RequestExtraction>) {
    const v = next[k];
    if (k === 'evidence' || k === 'submittedUrls' || k === 'negatedEntities') (out as Record<string, unknown>)[k] = [...(prior[k] as unknown[]), ...(v as unknown[])];
    else if (k === 'ambiguities') out.ambiguities = next.ambiguities;
    else if (k === 'intent') out.intent = next.intent === 'clarification' ? prior.intent : next.intent;
    else if (k === 'wantsMore') out.wantsMore = next.wantsMore; // about this message's list, never the next one's
    else if (k === 'notifyAsked') out.notifyAsked = next.notifyAsked; // this message's ask; a later reply must not re-arm a cancelled or sent alert
    else if (k === 'city' || k === 'state') continue; // a place is moved as one, below
    else if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  // A new place replaces the old one whole: "they're playing in Connecticut" after "Metallica in NY" is
  // Connecticut, not New York City with a CT state code beside it.
  if (next.city || next.state) [out.city, out.state] = [next.city, next.state];
  return out;
}

/**
 * What we understood, one line each. Once the event is resolved the email already names it exactly, so the
 * customer's own looser wording ("Miami Dolphins in Miami (in october)") is left out rather than repeated.
 */
/**
 * What the acknowledgment says we understood, as a person would jot it down: the game or show, when, where,
 * how many, the budget, and the question they asked. Every line is something they told us or we found.
 */
export function acknowledgedFacts(e: { name: string; category: string; localStartAt: Date }, v: { name: string; city: string | null; timezone: string }, x: RequestExtraction, text: string): string[] {
  const sports = ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer'].includes(e.category);
  const when = new Intl.DateTimeFormat('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(e.localStartAt);
  const out = [`${sports ? 'Game' : 'Show'}: ${e.name}`, `When: ${when}`, `Where: ${v.name}${v.city ? `, ${v.city}` : ''}`];
  if (x.quantity) out.push(`Tickets: ${x.quantity}${x.togetherRequired ? ', together' : ''}`);
  if (x.budgetCents !== null && x.budgetBasis) out.push(`Budget: ${formatUsd(x.budgetCents)} ${x.budgetBasis === 'whole_party' ? 'total' : 'a ticket'}`);
  // Their question as they asked it (retest R2-B02/B04): a delivery or two-offer question is not a price check.
  const asked = questionsAsked(text);
  const offers = offersInText(text);
  const question = offers.length >= 2
    ? `which of the ${offers.length === 2 ? 'two' : countWords(offers.length)} offers to choose`
    : asked.deliveryRisk
      ? 'whether the delivery timing is a risk for your trip'
      : x.quotedPriceCents != null
    ? `whether ${formatUsd(x.quotedPriceCents)} is a good price`
    : /\b(buy now|hold off|wait (?:until|till|for|closer)|should i (?:buy|wait)|good time to buy|now or later|buy or wait)\b/i.test(text)
      ? 'whether to buy now or hold off'
      : x.resaleAsked ? 'whether resale is cheaper' : null;
  if (question) out.push(`You asked: ${question}`);
  return out;
}

export function describeKnown(x: RequestExtraction, opts: { eventResolved?: boolean } = {}): string[] {
  const parts: string[] = [];
  const place = x.city ?? (stateOnly(x) ? US_STATES[stateOnly(x)!] : null);
  if (x.performerOrTeam && !opts.eventResolved) parts.push(`Event: ${x.performerOrTeam}${place ? ` in ${place}` : ''}${x.dateExpression ? ` (${x.dateExpression})` : ''}`);
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
  // An unstated party size stays unknown and is asked once: two was assumed, and a party of three or a lone
  // wheelchair user was then judged as a pair (TGQA-R6 1008). The number decides the total, adjacency and fit.
  // A per-ticket price check ("is $106 a good deal?") doesn't turn on it, so it goes ahead on two, said once.
  const perTicketCheck = brief.quantity === null && brief.quotedPriceCents !== null && brief.quotedPriceBasis !== 'whole_party' && brief.budgetCents === null && !brief.togetherRequired && !brief.accessibilityNeeds;
  if (perTicketCheck) {
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
  if (reason === 'deletion_verified_pending_completion') return 'a customer verified a data deletion request: complete it from their contact page';
  if (reason === 'staff_comparison') return 'a comparison was promised: find seats that meet their requirements';
  // Which cap it was: the whole service's day, or this request (post-#56 QA: "this request" was said for both).
  if (reason.startsWith('extraction_failed:budget_exceeded')) return /\(global_daily\)/.test(reason) ? 'the service’s daily AI budget is used up' : /\(call_count\)/.test(reason) ? 'this request made too many AI calls' : 'the AI budget for this request ran out';
  if (reason.startsWith('extraction_failed:rejected')) return `the AI provider refused the call (check the model name, API key and billing): ${reason.split(': ').slice(1).join(': ').slice(0, 160)}`;
  if (reason.startsWith('work_failed:')) return `the AI provider kept failing, so this was stopped after several tries: ${reason.split(': ').slice(1).join(': ').slice(0, 160)}`;
  if (reason.startsWith('extraction_failed:')) return `the AI could not read the message (${reason.split(':')[1] ?? 'unknown'})`;
  return reason.split(':')[0]!.replace(/_/g, ' ');
}

/** "9am–9pm ET" from the staffed-hours settings, for the holding reply. */
export function staffedHoursLabel(e: { STAFFED_HOURS_START: number; STAFFED_HOURS_END: number; STAFFED_HOURS_TIMEZONE: string }): string {
  const h = (n: number) => (n === 0 || n === 24 ? '12am' : n === 12 ? '12pm' : n < 12 ? `${n}am` : `${n - 12}pm`);
  const zone = e.STAFFED_HOURS_TIMEZONE === 'America/New_York' ? 'ET' : e.STAFFED_HOURS_TIMEZONE;
  return `${h(e.STAFFED_HOURS_START)} to ${h(e.STAFFED_HOURS_END)} ${zone}`;
}
