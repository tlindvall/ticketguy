import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { providerError, ModelOutputError } from '@/lib/ai/model-client';
import { reserveBudget, settleBudget, releaseBudget, BudgetExceededError, requestSpendUsd } from '@/lib/ai/budget';
import { enqueueOutbox, leaseDueOutbox, markFailed, CUSTOMER_WORK_MAX_ATTEMPTS } from '@/lib/intake/outbox';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { offersInText, partyTerms } from '@/lib/advice/text-offers';
import { questionsAsked, withFaceValueCheck } from '@/lib/intake/pipeline';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';

/**
 * Round 6 (post-#56 "latest commits" QA): what stopped R05 and V01 and silenced five more, and the arithmetic of
 * the variants that never got an answer live. Each case names the live send it comes from.
 */
describe('provider errors: a refused call is not retried as if the network blinked', () => {
  it('a wrong model, key or billing is rejected; a timeout or a rate limit is transport', () => {
    expect(providerError(404, 'model_not_found', 'The model does not exist').kind).toBe('rejected');
    expect(providerError(401, null, 'Incorrect API key').kind).toBe('rejected');
    expect(providerError(400, 'invalid_request_error', 'Unsupported value: reasoning.effort').kind).toBe('rejected');
    expect(providerError(429, 'insufficient_quota', 'You exceeded your current quota').kind).toBe('rejected');
    expect(providerError(429, 'rate_limit_exceeded', 'Rate limit reached').kind).toBe('transport');
    expect(providerError(500, null, 'Internal error').kind).toBe('transport');
    expect(providerError(undefined, null, 'Connection error.').kind).toBe('transport');
  });
});

describe('the ledger: spend is what calls cost, and every call counts', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const limits = { requestSoftUsd: 0.5, requestHardUsd: 1, globalDailyUsd: 1, maxCallsPerRevision: 3 };
  const reserve = (requestId: string, usd: number, revision = 1) => reserveBudget(h.db, { requestId, revision, runId: null, jobName: 'extract', model: 'm', estimatedUsdMicros: usd * 1e6, limits, now: FIXTURE_NOW });

  it('a settled call counts at its actual cost, not its estimate (live: the cap filled with spend that never happened)', async () => {
    const id = '90000000-0000-4000-8000-000000000001';
    const first = await reserve(id, 0.6);
    await settleBudget(h.db, first.ledgerId, { inputTokens: 1000, outputTokens: 200, toolCalls: 0, actualUsdMicros: 10_000 });
    // Counted at its $0.60 estimate this second call would take the day past $1; at its actual $0.01 it fits.
    await expect(reserve(id, 0.6)).resolves.toBeDefined();
    expect(await requestSpendUsd(h.db, id)).toBeCloseTo(0.61, 5);
  });

  it('settled calls still count toward the per-revision call cap; a released one does not', async () => {
    const id = '90000000-0000-4000-8000-000000000002';
    for (let i = 0; i < 2; i++) {
      const r = await reserve(id, 0.001);
      await settleBudget(h.db, r.ledgerId, { inputTokens: 10, outputTokens: 10, toolCalls: 0, actualUsdMicros: 100 });
    }
    await reserve(id, 0.001);
    await releaseBudget(h.db, { requestId: id, revision: 1, model: 'm', estimatedUsdMicros: 1000, jobName: 'extract' });
    const fourth = await reserve(id, 0.001).catch((e) => e);
    expect(fourth).not.toBeInstanceOf(BudgetExceededError);
    const fifth = await reserve(id, 0.001).catch((e) => e);
    expect(fifth).toBeInstanceOf(BudgetExceededError);
    expect((fifth as BudgetExceededError).scope).toBe('call_count');
  });
});

describe('outbox: customer work gives up after four tries, everything else after eight', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it(`request.interpret is dead on attempt ${CUSTOMER_WORK_MAX_ATTEMPTS}; email.send_requested keeps retrying`, async () => {
    await enqueueOutbox(h.db, { eventType: 'request.interpret', eventKey: 'k-interpret', entityId: '90000000-0000-4000-8000-000000000010', payload: {}, now: FIXTURE_NOW });
    await enqueueOutbox(h.db, { eventType: 'email.send_requested', eventKey: 'k-send', entityId: '90000000-0000-4000-8000-000000000011', payload: {}, now: FIXTURE_NOW });
    const results: Record<string, string[]> = { 'request.interpret': [], 'email.send_requested': [] };
    let at = FIXTURE_NOW.getTime();
    for (let i = 0; i < CUSTOMER_WORK_MAX_ATTEMPTS; i++) {
      for (const ev of await leaseDueOutbox(h.db, { limit: 10, now: new Date(at) })) results[ev.eventType]!.push(await markFailed(h.db, ev, 'boom', new Date(at)));
      at += 86_400_000;
    }
    expect(results['request.interpret']).toEqual(['retry', 'retry', 'retry', 'dead']);
    expect(results['email.send_requested']).toEqual(['retry', 'retry', 'retry', 'retry']);
  });
});

describe('a provider that refuses the call: the email is read by rules and answered, and the refusal is counted', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('a 404 for the model name answers the customer instead of parking the request', async () => {
    const who = 'refused@customer.example';
    const refused: Extractor = { name: 'model', extract: async () => { throw providerError(404, 'model_not_found', 'The model `gpt-x` does not exist'); } };
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: who }), extractor: refused });
    const r = (await c.ingestInbound(inbound({ text: 'Two tickets for the Rangers game on October 1, up to $300 total', from: who }))) as { requestId: string };
    for (const ev of await leaseDueOutbox(h.db, { limit: 10, now: FIXTURE_NOW })) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).not.toBe('manual_attention');
    const fallbacks = await h.db.select().from(t.auditLog).where(eq(t.auditLog.action, 'ai.provider_rules_fallback'));
    expect(fallbacks).toHaveLength(1);
    expect(JSON.stringify(fallbacks[0]!.diff)).toContain('does not exist');
    // A malformed or refused answer is about this message, so that still goes to a person.
    expect(new ModelOutputError('refusal', 'no').kind).toBe('refusal');
  });
});

describe('the variants that never got an answer live, as arithmetic', () => {
  it('V02: "$190 all-in for both" is the pair’s total, and Los Angeles times convert to New York time', () => {
    const text = 'Offer A costs $190 all-in for both and guarantees transfer by 10:30am LOS ANGELES time that day. Offer B costs $220 all-in for both and guarantees transfer by 9:30am LOS ANGELES time that day.';
    const [a, b] = offersInText(text, 'America/New_York');
    expect([a!.totalCents, a!.perTicketCents, a!.deliveryMinutes, a!.deliveryAsWritten]).toEqual([19000, null, 13 * 60 + 30, '10:30am Los Angeles time']);
    expect([b!.totalCents, b!.deliveryMinutes]).toEqual([22000, 12 * 60 + 30]);
    expect(partyTerms(['We need the tickets in our account no later than 1pm NEW YORK time on October 1.'], 'America/New_York').deadlineMinutes).toBe(13 * 60);
  });

  it('V04: a per-ticket fee and an order fee both count, and "both offers say immediate transfer" mid-sentence is shared', () => {
    const text = 'Same section and row; both offers say immediate transfer. First seller: $52.50 per ticket, a $12.75 fee PER TICKET, and an $8 fee for the WHOLE ORDER. No taxes or other charges. Second seller: $68 per ticket INCLUDING every fee, no other charges.';
    const [first, second] = offersInText(text);
    expect([first!.perTicketCents, first!.perTicketFeeCents, first!.orderFeeCents, first!.deliveryMinutes]).toEqual([5250, 1275, 800, 0]);
    expect([second!.perTicketCents, second!.deliveryMinutes]).toEqual([6800, 0]);
  });

  it('R05-F1: the one offer kept from a comparison is read, with what they say about it after its sentence', () => {
    const text = 'Ignore Offer A now. I only want your view on Offer B: TWO ordinary seats together in section 211 row 12, $105 each INCLUDING ALL FEES, $210 total. Neither seat is a wheelchair or companion space. The seller now says mobile transfer is immediate.';
    expect(offersInText(text)).toEqual([]);
    const [b] = offersInText(text, 'America/New_York', 1);
    expect([b!.label, b!.perTicketCents, b!.deliveryMinutes, b!.accessible]).toEqual(['B', 10500, 0, false]);
  });

  it('A11-F1: the hypothetical other price is read with its fee basis', () => {
    expect(questionsAsked('And if another offer is $98.89 each BEFORE fees, would adding its fees make its gap from our $88 all-in price larger or smaller?').gapAgainst).toEqual({ perTicketCents: 9889, beforeFees: true });
    expect(questionsAsked('Is $98 each a good price?').gapAgainst).toBeNull();
  });

  it('G02: the lowest face value times the party already over the cap is said with the arithmetic', () => {
    const x = { budgetCents: 15000, budgetBasis: 'whole_party', quantity: 3 } as Parameters<typeof withFaceValueCheck>[1];
    expect(withFaceValueCheck(['$150 in total for all 3, once fees are added', 'Admission for your 16-year-old'], x, { faceMinCents: 5910 })).toEqual([
      '$150 in total: Ticketmaster lists these from $59.10 a ticket before fees, so three already come to $177.30 before fees, over your $150',
      'Admission for your 16-year-old',
    ]);
    expect(withFaceValueCheck(['$200 in total for all 3, once fees are added'], { ...x, budgetCents: 20000 }, { faceMinCents: 5910 })).toEqual(['$200 in total for all 3, once fees are added']);
  });
});

describe('the rules reader: who is going and what the budget covers', () => {
  const read = (text: string) => new FixtureExtractor().extract({ messageId: 'm1', text, subject: null, receivedAt: FIXTURE_NOW, venueTimeZone: 'America/New_York', knownEntities: [] });

  it('"with a friend" is two; "two adults and our 16-year-old" is three; "a ticket for a friend" stays one', async () => {
    expect((await read('I want to attend Rangers vs Tampa Bay at MSG on October 1 with a friend.')).quantity).toBe(2);
    expect((await read("We're two adults and our 16-year-old in Manhattan on Saturday.")).quantity).toBe(3);
    expect((await read('Two adults and two kids for the Knicks on Friday.')).quantity).toBe(4);
    expect((await read('I need a ticket for a friend for the Knicks on Friday.')).quantity).toBe(1);
  });

  it('"$200 for the whole order" and "$600 for the whole group" are totals, so nothing is assumed about them', async () => {
    expect((await read('Four of us, budget $200 for the whole order.')).budgetBasis).toBe('whole_party');
    expect((await read('Five seats. Maximum $600 for the whole group including all fees.')).budgetBasis).toBe('whole_party');
  });
});
