import { describe, expect, it } from 'vitest';
import { parseEnv, ConfigurationError } from './env';

describe('env parsing', () => {
  it('defaults to fixture mode with all sends disabled', () => {
    const e = parseEnv({});
    expect(e.APP_MODE).toBe('fixture');
    expect(e.EMAIL_SEND_ENABLED).toBe(false);
    expect(e.MARKETING_SEND_ENABLED).toBe(false);
    expect(e.WATCH_SEND_ENABLED).toBe(false);
    expect(e.HUMAN_REVIEW_REQUIRED).toBe(true);
  });
  it('treats the string "false" as disabled and rejects junk booleans', () => {
    expect(parseEnv({ EMAIL_SEND_ENABLED: 'false', APP_MODE: 'live' }).EMAIL_SEND_ENABLED).toBe(false);
    expect(() => parseEnv({ EMAIL_SEND_ENABLED: 'yes' })).toThrow();
  });
  it('A41: production refuses to start without DATABASE_URL', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', APP_MODE: 'live' })).toThrow(ConfigurationError);
    expect(() => parseEnv({ APP_ENV: 'staging', APP_MODE: 'live', DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
  it('refuses fixture mode in production and live sends in fixture mode', () => {
    expect(() =>
      parseEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', APP_MODE: 'fixture' }),
    ).toThrow(/fixture/);
    expect(() => parseEnv({ EMAIL_SEND_ENABLED: 'true' })).toThrow(/fixture/);
  });
  it('refuses an uninstalled object-store adapter', () => {
    expect(() => parseEnv({ MEDIA_PROVIDER: 's3' })).toThrow(/object-store/);
  });
  it('accepts a complete production configuration', () => {
    const e = parseEnv({
      NODE_ENV: 'production',
      APP_MODE: 'live',
      DATABASE_URL: 'postgresql://u:p@h/db',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
      PREFERENCE_TOKEN_SIGNING_KEY: 'y'.repeat(40),
      INTERNAL_CRON_SECRET: 'z',
    });
    expect(e.isProductionLike).toBe(true);
    expect(e.EMAIL_SEND_ENABLED).toBe(false);
  });
});
