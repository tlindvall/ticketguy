/**
 * Single pg-core schema shared by PGlite (local/tests) and PostgreSQL 18 (Render).
 * Money is integer USD cents. Timestamps are timestamptz (UTC). IDs are UUIDs unless a provider ID.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigint,
} from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array | Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => v,
  fromDriver: (v) => (v instanceof Uint8Array ? v : Buffer.from(v as ArrayBufferLike)),
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Better Auth (staff only). Property names follow Better Auth's default field names.
// ---------------------------------------------------------------------------
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role').notNull().default('reviewer'), // 'admin' | 'reviewer'
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: ts('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: ts('locked_until'),
  },
  (t) => [index('two_factor_user_idx').on(t.userId), index('two_factor_secret_idx').on(t.secret)],
);

// ---------------------------------------------------------------------------
// Contacts and conversations
// ---------------------------------------------------------------------------
export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    emailOriginal: text('email_original').notNull(),
    // Conservative lookup: lowercase only. Never strip Gmail dots/plus tags globally.
    emailLookup: text('email_lookup').notNull(),
    countryConfirmed: text('country_confirmed'), // ISO 3166-1 alpha-2 once explicitly confirmed; null = unknown
    status: text('status').notNull().default('active'), // active | deleted | blocked
    createdAt: createdAt(),
    lastInboundAt: ts('last_inbound_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [uniqueIndex('contacts_email_lookup_uq').on(t.emailLookup)],
);

export const contactPreferences = pgTable('contact_preferences', {
  id: id(),
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' })
    .unique(),
  region: text('region'),
  timezone: text('timezone'),
  frequency: text('frequency'),
  mustAttendDefault: boolean('must_attend_default'),
  waitRiskTolerance: text('wait_risk_tolerance'), // 'low' | 'medium' | 'high' | null
  splitGroupAllowed: boolean('split_group_allowed'),
  updateEvidence: jsonb('update_evidence').$type<Record<string, unknown>>(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    subject: text('subject'),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull().default('open'),
    lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('conversations_contact_idx').on(t.contactId, t.lastActivityAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    direction: text('direction').notNull(), // inbound | outbound
    provider: text('provider').notNull(), // resend | simulator
    providerEmailId: text('provider_email_id'),
    rfcMessageId: text('rfc_message_id'),
    inReplyTo: text('in_reply_to'),
    referencesHeader: text('references_header'),
    fromAddress: text('from_address').notNull(),
    toAddresses: jsonb('to_addresses').$type<string[]>().notNull(),
    subject: text('subject'),
    sanitizedText: text('sanitized_text'),
    rawMediaId: uuid('raw_media_id'),
    authenticationSummary: jsonb('authentication_summary').$type<Record<string, unknown>>(),
    autoSubmitted: boolean('auto_submitted').notNull().default(false),
    receivedAt: ts('received_at').notNull(),
    createdAt: createdAt(),
    purgeAt: ts('purge_at'),
  },
  (t) => [
    uniqueIndex('messages_provider_email_uq').on(t.provider, t.direction, t.providerEmailId),
    index('messages_rfc_idx').on(t.rfcMessageId),
    index('messages_conversation_idx').on(t.conversationId, t.receivedAt),
  ],
);

export const mediaObjects = pgTable(
  'media_objects',
  {
    id: id(),
    ownerKind: text('owner_kind').notNull(), // message | attachment | raw_mime
    ownerId: uuid('owner_id').notNull(),
    mimeType: text('mime_type').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    bytes: bytea('bytes').notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('media_owner_idx').on(t.ownerKind, t.ownerId), check('media_len_pos', sql`${t.byteLength} >= 0`)],
);

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id),
    providerAttachmentId: text('provider_attachment_id'),
    filename: text('filename'),
    declaredMimeType: text('declared_mime_type'),
    detectedMimeType: text('detected_mime_type'),
    byteLength: integer('byte_length'),
    sha256: text('sha256'),
    width: integer('width'),
    height: integer('height'),
    mediaId: uuid('media_id').references(() => mediaObjects.id),
    validationState: text('validation_state').notNull().default('pending'), // pending | accepted | rejected | quarantined | pending_budget
    validationReason: text('validation_reason'),
    purgeAt: ts('purge_at'),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_message_idx').on(t.messageId)],
);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
export const requests = pgTable(
  'requests',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    mode: text('mode').notNull().default('find_options'), // beat_offer | find_options | keep_looking
    category: text('category'),
    state: text('state').notNull().default('received'),
    currentRevision: integer('current_revision').notNull().default(1),
    eventId: uuid('event_id'),
    deadlineAt: ts('deadline_at'),
    ownerUserId: text('owner_user_id'),
    countryConfirmed: text('country_confirmed'),
    failureReason: text('failure_reason'),
    clarificationCount: integer('clarification_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('requests_state_deadline_idx').on(t.state, t.deadlineAt), index('requests_contact_idx').on(t.contactId)],
);

export const requestVersions = pgTable(
  'request_versions',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    revision: integer('revision').notNull(),
    brief: jsonb('brief').$type<Record<string, unknown>>().notNull(),
    sourceMessageIds: jsonb('source_message_ids').$type<string[]>().notNull(),
    unresolvedFields: jsonb('unresolved_fields').$type<string[]>().notNull(),
    createdBy: text('created_by').notNull(), // 'system' | user id
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('request_versions_uq').on(t.requestId, t.revision)],
);

export const requestTransitions = pgTable(
  'request_transitions',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    revision: integer('revision').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('request_transitions_request_idx').on(t.requestId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Events, venues, entities
// ---------------------------------------------------------------------------
export const venues = pgTable('venues', {
  id: id(),
  name: text('name').notNull(),
  aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  city: text('city'),
  state: text('state'),
  country: text('country').notNull().default('US'),
  timezone: text('timezone').notNull(),
  layoutVersion: text('layout_version'),
  createdAt: createdAt(),
});

export const entities = pgTable('entities', {
  id: id(),
  kind: text('kind').notNull(), // performer | team | production
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  league: text('league'),
  homeVenueId: uuid('home_venue_id').references(() => venues.id),
  createdAt: createdAt(),
});

export const events = pgTable(
  'events',
  {
    id: id(),
    name: text('name').notNull(),
    category: text('category').notNull(), // concert | nhl | nba | mlb | ...
    subtype: text('subtype'), // preseason | regular_season | playoffs | matinee | ...
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id),
    primaryEntityId: uuid('primary_entity_id').references(() => entities.id),
    opponentEntityId: uuid('opponent_entity_id').references(() => entities.id),
    isHome: boolean('is_home'),
    localStartAt: ts('local_start_at').notNull(), // stored as instant; render in venue timezone
    status: text('status').notNull().default('scheduled'),
    verifiedSourceId: text('verified_source_id'),
    isFixture: boolean('is_fixture').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('events_venue_start_idx').on(t.venueId, t.localStartAt), index('events_entity_idx').on(t.primaryEntityId)],
);

export const eventSourceMappings = pgTable(
  'event_source_mappings',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    sourceId: text('source_id').notNull(),
    sourceEventId: text('source_event_id'),
    authoritativeUrl: text('authoritative_url'),
    role: text('role').notNull(), // official_primary | official_resale | marketplace | discovery
    confidence: text('confidence').notNull().default('unverified'),
    verifiedAt: ts('verified_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('event_source_mappings_uq').on(t.sourceId, t.sourceEventId)],
);

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
export const sourceRegistry = pgTable('source_registry', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  groupName: text('group_name').notNull(),
  sourceType: text('source_type').notNull(),
  categories: jsonb('categories').$type<string[]>().notNull(),
  routingTier: text('routing_tier').notNull(),
  routingNote: text('routing_note').notNull(),
  evidenceUrl: text('evidence_url').notNull(),
  evidenceLevel: text('evidence_level').notNull(),
  researchDate: text('research_date').notNull(),
  integrationStatus: text('integration_status').notNull().default('not_integrated'),
  accessRights: text('access_rights').notNull().default('not_validated'),
  usEventOnly: boolean('us_event_only').notNull().default(true),
  vettingStatus: text('vetting_status').notNull(),
  registryVersion: text('registry_version').notNull(),
  importedAt: createdAt(),
});

export const adapterConfigs = pgTable('adapter_configs', {
  id: id(),
  sourceId: text('source_id')
    .notNull()
    .references(() => sourceRegistry.id)
    .unique(),
  implementation: text('implementation').notNull(), // fixture | manual | ticketmaster_discovery | ...
  enabled: boolean('enabled').notNull().default(false),
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
  accessApprovalEvidence: text('access_approval_evidence'),
  monitoringAllowed: boolean('monitoring_allowed').notNull().default(false),
  retentionDays: integer('retention_days'),
  dailyCallLimit: integer('daily_call_limit'),
  ratePerSecond: integer('rate_per_second'),
  secretRef: text('secret_ref'),
  lastHealth: jsonb('last_health').$type<Record<string, unknown>>(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: ts('reviewed_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const researchRuns = pgTable(
  'research_runs',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    revision: integer('revision').notNull(),
    mode: text('mode').notNull(), // fixture | manual | live
    status: text('status').notNull().default('running'),
    budgetUsdMicros: bigint('budget_usd_micros', { mode: 'number' }),
    startedAt: createdAt(),
    completedAt: ts('completed_at'),
    supersededAt: ts('superseded_at'),
  },
  (t) => [index('research_runs_request_idx').on(t.requestId, t.revision)],
);

export const sourceChecks = pgTable(
  'source_checks',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => researchRuns.id),
    sourceId: text('source_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    eventMappingId: uuid('event_mapping_id'),
    status: text('status').notNull(), // SourceStatus
    reasonCode: text('reason_code'),
    observedAt: ts('observed_at').notNull(),
    sourceAsOf: ts('source_as_of'),
    resultCount: integer('result_count').notNull().default(0),
    limitations: jsonb('limitations').$type<string[]>().notNull().default([]),
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),
    checkedBy: text('checked_by').notNull(), // 'adapter:<id>' | user id
  },
  (t) => [uniqueIndex('source_checks_uq').on(t.runId, t.sourceId, t.ordinal)],
);

export const offers = pgTable(
  'offers',
  {
    id: id(),
    sourceId: text('source_id').notNull(),
    providerListingId: text('provider_listing_id'),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    sellerName: text('seller_name'),
    directPurchaseUrl: text('direct_purchase_url').notNull(),
    affiliateUrl: text('affiliate_url'),
    lifecycle: text('lifecycle').notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [index('offers_event_idx').on(t.eventId, t.sourceId)],
);

export const offerObservations = pgTable(
  'offer_observations',
  {
    id: id(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id),
    runId: uuid('run_id').references(() => researchRuns.id),
    checkId: uuid('check_id').references(() => sourceChecks.id),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    quantity: integer('quantity').notNull(),
    section: text('section'),
    rowLabel: text('row_label'),
    seatNumbers: jsonb('seat_numbers').$type<string[]>(),
    seatsTogether: boolean('seats_together'),
    admissionType: text('admission_type').notNull().default('reserved'),
    baseTotalCents: integer('base_total_cents'),
    mandatoryFeeTotalCents: integer('mandatory_fee_total_cents'),
    taxTotalCents: integer('tax_total_cents'),
    deliveryTotalCents: integer('delivery_total_cents'),
    payableTotalCents: integer('payable_total_cents'),
    priceCompleteness: text('price_completeness').notNull(), // verified_total | estimated_total | incomplete
    restrictions: jsonb('restrictions').$type<string[]>().notNull().default([]),
    deliveryMethod: text('delivery_method'),
    expectedDeliveryAt: ts('expected_delivery_at'),
    availability: text('availability').notNull().default('unknown'), // available | unavailable | unknown
    verificationMethod: text('verification_method').notNull(), // approved_api | approved_manual | fixture
    verifiedBy: text('verified_by'),
    sourceAsOf: ts('source_as_of'),
    fetchedAt: ts('fetched_at').notNull(),
    retentionUntil: ts('retention_until'),
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('offer_obs_event_qty_time_idx').on(t.eventId, t.quantity, t.fetchedAt),
    check('offer_obs_qty_pos', sql`${t.quantity} > 0`),
    check('offer_obs_money_nonneg', sql`coalesce(${t.payableTotalCents},0) >= 0 and coalesce(${t.baseTotalCents},0) >= 0`),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    revision: integer('revision').notNull(),
    draftVersion: integer('draft_version').notNull().default(1),
    draftHash: text('draft_hash').notNull(),
    chosenObservationIds: jsonb('chosen_observation_ids').$type<string[]>().notNull(),
    adviceRunId: uuid('advice_run_id'),
    computedSavingsCents: integer('computed_savings_cents'),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html').notNull(),
    subject: text('subject').notNull(),
    reviewStatus: text('review_status').notNull().default('pending'), // pending | approved | rejected | invalidated | sent
    reviewerUserId: text('reviewer_user_id'),
    reviewNote: text('review_note'),
    approvedAt: ts('approved_at'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [index('recommendations_request_idx').on(t.requestId, t.revision)],
);

export const watches = pgTable(
  'watches',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    revision: integer('revision').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    quantity: integer('quantity').notNull(),
    targetTotalCents: integer('target_total_cents').notNull(),
    acceptableSections: jsonb('acceptable_sections').$type<string[]>(),
    togetherRequired: boolean('together_required').notNull().default(true),
    consentMessageId: uuid('consent_message_id').references(() => messages.id),
    cadenceMinutes: integer('cadence_minutes').notNull(),
    nextCheckAt: ts('next_check_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    state: text('state').notNull().default('active'), // active | paused | cancelled | expired | fulfilled
    generation: integer('generation').notNull().default(1),
    lastAlertAt: ts('last_alert_at'),
    leaseUntil: ts('lease_until'),
    createdAt: createdAt(),
  },
  (t) => [
    index('watches_state_next_idx').on(t.state, t.nextCheckAt),
    check('watches_qty_pos', sql`${t.quantity} > 0`),
    check('watches_target_nonneg', sql`${t.targetTotalCents} >= 0`),
  ],
);

export const watchAlerts = pgTable(
  'watch_alerts',
  {
    id: id(),
    watchId: uuid('watch_id')
      .notNull()
      .references(() => watches.id),
    generation: integer('generation').notNull(),
    observationId: uuid('observation_id')
      .notNull()
      .references(() => offerObservations.id),
    dedupeKey: text('dedupe_key').notNull(),
    payableTotalCents: integer('payable_total_cents').notNull(),
    approvalState: text('approval_state').notNull().default('pending'),
    sendIntentId: uuid('send_intent_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('watch_alerts_dedupe_uq').on(t.dedupeKey), index('watch_alerts_watch_idx').on(t.watchId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Interests and marketing
// ---------------------------------------------------------------------------
export const interestTaxonomy = pgTable('interest_taxonomy', {
  key: text('key').primaryKey(), // e.g. artist:dua-lipa
  kind: text('kind').notNull(), // artist | team | category | requested-market | quantity | request-budget-total-usd
  canonicalEntityId: uuid('canonical_entity_id').references(() => entities.id),
  allowedForMarketing: boolean('allowed_for_marketing').notNull().default(false),
  description: text('description'),
  taxonomyVersion: text('taxonomy_version').notNull().default('1'),
  createdAt: createdAt(),
});

export const interestObservations = pgTable(
  'interest_observations',
  {
    id: id(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    tagKey: text('tag_key')
      .notNull()
      .references(() => interestTaxonomy.key),
    messageId: uuid('message_id').references(() => messages.id),
    requestId: uuid('request_id').references(() => requests.id),
    explicit: boolean('explicit').notNull().default(false),
    polarity: text('polarity').notNull(), // positive | negative | uncertain
    confidence: integer('confidence').notNull(), // 0-100
    forSelf: boolean('for_self'), // null = unknown; false = gift
    observedAt: ts('observed_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('interest_obs_contact_idx').on(t.contactId, t.tagKey, t.observedAt)],
);

export const contactInterests = pgTable(
  'contact_interests',
  {
    id: id(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    tagKey: text('tag_key')
      .notNull()
      .references(() => interestTaxonomy.key),
    aggregateConfidence: integer('aggregate_confidence').notNull(),
    status: text('status').notNull(), // provisional | confirmed | suppressed | expired
    confirmed: boolean('confirmed').notNull().default(false),
    userOverride: text('user_override'), // null | 'positive' | 'negative'
    lastSeenAt: ts('last_seen_at').notNull(),
    rebuiltAt: ts('rebuilt_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('contact_interests_uq').on(t.contactId, t.tagKey), index('contact_interests_tag_idx').on(t.tagKey, t.status, t.lastSeenAt)],
);

export const marketingPermissions = pgTable(
  'marketing_permissions',
  {
    id: id(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    topic: text('topic').notNull().default('ticket_offers'),
    status: text('status').notNull(), // granted | revoked
    noticeVersion: text('notice_version').notNull(),
    method: text('method').notNull(), // preference_form | natural_language | one_click | staff
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    grantedAt: ts('granted_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('marketing_permissions_contact_idx').on(t.contactId, t.topic, t.createdAt)],
);

export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    emailLookup: text('email_lookup').notNull(),
    scope: text('scope').notNull(), // global | marketing | watch
    reason: text('reason').notNull(), // hard_bounce | complaint | unsubscribe | stop_all | staff | deletion
    provider: text('provider'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppressions_uq').on(t.emailLookup, t.scope)],
);

export const segments = pgTable('segments', {
  id: id(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  filter: jsonb('filter').$type<Record<string, unknown>>().notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
});

export const campaigns = pgTable('campaigns', {
  id: id(),
  name: text('name').notNull(),
  segmentId: uuid('segment_id').references(() => segments.id),
  contentHash: text('content_hash'),
  subject: text('subject'),
  bodyText: text('body_text'),
  bodyHtml: text('body_html'),
  segmentSnapshot: jsonb('segment_snapshot').$type<Record<string, unknown>>(),
  eligibleCount: integer('eligible_count'),
  status: text('status').notNull().default('draft'), // draft | approved | sending | paused | completed | cancelled
  approvedBy: text('approved_by'),
  approvedAt: ts('approved_at'),
  scheduledAt: ts('scheduled_at'),
  createdAt: createdAt(),
});

export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: id(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    state: text('state').notNull().default('snapshot'), // snapshot | eligible | suppressed | sent | failed
    sendIntentId: uuid('send_intent_id'),
    evaluatedAt: ts('evaluated_at'),
  },
  (t) => [uniqueIndex('campaign_recipients_uq').on(t.campaignId, t.contactId)],
);

// ---------------------------------------------------------------------------
// Durable messaging: inbox, outbox, send intents
// ---------------------------------------------------------------------------
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signatureVerified: boolean('signature_verified').notNull(),
    receivedAt: createdAt(),
    processingState: text('processing_state').notNull().default('pending'), // pending | processed | quarantined | duplicate
    processedAt: ts('processed_at'),
    quarantineReason: text('quarantine_reason'),
  },
  (t) => [uniqueIndex('inbound_events_provider_uq').on(t.provider, t.providerEventId)],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    eventType: text('event_type').notNull(),
    eventKey: text('event_key').notNull(),
    entityId: text('entity_id').notNull(),
    revision: integer('revision').notNull().default(1),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    state: text('state').notNull().default('pending'), // pending | leased | dispatched | dead
    attempts: integer('attempts').notNull().default(0),
    leaseToken: text('lease_token'),
    leaseUntil: ts('lease_until'),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
    dispatchedAt: ts('dispatched_at'),
  },
  (t) => [uniqueIndex('outbox_event_key_uq').on(t.eventKey), index('outbox_state_next_idx').on(t.state, t.nextAttemptAt)],
);

export const sendIntents = pgTable(
  'send_intents',
  {
    id: id(),
    dedupeKey: text('dedupe_key').notNull(),
    messageClass: text('message_class').notNull(), // acknowledgment | clarification | recommendation | no_result | watch_confirmation | watch_alert | marketing | verification
    contactId: uuid('contact_id').references(() => contacts.id),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    requestId: uuid('request_id'),
    requestRevision: integer('request_revision'),
    approvalId: uuid('approval_id'),
    approvedHash: text('approved_hash'),
    recipient: text('recipient').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html').notNull(),
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
    contentHash: text('content_hash').notNull(),
    state: text('state').notNull().default('queued'), // queued | claimed | provider_accepted | delivered | delayed | bounced | complained | failed | suppressed | uncertain | blocked
    claimToken: text('claim_token'),
    claimedAt: ts('claimed_at'),
    providerMessageId: text('provider_message_id'),
    providerRfcMessageId: text('provider_rfc_message_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    submittedAt: ts('submitted_at'),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('send_intents_dedupe_uq').on(t.dedupeKey),
    index('send_intents_provider_idx').on(t.providerMessageId),
    index('send_intents_state_idx').on(t.state, t.createdAt),
  ],
);

export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: id(),
    requestId: uuid('request_id'),
    revision: integer('revision'),
    runId: uuid('run_id'),
    jobName: text('job_name'),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    estimatedUsdMicros: bigint('estimated_usd_micros', { mode: 'number' }).notNull(),
    actualUsdMicros: bigint('actual_usd_micros', { mode: 'number' }),
    priceTableVersion: text('price_table_version').notNull(),
    kind: text('kind').notNull().default('reservation'), // reservation | settled | released
    createdAt: createdAt(),
  },
  (t) => [index('usage_request_idx').on(t.requestId, t.revision), index('usage_day_idx').on(t.createdAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    revision: integer('revision'),
    diff: jsonb('diff').$type<Record<string, unknown>>(),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_entity_idx').on(t.entityKind, t.entityId, t.createdAt)],
);

export const productEvents = pgTable(
  'product_events',
  {
    id: id(),
    requestPseudonym: text('request_pseudonym'),
    contactPseudonym: text('contact_pseudonym'),
    eventName: text('event_name').notNull(),
    value: integer('value'),
    createdAt: createdAt(),
  },
  (t) => [index('product_events_name_idx').on(t.eventName, t.createdAt)],
);

export const killSwitches = pgTable('kill_switches', {
  key: text('key').primaryKey(), // all_outbound | recommendations | marketing | watches | adapter:<id> | escalation_model
  enabled: boolean('enabled').notNull().default(true), // enabled=true means the capability is ALLOWED
  reason: text('reason'),
  changedBy: text('changed_by'),
  changedAt: ts('changed_at').notNull().defaultNow(),
});

export const deletionLedger = pgTable('deletion_ledger', {
  id: id(),
  emailLookupHash: text('email_lookup_hash').notNull(),
  contactId: uuid('contact_id'),
  requestedAt: ts('requested_at').notNull(),
  verifiedAt: ts('verified_at'),
  completedAt: ts('completed_at'),
  actor: text('actor').notNull(),
  scope: jsonb('scope').$type<string[]>().notNull(),
});

// ---------------------------------------------------------------------------
// Advice engine
// ---------------------------------------------------------------------------
export const marketDatasets = pgTable('market_datasets', {
  id: id(),
  provider: text('provider').notNull(),
  licenseReference: text('license_reference'),
  approvedUses: jsonb('approved_uses').$type<string[]>().notNull().default([]), // benchmark | customer_display | derived_aggregates | forecasting
  coverageNote: text('coverage_note'),
  rawRetentionUntil: ts('raw_retention_until'),
  derivedRetentionUntil: ts('derived_retention_until'),
  status: text('status').notNull().default('quarantined'), // quarantined | approved | revoked | expired
  isFixture: boolean('is_fixture').notNull().default(false),
  schemaVersion: text('schema_version').notNull().default('1'),
  approvedBy: text('approved_by'),
  createdAt: createdAt(),
});

export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    id: id(),
    datasetId: uuid('dataset_id').references(() => marketDatasets.id),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    basketKey: text('basket_key').notNull(), // deterministic hash of basket definition
    basketVersion: integer('basket_version').notNull().default(1),
    quantity: integer('quantity').notNull(),
    seatZone: text('seat_zone'),
    observedAt: ts('observed_at').notNull(),
    providerAsOf: ts('provider_as_of'),
    leadTimeMinutes: integer('lead_time_minutes').notNull(),
    cheapestEligibleTotalCents: integer('cheapest_eligible_total_cents'),
    medianEligibleTotalCents: integer('median_eligible_total_cents'),
    eligibleOptionCount: integer('eligible_option_count'),
    sourceIds: jsonb('source_ids').$type<string[]>().notNull(),
    feeBasis: text('fee_basis').notNull(), // verified_total | estimated_total | incomplete
    coverageComplete: boolean('coverage_complete').notNull(),
    qualityFlags: jsonb('quality_flags').$type<string[]>().notNull().default([]),
    observationIds: jsonb('observation_ids').$type<string[]>().notNull().default([]),
    methodVersion: text('method_version').notNull(),
    isFixture: boolean('is_fixture').notNull().default(false),
  },
  (t) => [index('market_snapshots_event_basket_time_idx').on(t.eventId, t.basketKey, t.observedAt)],
);

export const venueSeatZones = pgTable(
  'venue_seat_zones',
  {
    id: id(),
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id),
    layoutVersion: text('layout_version').notNull(),
    section: text('section').notNull(),
    zone: text('zone').notNull(),
    evidence: text('evidence'),
    reviewedBy: text('reviewed_by'),
    status: text('status').notNull().default('active'), // active | corrected | retired
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('venue_seat_zones_uq').on(t.venueId, t.layoutVersion, t.section)],
);

export const benchmarkRuns = pgTable('benchmark_runs', {
  id: id(),
  targetEventId: uuid('target_event_id')
    .notNull()
    .references(() => events.id),
  targetContext: jsonb('target_context').$type<Record<string, unknown>>().notNull(),
  cohortFilters: jsonb('cohort_filters').$type<Record<string, unknown>>().notNull(),
  fallbacksApplied: jsonb('fallbacks_applied').$type<string[]>().notNull().default([]),
  representativeSnapshotIds: jsonb('representative_snapshot_ids').$type<string[]>().notNull(),
  independentEventCount: integer('independent_event_count').notNull(),
  medianCents: integer('median_cents'),
  p25Cents: integer('p25_cents'),
  p75Cents: integer('p75_cents'),
  exclusions: jsonb('exclusions').$type<Array<{ eventId: string; reason: string }>>().notNull().default([]),
  adequacy: text('adequacy').notNull(), // sufficient | limited | insufficient
  adequacyReasons: jsonb('adequacy_reasons').$type<string[]>().notNull().default([]),
  licenseExpiresAt: ts('license_expires_at'),
  methodVersion: text('method_version').notNull(),
  invalidatedAt: ts('invalidated_at'),
  createdAt: createdAt(),
});

export const trendRuns = pgTable('trend_runs', {
  id: id(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id),
  basketKey: text('basket_key').notNull(),
  sourceIntersection: jsonb('source_intersection').$type<string[]>().notNull(),
  windows: jsonb('windows').$type<Record<string, unknown>>().notNull(),
  baselineSnapshotId: uuid('baseline_snapshot_id'),
  currentSnapshotId: uuid('current_snapshot_id'),
  direction: text('direction').notNull(), // up | down | flat | mixed | insufficient
  adequacy: text('adequacy').notNull(),
  qualityFlags: jsonb('quality_flags').$type<string[]>().notNull().default([]),
  methodVersion: text('method_version').notNull(),
  createdAt: createdAt(),
});

export const adviceRuns = pgTable(
  'advice_runs',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    revision: integer('revision').notNull(),
    benchmarkRunId: uuid('benchmark_run_id').references(() => benchmarkRuns.id),
    trendRunId: uuid('trend_run_id').references(() => trendRuns.id),
    verifiedOfferObservationIds: jsonb('verified_offer_observation_ids').$type<string[]>().notNull(),
    customerPriorities: jsonb('customer_priorities').$type<Record<string, unknown>>().notNull(),
    policyVersion: text('policy_version').notNull(),
    decision: text('decision').notNull(),
    reasonCodes: jsonb('reason_codes').$type<string[]>().notNull(),
    abstentions: jsonb('abstentions').$type<string[]>().notNull().default([]),
    nextCheckpointAt: ts('next_checkpoint_at'),
    stopConditions: jsonb('stop_conditions').$type<string[]>().notNull().default([]),
    packet: jsonb('packet').$type<Record<string, unknown>>().notNull(),
    packetHash: text('packet_hash').notNull(),
    evidenceExpiresAt: ts('evidence_expires_at'),
    invalidatedAt: ts('invalidated_at'),
    createdAt: createdAt(),
  },
  (t) => [index('advice_runs_request_idx').on(t.requestId, t.revision)],
);

export const adviceOutcomes = pgTable('advice_outcomes', {
  id: id(),
  adviceRunId: uuid('advice_run_id')
    .notNull()
    .references(() => adviceRuns.id),
  outcomeKind: text('outcome_kind').notNull(), // purchase_confirmed | missed_option | followup_quote | no_purchase
  verifiedAmountCents: integer('verified_amount_cents'),
  provenance: text('provenance').notNull(), // customer_reply | staff | followup_observation
  note: text('note'),
  createdAt: createdAt(),
});

export const schema = {
  user, session, account, verification, twoFactor,
  contacts, contactPreferences, conversations, messages, mediaObjects, attachments,
  requests, requestVersions, requestTransitions,
  venues, entities, events, eventSourceMappings,
  sourceRegistry, adapterConfigs, researchRuns, sourceChecks, offers, offerObservations,
  recommendations, watches, watchAlerts,
  interestTaxonomy, interestObservations, contactInterests, marketingPermissions, suppressions,
  segments, campaigns, campaignRecipients,
  inboundEvents, outboxEvents, sendIntents, usageLedger, auditLog, productEvents, killSwitches, deletionLedger,
  marketDatasets, marketSnapshots, venueSeatZones, benchmarkRuns, trendRuns, adviceRuns, adviceOutcomes,
};
