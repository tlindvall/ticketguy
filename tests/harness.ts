import { openDatabase, type DbHandle } from '@/lib/db';
import { applyMigrations } from '@/lib/db/migrate';
import { seedRegistry, seedFixtures } from '@/lib/db/seed';
import { parseEnv, type Env } from '@/lib/config/env';
import { Concierge, type EmailProvider } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_OFFERS, FIXTURE_NOW } from '@/lib/fixtures';
import type { NormalizedInbound } from '@/lib/intake/contract';

(process.env as Record<string, string>).NODE_ENV = 'test';

export async function openTestDb(): Promise<DbHandle> {
  const h = await openDatabase({ pgliteDataDir: ':memory:' });
  await applyMigrations(h);
  await seedRegistry(h.db);
  await seedFixtures(h.db);
  return h;
}

export class RecordingProvider implements EmailProvider {
  sent: Array<{ idempotencyKey: string; to: string; subject: string; text: string }> = [];
  failNext: 'timeout' | null = null;
  async send(args: { idempotencyKey: string; from: string; to: string; subject: string; text: string; html: string }): Promise<{ providerMessageId: string }> {
    if (this.failNext === 'timeout') {
      this.failNext = null;
      this.sent.push({ idempotencyKey: args.idempotencyKey, to: args.to, subject: args.subject, text: args.text }); // provider accepted, response lost
      throw new Error('ETIMEDOUT');
    }
    this.sent.push({ idempotencyKey: args.idempotencyKey, to: args.to, subject: args.subject, text: args.text });
    return { providerMessageId: `prov-${this.sent.length}` };
  }
}

export function testEnv(over: Record<string, string> = {}): Env {
  return parseEnv({ NODE_ENV: 'test', APP_MODE: 'fixture', ...over });
}

export function makeConcierge(h: DbHandle, opts: { env?: Env; provider?: EmailProvider | null; now?: () => Date } = {}) {
  return new Concierge({ db: h.db, env: opts.env ?? testEnv(), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: opts.now ?? (() => FIXTURE_NOW), emailProvider: opts.provider === undefined ? null : opts.provider, fixtureOffers: FIXTURE_OFFERS });
}

let seq = 0;
export function inbound(over: Partial<NormalizedInbound> & { text: string }): NormalizedInbound {
  seq += 1;
  return {
    provider: 'simulator',
    providerEmailId: `sim-${seq}`,
    rfcMessageId: `<sim-${seq}@customer.example>`,
    inReplyTo: null,
    references: null,
    from: 'alice@customer.example',
    to: ['my@ticketguy.live'],
    subject: 'Rangers tickets',
    headers: {},
    receivedAt: FIXTURE_NOW,
    attachments: [],
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    signatureVerified: false,
    ...over,
  };
}
