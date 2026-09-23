import { describe, expect, it } from 'vitest';
import { ConfigurationError, parseEnv } from '@/lib/config/env';
import { selectModelClient } from '@/lib/services';

const prod = {
  NODE_ENV: 'production', APP_ENV: 'production', APP_MODE: 'live',
  DATABASE_URL: 'postgres://u@h/db', APP_URL: 'https://app.example',
  BETTER_AUTH_SECRET: 'x'.repeat(32), PREFERENCE_TOKEN_SIGNING_KEY: 'y'.repeat(32), INTERNAL_CRON_SECRET: 'z',
};

describe('provider selection', () => {
  it('requires the key of whichever provider is named', () => {
    expect(() => parseEnv({ ...prod, EXTRACTION_PROVIDER: 'openai' })).toThrow(/requires OPENAI_API_KEY/);
    expect(() => parseEnv({ ...prod, EXTRACTION_PROVIDER: 'anthropic' })).toThrow(/requires ANTHROPIC_API_KEY/);
  });

  it('lets rules mode start with no model key at all', () => {
    const e = parseEnv({ ...prod, EXTRACTION_PROVIDER: 'rules' });
    expect(e.modelName).toBeNull();
    expect(selectModelClient(e)).toBeNull();
  });

  it('never infers the provider from whichever key happens to be set', () => {
    // An OPENAI_API_KEY left over from a previous provider must not quietly take over an Anthropic run.
    const e = parseEnv({ ...prod, EXTRACTION_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-proj-stale' });
    expect(e.modelName).toBe('claude-opus-5');
    expect(selectModelClient(e)?.client.provider).toBe('anthropic');
  });

  it('selects OpenAI and prices against the OpenAI model', () => {
    const e = parseEnv({ ...prod, EXTRACTION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-proj-test', OPENAI_BASE_MODEL: 'gpt-5.5' });
    expect(e.modelName).toBe('gpt-5.5');
    expect(selectModelClient(e)?.client.provider).toBe('openai');
  });

  it('rejects a malformed price override at startup rather than at spend time', () => {
    expect(() => parseEnv({ ...prod, EXTRACTION_PROVIDER: 'rules', MODEL_PRICES_USD_PER_MTOKEN: 'gpt-5.5=1.25' })).toThrow(ConfigurationError);
    expect(parseEnv({ ...prod, EXTRACTION_PROVIDER: 'rules', MODEL_PRICES_USD_PER_MTOKEN: 'gpt-5.5=1.25:10' }).modelPrices['gpt-5.5']).toEqual({ input: 1.25, output: 10 });
  });
});
