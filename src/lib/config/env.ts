import { z } from 'zod';

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

export const appEnvironment = z.enum(['development', 'test', 'staging', 'production']);
export type AppEnvironment = z.infer<typeof appEnvironment>;

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: appEnvironment.optional(),
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_MODE: z.enum(['fixture', 'live']).default('fixture'),

  EMAIL_SEND_ENABLED: explicitBoolean,
  MARKETING_SEND_ENABLED: explicitBoolean,
  WATCH_SEND_ENABLED: explicitBoolean,
  HUMAN_REVIEW_REQUIRED: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v.trim().toLowerCase() !== 'false' && v.trim() !== '0')),
  EMAIL_TEST_RECIPIENT_ALLOWLIST: csv,

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_MODEL: z.string().default('gpt-5.4-mini-2026-03-17'),
  OPENAI_ESCALATION_MODEL: z.string().default('gpt-5.4'),
  OPENAI_ESCALATION_ENABLED: explicitBoolean,
  AI_REQUEST_SOFT_BUDGET_USD: usd,
  AI_REQUEST_HARD_BUDGET_USD: usd,
  AI_GLOBAL_DAILY_BUDGET_USD: usd,
  AI_MAX_CALLS_PER_REVISION: z.coerce.number().int().positive().default(8),
  AI_MAX_WEB_SEARCHES_PER_REQUEST: z.coerce.number().int().min(0).default(3),

  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  CONCIERGE_INBOUND_ADDRESS: z.string().email().default('my@ticketguy.live'),
  CONCIERGE_FROM_ADDRESS: z.string().email().default('my@ticketguy.live'),
  MARKETING_FROM_ADDRESS: z.string().email().default('deals@news.ticketguy.live'),
  BUSINESS_POSTAL_ADDRESS: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  MIGRATION_DATABASE_URL: z.string().optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  PGLITE_DATA_DIR: z.string().default('.local/pglite'),
  MEDIA_PROVIDER: z.enum(['db', 's3']).default('db'),
  MEDIA_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),

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
  LIVE_INVENTORY_ENABLED: explicitBoolean,

  PILOT_SUPPORTED_CATEGORIES: z.string().default('concert,nhl,nba,mlb'),
  PILOT_SUPPORTED_MARKETS: z.string().default('new-york'),
  STAFFED_HOURS_TIMEZONE: z.string().default('America/New_York'),
  STAFFED_HOURS_START: z.coerce.number().int().min(0).max(23).default(9),
  STAFFED_HOURS_END: z.coerce.number().int().min(1).max(24).default(21),
});

export type Env = z.infer<typeof rawSchema> & {
  appEnv: AppEnvironment;
  isProductionLike: boolean;
  aiRequestSoftBudgetUsd: number;
  aiRequestHardBudgetUsd: number;
  aiGlobalDailyBudgetUsd: number;
  pilotSupportedCategories: string[];
  pilotSupportedMarkets: string[];
};

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
  const soft = e.AI_REQUEST_SOFT_BUDGET_USD ?? 0.5;
  const hard = e.AI_REQUEST_HARD_BUDGET_USD ?? 1.0;
  if (hard < soft) throw new ConfigurationError('AI_REQUEST_HARD_BUDGET_USD must be >= AI_REQUEST_SOFT_BUDGET_USD');

  return {
    ...e,
    appEnv,
    isProductionLike,
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
