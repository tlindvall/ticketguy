import { z } from 'zod';
import { MARKETING_SUBDOMAIN, SERVICE_DOMAIN } from './brand';
import { parsePriceOverrides, type Price } from '@/lib/ai/prices';

/**
 * Environment configuration. All booleans are parsed explicitly: only the literal strings
 * "true"/"1" enable a flag. "false", "", undefined and anything else disable it.
 * Production/staging refuse to start without a DATABASE_URL (no embedded fallback).
 */

const explicitBoolean = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
    throw new Error(`Boolean environment value must be "true"/"false"/"1"/"0", got "${v}"`);
  });

const usd = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: 'custom', message: `Invalid USD amount "${v}"` });
      return z.NEVER;
    }
    return n;
  });

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

/** A csv with a default when the variable is unset; an explicitly empty value still means "none". */
const csvDefault = (dflt: string) =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v === undefined ? dflt : v)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );

/**
 * `key=value` pairs, comma separated (e.g. `watch_alert=alerts@x.com,marketing=deals@x.com`).
 * Keys and values are lowercased; a malformed entry is a configuration error, never a silent skip.
 */
const csvPairs = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const out: Record<string, string> = {};
    for (const part of (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const eq = part.indexOf('=');
      if (eq <= 0 || eq === part.length - 1) {
        ctx.addIssue({ code: 'custom', message: `Expected "key=value", got "${part}"` });
        return z.NEVER;
      }
      out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().toLowerCase();
    }
    return out;
  });

export const appEnvironment = z.enum(['development', 'test', 'staging', 'production']);
export type AppEnvironment = z.infer<typeof appEnvironment>;

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: appEnvironment.optional(),
  /** Public base URL. Left unset on Render, RENDER_EXTERNAL_URL supplies it (see resolution in parseEnv). */
  APP_URL: z.string().url().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  APP_MODE: z.enum(['fixture', 'live']).default('fixture'),

  EMAIL_SEND_ENABLED: explicitBoolean,
  MARKETING_SEND_ENABLED: explicitBoolean,
  WATCH_SEND_ENABLED: explicitBoolean,
  HUMAN_REVIEW_REQUIRED: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v.trim().toLowerCase() !== 'false' && v.trim() !== '0')),
  EMAIL_TEST_RECIPIENT_ALLOWLIST: csv,

  /** 'rules' runs the deterministic extractor/drafter deliberately; it is never a silent fallback. */
  EXTRACTION_PROVIDER: z.enum(['anthropic', 'openai', 'rules']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_MODEL: z.string().default('claude-opus-5'),
  /** Escalation is the same model at a higher effort level, not a second model: one cache namespace, one price row. */
  ANTHROPIC_BASE_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  ANTHROPIC_ESCALATION_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  ANTHROPIC_ESCALATION_ENABLED: explicitBoolean,
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_MODEL: z.string().default('gpt-5.5'),
  OPENAI_BASE_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  OPENAI_ESCALATION_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  /**
   * Per-model rates as `model=inputUsdPerMTok:outputUsdPerMTok`, comma separated. Any model without a row
   * here or in the built-in table bills at the conservative default, which over-reserves rather than
   * under-reserves against the budget caps. Published rates change; this is how an operator corrects them
   * without a deploy.
   */
  MODEL_PRICES_USD_PER_MTOKEN: z.string().optional(),
  AI_REQUEST_SOFT_BUDGET_USD: usd,
  AI_REQUEST_HARD_BUDGET_USD: usd,
  AI_GLOBAL_DAILY_BUDGET_USD: usd,
  AI_MAX_CALLS_PER_REVISION: z.coerce.number().int().positive().default(8),
  AI_MAX_WEB_SEARCHES_PER_REQUEST: z.coerce.number().int().min(0).default(3),

  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  /** The public address. Shown on the site and used as Reply-To; also the first entry of inboundAddresses. */
  CONCIERGE_INBOUND_ADDRESS: z.string().email().default(`my@${SERVICE_DOMAIN}`),
  /** Further addresses the intake accepts, comma separated. Mail to anything else is ignored. */
  CONCIERGE_INBOUND_ADDRESSES: csv,
  CONCIERGE_FROM_ADDRESS: z.string().email().default(`my@${SERVICE_DOMAIN}`),
  MARKETING_FROM_ADDRESS: z.string().email().default(`deals@${MARKETING_SUBDOMAIN}`),
  /** Per-message-class From overrides, e.g. `watch_alert=alerts@ticketguy.now`. Empty = one From for everything. */
  MESSAGE_CLASS_FROM_ADDRESSES: csvPairs,
  /** From addresses knowingly not receivable. Listing one is an explicit decision to drop replies to it. */
  UNMONITORED_FROM_ADDRESSES: csv,
  BUSINESS_POSTAL_ADDRESS: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  MIGRATION_DATABASE_URL: z.string().optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  PGLITE_DATA_DIR: z.string().default('.local/pglite'),
  MEDIA_PROVIDER: z.enum(['db', 's3']).default('db'),
  MEDIA_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),

  /**
   * Development only: serve the synthetic offer set even at APP_MODE=live, so the model extractor and the
   * advice engine can be exercised together locally. Refused outright in staging/production — the send gate
   * would block the content anyway (content_contains_fixture_data), but this never reaches a real deploy.
   */
  DEV_FIXTURE_OFFERS: explicitBoolean,
  BETTER_AUTH_URL: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  STAFF_EMAIL_ALLOWLIST: csv,
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  PREFERENCE_TOKEN_SIGNING_KEY: z.string().optional(),
  INTERNAL_CRON_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().optional(),

  TICKETMASTER_DISCOVERY_API_KEY: z.string().optional(),
  TICKETMASTER_DISCOVERY_ENABLED: explicitBoolean,
  /**
   * Performers/teams the catalog is refreshed for every day before anyone writes in, so a pilot request
   * resolves from the local catalog and the provider is only asked about names we have not seen. Comma
   * separated; the default is the NYC pilot. Empty disables the pre-warm without disabling discovery.
   */
  CATALOG_SEED_KEYWORDS: csvDefault('new york rangers,new york knicks,new york islanders,new jersey devils,brooklyn nets,new york yankees,new york mets,new york liberty'),
  LIVE_INVENTORY_ENABLED: explicitBoolean,

  PILOT_SUPPORTED_CATEGORIES: z.string().default('concert,nhl,nba,mlb'),
  PILOT_SUPPORTED_MARKETS: z.string().default('new-york'),
  STAFFED_HOURS_TIMEZONE: z.string().default('America/New_York'),
  STAFFED_HOURS_START: z.coerce.number().int().min(0).max(23).default(9),
  STAFFED_HOURS_END: z.coerce.number().int().min(1).max(24).default(21),
});

export type Env = Omit<z.infer<typeof rawSchema>, 'APP_URL'> & {
  /** Resolved from APP_URL, else RENDER_EXTERNAL_URL, else the local default. */
  APP_URL: string;
  appEnv: AppEnvironment;
  isProductionLike: boolean;
  /** The model the selected provider will actually call, or null under EXTRACTION_PROVIDER=rules. */
  modelName: string | null;
  /** Operator-supplied rates, layered over the built-in table. */
  modelPrices: Record<string, Price>;
  /** Every address the intake accepts, lowercased and deduped; CONCIERGE_INBOUND_ADDRESS is always first. */
  inboundAddresses: string[];
  /** Resolved From address per message class. Every class is present; unconfigured ones use CONCIERGE_FROM_ADDRESS. */
  messageClassFromAddresses: Record<MessageClass, string>;
  aiRequestSoftBudgetUsd: number;
  aiRequestHardBudgetUsd: number;
  aiGlobalDailyBudgetUsd: number;
  pilotSupportedCategories: string[];
  pilotSupportedMarkets: string[];
};

/**
 * Mirrors MessageClass in @/lib/email/send-gate. Declared here rather than imported: send-gate imports Env,
 * and the cycle would leave one of the two undefined at module-evaluation time. A test pins the two in step.
 */
export const MESSAGE_CLASSES = ['acknowledgment', 'clarification', 'recommendation', 'no_result', 'watch_confirmation', 'watch_alert', 'marketing', 'verification'] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

export class ConfigurationError extends Error {
  override name = 'ConfigurationError';
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const appEnv: AppEnvironment = e.APP_ENV ?? (e.NODE_ENV === 'production' ? 'production' : e.NODE_ENV);
  const isProductionLike = appEnv === 'production' || appEnv === 'staging';
  // Render supplies RENDER_EXTERNAL_URL; without this the default localhost URL would silently break
  // Better Auth trusted origins, admin CSRF origin checks and every signed preference/unsubscribe link.
  const appUrl = e.APP_URL ?? e.RENDER_EXTERNAL_URL ?? 'http://localhost:3000';

  if (isProductionLike) {
    if (!e.DATABASE_URL || !/^postgres(ql)?:\/\//.test(e.DATABASE_URL)) {
      throw new ConfigurationError(`DATABASE_URL is required and must be a postgres:// URL in ${appEnv}; PGlite fallback is never allowed here`);
    }
    if (e.APP_MODE === 'fixture') {
      throw new ConfigurationError(`APP_MODE=fixture is not allowed in ${appEnv}`);
    }
    if (!e.BETTER_AUTH_SECRET || e.BETTER_AUTH_SECRET.length < 32) {
      throw new ConfigurationError('BETTER_AUTH_SECRET (>=32 chars) is required in production-like environments');
    }
    if (!e.PREFERENCE_TOKEN_SIGNING_KEY || e.PREFERENCE_TOKEN_SIGNING_KEY.length < 32) {
      throw new ConfigurationError('PREFERENCE_TOKEN_SIGNING_KEY (>=32 chars) is required in production-like environments');
    }
    if (!e.INTERNAL_CRON_SECRET) throw new ConfigurationError('INTERNAL_CRON_SECRET is required in production-like environments');
    if (!appUrl.startsWith('https://')) {
      throw new ConfigurationError(`APP_URL must be an https:// URL in ${appEnv} (got "${appUrl}"); set APP_URL or deploy where RENDER_EXTERNAL_URL is provided`);
    }
    if (e.EXTRACTION_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY) {
      throw new ConfigurationError(`EXTRACTION_PROVIDER=anthropic requires ANTHROPIC_API_KEY in ${appEnv}; set EXTRACTION_PROVIDER=rules to run the deterministic extractor deliberately`);
    }
    if (e.EXTRACTION_PROVIDER === 'openai' && !e.OPENAI_API_KEY) {
      throw new ConfigurationError(`EXTRACTION_PROVIDER=openai requires OPENAI_API_KEY in ${appEnv}; set EXTRACTION_PROVIDER=rules to run the deterministic extractor deliberately`);
    }
    if (e.DEV_FIXTURE_OFFERS) {
      throw new ConfigurationError(`DEV_FIXTURE_OFFERS is a local development switch and is not allowed in ${appEnv}`);
    }
  }
  if (e.DATABASE_URL && !/^postgres(ql)?:\/\//.test(e.DATABASE_URL)) {
    throw new ConfigurationError('DATABASE_URL must be a postgres:// URL when set');
  }
  if (e.MEDIA_PROVIDER === 's3') {
    // An S3/R2 adapter is a later implementation, not an existing capability.
    throw new ConfigurationError('MEDIA_PROVIDER=s3 selected but no object-store adapter is installed; use MEDIA_PROVIDER=db');
  }
  if (e.EMAIL_SEND_ENABLED && e.APP_MODE === 'fixture') {
    throw new ConfigurationError('EMAIL_SEND_ENABLED=true is not allowed while APP_MODE=fixture');
  }
  if (e.EMAIL_SEND_ENABLED && !e.RESEND_API_KEY) {
    throw new ConfigurationError('EMAIL_SEND_ENABLED=true requires RESEND_API_KEY');
  }
  if (e.TICKETMASTER_DISCOVERY_ENABLED && !e.TICKETMASTER_DISCOVERY_API_KEY) {
    throw new ConfigurationError('TICKETMASTER_DISCOVERY_ENABLED=true requires TICKETMASTER_DISCOVERY_API_KEY');
  }
  const inboundAddresses = [...new Set([e.CONCIERGE_INBOUND_ADDRESS.toLowerCase(), ...e.CONCIERGE_INBOUND_ADDRESSES])];

  const unknownClass = Object.keys(e.MESSAGE_CLASS_FROM_ADDRESSES).find((k) => !(MESSAGE_CLASSES as readonly string[]).includes(k));
  if (unknownClass) {
    throw new ConfigurationError(`MESSAGE_CLASS_FROM_ADDRESSES has unknown message class "${unknownClass}"; valid: ${MESSAGE_CLASSES.join(', ')}`);
  }
  const messageClassFromAddresses = Object.fromEntries(
    MESSAGE_CLASSES.map((c) => [c, e.MESSAGE_CLASS_FROM_ADDRESSES[c] ?? e.CONCIERGE_FROM_ADDRESS.toLowerCase()]),
  ) as Record<MessageClass, string>;

  // Anything we send from is somewhere a customer will reply, whatever Reply-To says. An address that is
  // neither received nor explicitly declared unmonitored would drop those replies silently, so it fails here.
  const unmonitored = new Set(e.UNMONITORED_FROM_ADDRESSES);
  for (const [cls, from] of Object.entries(e.MESSAGE_CLASS_FROM_ADDRESSES)) {
    if (!inboundAddresses.includes(from) && !unmonitored.has(from)) {
      throw new ConfigurationError(
        `MESSAGE_CLASS_FROM_ADDRESSES sends "${cls}" from ${from}, which the intake does not accept. ` +
          `Add it to CONCIERGE_INBOUND_ADDRESSES, or to UNMONITORED_FROM_ADDRESSES to accept that replies to it are dropped.`,
      );
    }
  }

  // Cost estimates must name the model that is actually called; pricing the Anthropic model while running
  // OpenAI (or the reverse) would bill every call at the wrong rate.
  const modelName = e.EXTRACTION_PROVIDER === 'anthropic' ? e.ANTHROPIC_BASE_MODEL : e.EXTRACTION_PROVIDER === 'openai' ? e.OPENAI_BASE_MODEL : null;
  let modelPrices: Record<string, Price>;
  try {
    modelPrices = parsePriceOverrides(e.MODEL_PRICES_USD_PER_MTOKEN);
  } catch (err) {
    throw new ConfigurationError(err instanceof Error ? err.message : String(err));
  }

  const soft = e.AI_REQUEST_SOFT_BUDGET_USD ?? 0.5;
  const hard = e.AI_REQUEST_HARD_BUDGET_USD ?? 1.0;
  if (hard < soft) throw new ConfigurationError('AI_REQUEST_HARD_BUDGET_USD must be >= AI_REQUEST_SOFT_BUDGET_USD');

  return {
    ...e,
    APP_URL: appUrl,
    appEnv,
    isProductionLike,
    modelName,
    modelPrices,
    inboundAddresses,
    messageClassFromAddresses,
    aiRequestSoftBudgetUsd: soft,
    aiRequestHardBudgetUsd: hard,
    aiGlobalDailyBudgetUsd: e.AI_GLOBAL_DAILY_BUDGET_USD ?? 10,
    pilotSupportedCategories: e.PILOT_SUPPORTED_CATEGORIES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    pilotSupportedMarkets: e.PILOT_SUPPORTED_MARKETS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

let cached: Env | undefined;
export function env(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** Test helper: reset the cached env (tests only). */
export function resetEnvForTests(): void {
  cached = undefined;
}
