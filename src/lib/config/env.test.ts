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
  const prod = {
    NODE_ENV: 'production',
    APP_MODE: 'live',
    APP_URL: 'https://ticketguy.example',
    DATABASE_URL: 'postgresql://u:p@h/db',
    BETTER_AUTH_SECRET: 'x'.repeat(40),
    PREFERENCE_TOKEN_SIGNING_KEY: 'y'.repeat(40),
    INTERNAL_CRON_SECRET: 'z',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  };

  it('accepts a complete production configuration', () => {
    const e = parseEnv(prod);
    expect(e.isProductionLike).toBe(true);
    expect(e.EMAIL_SEND_ENABLED).toBe(false);
    expect(e.APP_URL).toBe('https://ticketguy.example');
  });

  it('falls back to RENDER_EXTERNAL_URL rather than localhost, and refuses a non-https public URL', () => {
    const { APP_URL: _omitted, ...noAppUrl } = prod;
    const e = parseEnv({ ...noAppUrl, RENDER_EXTERNAL_URL: 'https://ticketguy.onrender.com' });
    expect(e.APP_URL).toBe('https://ticketguy.onrender.com');
    // Without either, the localhost default would silently break CSRF origin checks and signed email links.
    expect(() => parseEnv(noAppUrl)).toThrow(/APP_URL must be an https/);
    expect(() => parseEnv({ ...noAppUrl, APP_URL: 'http://ticketguy.example' })).toThrow(/APP_URL must be an https/);
    // Locally the default stands.
    expect(parseEnv({}).APP_URL).toBe('http://localhost:3000');
  });

  it('never silently degrades to the rules extractor in production', () => {
    const { ANTHROPIC_API_KEY: _key, ...noKey } = prod;
    expect(() => parseEnv(noKey)).toThrow(/EXTRACTION_PROVIDER=anthropic requires ANTHROPIC_API_KEY/);
    // Rules-only is allowed, but only as a deliberate choice.
    expect(parseEnv({ ...noKey, EXTRACTION_PROVIDER: 'rules' }).EXTRACTION_PROVIDER).toBe('rules');
  });
});
