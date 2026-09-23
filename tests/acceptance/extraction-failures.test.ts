import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import { openTestDb, testEnv, inbound } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { ModelOutputError } from '@/lib/ai/model-client';
import type { Extractor, ExtractionInput } from '@/lib/ai/extraction';
import type { RequestExtraction } from '@/lib/domain/types';
import { FIXTURE_NOW, FIXTURE_OFFERS } from '@/lib/fixtures';
import * as t from '@/lib/db/schema';

/**
 * A model call fails in two very different ways. A transport failure is transient, so the request has to
 * stay retryable and the reservation has to come back. A refusal or malformed output is deterministic, so
 * the request goes to staff — and the board has to say which of the two it was, which the class name alone
 * never did.
 */
class ThrowingExtractor implements Extractor {
  readonly name = 'openai'; // any non-'fixture' name takes the budgeted path
  lastUsage = null;
  constructor(private readonly error: Error) {}
  async extract(_input: ExtractionInput): Promise<RequestExtraction> {
    throw this.error;
  }
}

const conciergeWith = (h: DbHandle, error: Error) =>
  new Concierge({
    db: h.db,
    env: testEnv({ EXTRACTION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', MODEL_PRICES_USD_PER_MTOKEN: 'gpt-5.5=5:30' }),
    extractor: new ThrowingExtractor(error),
    drafter: new FixtureDrafter(),
    clock: () => FIXTURE_NOW,
    emailProvider: null,
    fixtureOffers: FIXTURE_OFFERS,
  });

const ledgerTotalUsdMicros = async (h: DbHandle, requestId: string) => {
  const [r] = await h.db
    .select({ total: sql<number>`coalesce(sum(case when kind = 'released' then -estimated_usd_micros else estimated_usd_micros end),0)::bigint` })
    .from(t.usageLedger)
    .where(eq(t.usageLedger.requestId, requestId));
  return Number(r?.total ?? 0);
};

describe('extraction failures', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('rethrows a transport failure so the outbox retries instead of parking the request', async () => {
    const c = conciergeWith(h, new ModelOutputError('transport', '503: service unavailable'));
    const res = await c.ingestInbound(inbound({ text: 'Two Rangers tickets please.', from: 'transport@customer.example' }));
    const requestId = (res as { requestId: string }).requestId;

    await expect(c.interpret({ messageId: (res as { messageId: string }).messageId, requestId })).rejects.toThrow('503');

    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req?.state).not.toBe('manual_attention'); // still retryable
  });

  it('releases the budget reservation for a call that never reached the model', async () => {
    const c = conciergeWith(h, new ModelOutputError('transport', 'ETIMEDOUT'));
    const res = await c.ingestInbound(inbound({ text: 'Three Knicks tickets please.', from: 'release@customer.example' }));
    const requestId = (res as { requestId: string }).requestId;

    await expect(c.interpret({ messageId: (res as { messageId: string }).messageId, requestId })).rejects.toThrow();

    expect(await ledgerTotalUsdMicros(h, requestId)).toBe(0); // reserved, then released
  });

  it('sends a refusal to staff with the kind and the provider message, and keeps the reservation', async () => {
    const c = conciergeWith(h, new ModelOutputError('refusal', 'declined (cannot assist)'));
    const res = await c.ingestInbound(inbound({ text: 'Four Yankees tickets please.', from: 'refusal@customer.example' }));
    const requestId = (res as { requestId: string }).requestId;

    const out = await c.interpret({ messageId: (res as { messageId: string }).messageId, requestId });
    expect(out.state).toBe('manual_attention');

    const transitions = await h.db.select().from(t.requestTransitions).where(eq(t.requestTransitions.requestId, requestId));
    const reason = transitions.at(-1)?.reason ?? '';
    expect(reason).toContain('refusal');
    expect(reason).toContain('cannot assist');
    expect(reason).not.toBe('extraction_failed:ModelOutputError'); // the old, unactionable reason

    expect(await ledgerTotalUsdMicros(h, requestId)).toBeGreaterThan(0); // tokens were burned; the reservation stands
  });

  it('distinguishes truncated output from a refusal in the reason', async () => {
    const c = conciergeWith(h, new ModelOutputError('incomplete', 'output incomplete (max_output_tokens) at max_output_tokens=8000'));
    const res = await c.ingestInbound(inbound({ text: 'Five Islanders tickets please.', from: 'incomplete@customer.example' }));
    const requestId = (res as { requestId: string }).requestId;

    await c.interpret({ messageId: (res as { messageId: string }).messageId, requestId });
    const transitions = await h.db.select().from(t.requestTransitions).where(eq(t.requestTransitions.requestId, requestId));
    const reason = transitions.at(-1)?.reason ?? '';
    expect(reason).toContain('incomplete');
    expect(reason).toContain('max_output_tokens');
  });

  it('records the ledger against the model the cost was estimated from', async () => {
    const c = conciergeWith(h, new ModelOutputError('refusal', 'declined'));
    const res = await c.ingestInbound(inbound({ text: 'Six Devils tickets please.', from: 'model@customer.example' }));
    const requestId = (res as { requestId: string }).requestId;
    await c.interpret({ messageId: (res as { messageId: string }).messageId, requestId });

    const [row] = await h.db.select({ model: t.usageLedger.model }).from(t.usageLedger).where(eq(t.usageLedger.requestId, requestId));
    expect(row?.model).toBe('gpt-5.5');
  });
});
