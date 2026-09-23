import { describe, expect, it } from 'vitest';
import { ConfigurationError, parseEnv } from '@/lib/config/env';

const prodLike = (appEnv: 'production' | 'staging') => ({
  NODE_ENV: 'production', APP_ENV: appEnv, APP_MODE: 'live',
  DATABASE_URL: 'postgres://u@h/db', APP_URL: 'https://app.example',
  BETTER_AUTH_SECRET: 'x'.repeat(32), PREFERENCE_TOKEN_SIGNING_KEY: 'y'.repeat(32), INTERNAL_CRON_SECRET: 'z',
  EXTRACTION_PROVIDER: 'rules',
});

describe('DEV_FIXTURE_OFFERS', () => {
  it('is available in development', () => {
    const e = parseEnv({ NODE_ENV: 'development', APP_MODE: 'live', DEV_FIXTURE_OFFERS: 'true' });
    expect(e.DEV_FIXTURE_OFFERS).toBe(true);
    expect(e.isProductionLike).toBe(false);
  });

  it('is refused in every production-like environment', () => {
    for (const appEnv of ['production', 'staging'] as const) {
      expect(() => parseEnv({ ...prodLike(appEnv), DEV_FIXTURE_OFFERS: 'true' })).toThrow(ConfigurationError);
      expect(() => parseEnv({ ...prodLike(appEnv), DEV_FIXTURE_OFFERS: 'true' })).toThrow(/not allowed in/);
    }
  });

  it('defaults off, so a deploy that never sets it is unaffected', () => {
    expect(parseEnv({ ...prodLike('production') }).DEV_FIXTURE_OFFERS).toBe(false);
    expect(parseEnv({ NODE_ENV: 'development' }).DEV_FIXTURE_OFFERS).toBe(false);
  });
});
