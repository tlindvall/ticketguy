import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, openMigrationDatabase } from '@/lib/db';
import { ConfigurationError, resetEnvForTests } from '@/lib/config/env';

/**
 * A deploy's pre-deploy migration step runs before (and independently of) the app being configured.
 * It must need the database URL and nothing else: an unset auth secret, model key or public URL is not
 * a reason a migration cannot run, and making it one turns every missing secret into a failed deploy.
 */
const APP_KEYS = ['APP_ENV', 'APP_MODE', 'APP_URL', 'RENDER_EXTERNAL_URL', 'DATABASE_URL', 'BETTER_AUTH_SECRET', 'PREFERENCE_TOKEN_SIGNING_KEY', 'INTERNAL_CRON_SECRET', 'OPENAI_API_KEY'];

describe('migration step configuration independence', () => {
  const saved = Object.fromEntries(APP_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of APP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEnvForTests();
  });

  it('opens from the URL alone in a production environment that the app itself would refuse', async () => {
    for (const k of APP_KEYS) delete process.env[k];
    process.env.APP_ENV = 'production';
    process.env.APP_MODE = 'live';
    resetEnvForTests();

    // The application refuses to start: no DATABASE_URL, no secrets, no public URL.
    await expect(openDatabase()).rejects.toThrow(ConfigurationError);

    // The migration step still connects (postgres.js is lazy; this asserts config is never consulted).
    const h = await openMigrationDatabase('postgres://user:pw@db.invalid:5432/ticketguy');
    expect(h.driver).toBe('postgres');
    await h.close();
  });

  it('still rejects a non-postgres migration URL', async () => {
    await expect(openMigrationDatabase('mysql://nope/db')).rejects.toThrow(/postgres:\/\//);
  });
});
