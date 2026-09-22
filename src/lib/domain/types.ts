import { z } from 'zod';

export const SourceStatus = z.enum([
  'success',
  'no_matching_inventory',
  'not_supported',
  'not_integrated',
  'not_configured',
  'access_not_approved',
  'blocked',
  'rate_limited',
  'timeout',
  'provider_error',
  'ambiguous_event',
  'budget_exhausted',
  'manual_pending',
]);
export type SourceStatus = z.infer<typeof SourceStatus>;

export const PriceCompleteness = z.enum(['verified_total', 'estimated_total', 'incomplete']);
export type PriceCompleteness = z.infer<typeof PriceCompleteness>;

export const CollectionMode = z.enum(['approved_api', 'approved_manual', 'fixture']);
export type CollectionMode = z.infer<typeof CollectionMode>;

export const AdmissionType = z.enum(['reserved', 'general_admission', 'standing', 'other']);

const nonNegCents = z.number().int().min(0);

export const OfferSchema = z
  .object({
    id: z.string(),
    sourceId: z.string(),
    providerListingId: z.string().nullable(),
    eventId: z.string(),
    observedAt: z.string().datetime(),
    providerUpdatedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime().nullable(),
    quantity: z.number().int().positive(),
    currency: z.literal('USD'),
    baseTotalCents: nonNegCents.nullable(),
    mandatoryFeeTotalCents: nonNegCents.nullable(),
    taxTotalCents: nonNegCents.nullable(),
    deliveryTotalCents: nonNegCents.nullable(),
    payableTotalCents: nonNegCents.nullable(),
    priceCompleteness: PriceCompleteness,
    section: z.string().nullable(),
    row: z.string().nullable(),
    seatNumbers: z.array(z.string()).nullable(),
    seatsTogether: z.boolean().nullable(),
    admissionType: AdmissionType,
    /** Free-form restriction codes, e.g. 'parking_only', 'obstructed_view', 'different_session', 'vip_package', 'resale_deposit'. */
    restrictions: z.array(z.string()),
    deliveryMethod: z.string().nullable(),
    expectedDeliveryAt: z.string().datetime().nullable(),
    directPurchaseUrl: z.string().url(),
    affiliateUrl: z.string().url().nullable().optional(),
    /** Never an input to eligibility or ranking. Carried only so tests can prove that. */
    affiliateCommissionBps: z.number().int().min(0).nullable().optional(),
    evidenceId: z.string(),
    collectionMode: CollectionMode,
    availability: z.enum(['available', 'unavailable', 'unknown']).default('unknown'),
    /** Seat-quality class used to group materially comparable offers. */
    seatClass: z.string().nullable().optional(),
  })
  .strict();
export type Offer = z.infer<typeof OfferSchema>;

export const SourceResultSchema = z.object({
  sourceId: z.string(),
  status: SourceStatus,
  checkedAt: z.string().datetime(),
  offers: z.array(OfferSchema),
  reasonCode: z.string().nullable(),
  retryAfterSeconds: z.number().int().min(0).nullable(),
  coverageNotes: z.array(z.string()),
  /** Provider-side data timestamp when the result comes from a cache/feed. */
  sourceAsOf: z.string().datetime().nullable().optional(),
});
export type SourceResult = z.infer<typeof SourceResultSchema>;

export const SearchInputSchema = z.object({
  requestId: z.string(),
  revision: z.number().int().positive(),
  eventId: z.string(),
  providerEventId: z.string().nullable(),
  quantity: z.number().int().positive(),
  hardConstraints: z.record(z.string(), z.unknown()),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const RequestExtractionSchema = z
  .object({
    intent: z.enum(['new_search', 'clarification', 'watch_request', 'cancel_watch', 'marketing_opt_out', 'delete_data', 'other']),
    eventName: z.string().nullable(),
    performerOrTeam: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    dateExpression: z.string().nullable(),
    resolvedLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    quantity: z.number().int().positive().nullable(),
    budgetCents: z.number().int().min(0).nullable(),
    budgetBasis: z.enum(['per_ticket', 'whole_party']).nullable(),
    seatingPreference: z.string().nullable(),
    togetherRequired: z.boolean().nullable(),
    accessibilityNeeds: z.string().nullable(),
    alternativesAllowed: z.boolean().nullable(),
    submittedUrls: z.array(z.string()),
    evidence: z.array(z.object({ field: z.string(), messageId: z.string(), quote: z.string() })),
    ambiguities: z.array(z.string()),
    /** Advice-engine preference fields; null when not stated. */
    mustAttend: z.boolean().nullable().default(null),
    waitRiskTolerance: z.enum(['low', 'medium', 'high']).nullable().default(null),
    decisionDeadline: z.string().datetime().nullable().default(null),
    splitGroupAllowed: z.boolean().nullable().default(null),
    /** Explicit customer statement about who the tickets are for; null when unknown. */
    forSelf: z.boolean().nullable().default(null),
    /** Entities the customer explicitly does NOT want (negation). */
    negatedEntities: z.array(z.string()).default([]),
    countryStatement: z.string().nullable().default(null),
  })
  .strict();
export type RequestExtraction = z.infer<typeof RequestExtractionSchema>;

/** Hard constraints derived from a brief and applied deterministically. */
export type HardConstraints = {
  quantity: number;
  togetherRequired: boolean | null;
  budgetTotalCents: number | null;
  excludeObstructedView: boolean;
  requireAccessible: boolean;
  acceptableSections: string[] | null;
  eventStartAt: string; // ISO instant
};
