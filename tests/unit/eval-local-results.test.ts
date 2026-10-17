import { afterEach, describe, expect, it } from 'vitest';
import { judgeCheck, scoreCapRefusal, threadResult, threadPassed, type EvalResults, type ThreadResult } from '../../evals/results';
import { appendHistory, compare, passRates, summaryMarkdown } from '../../evals/report';
import { openThreads, sealThreads, threadsKey } from '../../evals/threads-store';
import { finalFailure, installProviderWatch } from '../../evals/provider-watch';
import { isProviderError, providerCountsRefusal } from '../../evals/run-health';
import type { TurnOut } from '../../evals/harness';

/** Evals run locally by default (no Braintrust); these are the pieces that turn a run into a file, a summary and a trend. */
const turn = (step: number, customer: string, reply: string) => ({ step, customer, reply }) as TurnOut;
const thread = (id: string, checks: Record<string, boolean | null>, extra: Partial<ThreadResult> = {}): ThreadResult => ({
  id, scenario: 'x', tags: [], error: null,
  checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { score: v == null ? null : v ? 1 : 0, pass: v, reason: v === false ? 'step 1: bad' : null }])),
  ...extra,
});
const run = (threads: ThreadResult[], over: Partial<EvalResults> = {}): EvalResults => ({
  version: 1, createdAt: '2026-10-15T20:00:00.000Z', commit: 'abc1234', suite: 'pr', model: 'm', expected: threads.length, sentToBraintrust: false,
  provider: { llmErrors: 0, quotaOrRateLimit: 0 }, threads, ...over,
});

describe('pass or fail per check', () => {
  it('a check fails below a perfect score and says which steps', () => {
    expect(judgeCheck('prices_grounded', 1, {})).toEqual({ pass: true, reason: null });
    expect(judgeCheck('prices_grounded', 0.5, { failures: [{ step: 3, why: '$412 not in data' }] })).toEqual({ pass: false, reason: 'step 3: $412 not in data' });
    expect(judgeCheck('no_repeated_reply', 0, { failures: [{ step: 4, similarity: 0.93 }] }).reason).toBe('step 4: similarity 0.93');
    expect(judgeCheck('thread_coherence', 0.5, { summary: 'forgot the budget', broke_at_step: 5 }).reason).toBe('broke at step 5: forgot the budget');
  });

  it('answered_the_question fails only on an outright "no"', () => {
    expect(judgeCheck('answered_the_question', 0.5, { reasons: [{ step: 2, verdict: 'partly', reason: 'buried' }] }).pass).toBe(true);
    expect(judgeCheck('answered_the_question', 0, { reasons: [{ step: 2, verdict: 'no', reason: 'answered another question' }] })).toEqual({ pass: false, reason: 'step 2: answered another question' });
  });

  it('a check that did not apply is neither', () => {
    expect(judgeCheck('thread_coherence', null, {})).toEqual({ pass: null, reason: null });
  });
});

describe('eval-results.json is a public artifact', () => {
  it('a real customer thread keeps its id and failing steps, never its words, our replies or its error text', () => {
    const t = threadResult({
      id: 'prod/1a2b3c4d', scenario: 'production-replay',
      checks: { only_what_was_asked: { score: 0, metadata: { failures: [{ step: 2, why: 'mostly_extra: "Hi Dana, your seats at 12 Elm St"' }] } }, answered_the_question: { score: null, error: 'Error: judge choked on "Dana"' } },
      output: [turn(1, 'my name is Dana', 'Hi Dana')],
    });
    expect(JSON.stringify(t)).not.toMatch(/Dana|Elm/);
    expect(t.checks.only_what_was_asked).toMatchObject({ pass: false, reason: 'step 2 (real customer thread)' });
    expect(t.transcript).toBeUndefined();
    expect(threadResult({ id: 'prod/1a2b3c4d', scenario: 'p', checks: {}, error: new TypeError('cannot read "Dana"') }).error).toBe('TypeError (real customer thread)');
  });

  it('an eval-world thread keeps its reasons and transcript for issue examples', () => {
    const t = threadResult({ id: 'rangers-budget-other-games', scenario: 'budget', checks: { prices_grounded: { score: 0, metadata: { failures: [{ step: 1, why: '$9 not in data' }] } } }, output: [turn(1, 'two for the rangers', 'Here you go: $138')] });
    expect(t.checks.prices_grounded!.reason).toBe('step 1: $9 not in data');
    expect(t.transcript).toEqual([{ step: 1, customer: 'two for the rangers', reply: 'Here you go: $138' }]);
  });

  it('a thread fails when any check failed or it did not run', () => {
    expect(threadPassed(thread('a', { x: true, y: null }))).toBe(true);
    expect(threadPassed(thread('a', { x: true, y: false }))).toBe(false);
    expect(threadPassed(thread('a', {}, { error: 'boom' }))).toBe(false);
    expect(threadPassed(thread('a', { y: null }))).toBeNull();
  });
});

describe('sending to Braintrust is capped', () => {
  it('one score per thread, refused above 2,000', () => {
    expect(scoreCapRefusal(2000)).toBeNull();
    expect(scoreCapRefusal(2001)).toMatch(/refusing to send 2001 threads/);
  });
});

describe('summary and diff against the previous run', () => {
  const prev = run([thread('a', { p: true, q: true }), thread('b', { p: false, q: true }), thread('c', { p: true, q: true }), thread('gone', { p: false })], { commit: 'old0001' });
  const now = run([thread('a', { p: false, q: true }), thread('b', { p: true, q: true }), thread('c', { p: true, q: null }), thread('new', { p: false })]);

  it('pass rate per check counts only threads where it applied', () => {
    expect(Object.fromEntries(passRates(now.threads))).toEqual({ p: { passed: 2, judged: 4 }, q: { passed: 2, judged: 2 } });
  });

  it('compares on the threads both runs scored, and lists newly failing and newly passing threads', () => {
    const c = compare(now, prev);
    expect(c.common).toBe(3);
    expect(c.rows.find((r) => r.check === 'p')).toEqual({ check: 'p', now: (100 * 2) / 3, before: (100 * 2) / 3 });
    expect(c.newlyFailing).toEqual([{ id: 'a', checks: ['p'] }]);
    expect(c.newlyPassing).toEqual([{ id: 'b', checks: ['p'] }]);
  });

  it('the markdown has the table, the previous run and both lists', () => {
    const md = summaryMarkdown(now, { previous: prev, previousUrl: 'https://github.com/o/r/actions/runs/1' });
    expect(md).toContain('| check | pass rate | previous | change |');
    expect(md).toContain('| p | 50.0% (2/4) | 66.7% | 0 |');
    expect(md).toContain('[the previous run](https://github.com/o/r/actions/runs/1) (`old0001`, pr) on the 3 threads both scored');
    expect(md).toMatch(/\*\*Newly failing \(1\)\*\*\n- `a`: p/);
    expect(md).toMatch(/\*\*Newly passing \(1\)\*\*\n- `b`: p/);
    expect(md).toContain('nothing sent to Braintrust');
  });

  it('without a previous run it says so; a refusal is shown above the table', () => {
    const md = summaryMarkdown(now, { refusal: 'had provider errors' });
    expect(md).toContain('_No previous run to compare with._');
    expect(md).toContain('> had provider errors');
  });
});

describe('history.csv', () => {
  it('starts with a header and appends one row per run', () => {
    const one = appendHistory(null, run([thread('a', { p: true, q: false }), thread('b', { p: true })]));
    expect(one).toBe('date,commit,suite,threads,p,q\n2026-10-15T20:00:00.000Z,abc1234,pr,2,100.0,0.0\n');
    const two = appendHistory(one, run([thread('a', { p: false, r: true })], { commit: 'def5678', suite: 'nightly' }));
    expect(two.trim().split('\n')).toEqual([
      'date,commit,suite,threads,p,q,r',
      '2026-10-15T20:00:00.000Z,abc1234,pr,2,100.0,0.0,',
      '2026-10-15T20:00:00.000Z,def5678,nightly,1,0.0,,100.0',
    ]);
  });
});

describe('real threads file', () => {
  const key = threadsKey(Buffer.alloc(32, 7).toString('base64'));

  it('round-trips, and is not readable without the key', () => {
    const records = [{ conversationId: 'c1', inbound: [{ at: '2026-10-01T00:00:00Z', text: 'two for saturday' }] }];
    const file = sealThreads(records, key);
    expect(file.toString('latin1')).not.toContain('saturday');
    expect(openThreads(file, key)).toEqual(records);
    expect(() => openThreads(file, threadsKey(Buffer.alloc(32, 8).toString('base64')))).toThrow(/does not open with EVAL_THREADS_KEY/);
    expect(() => openThreads(Buffer.from('nope'), key)).toThrow(/not a production-threads file/);
  });

  it('a key that is not 32 bytes is refused', () => {
    expect(() => threadsKey(undefined)).toThrow(/32 random bytes/);
    expect(() => threadsKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 random bytes/);
  });
});

describe('provider errors without Braintrust spans', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('a failure counts only when the SDK will not retry it', () => {
    expect(finalFailure(429, 0, null)).toBe(false);
    expect(finalFailure(429, 2, null)).toBe(true);
    expect(finalFailure(429, 0, 'false')).toBe(true);
    expect(finalFailure(500, 1, null)).toBe(false);
    expect(finalFailure(400, 0, null)).toBe(true);
  });

  it('counts final OpenAI failures and quota errors, and ignores other hosts and retried ones', async () => {
    const replies: Response[] = [
      new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 }),
      new Response('{"error":{"code":"insufficient_quota"}}', { status: 429, headers: { 'x-should-retry': 'false' } }),
      new Response('{}', { status: 200 }),
      new Response('{"error":"bad"}', { status: 500 }),
    ];
    globalThis.fetch = (async () => replies.shift()!) as typeof fetch;
    const w = installProviderWatch();
    const call = (url: string, retry: number) => fetch(url, { headers: { 'X-Stainless-Retry-Count': String(retry) } });
    await call('https://api.openai.com/v1/responses', 0); // retried 429: not final
    await call('https://api.openai.com/v1/responses', 0); // quota, don't retry: final
    await call('https://api.openai.com/v1/responses', 1); // fine
    await call('https://api.braintrust.dev/x', 2); // not OpenAI
    expect(w.counts()).toEqual({ llmErrors: 1, quotaOrRateLimit: 1 });
  });

  it('refuses on counts, without echoing a provider message', () => {
    expect(providerCountsRefusal({ llmErrors: 0, quotaOrRateLimit: 0 }, 'pr run at abc')).toBeNull();
    expect(providerCountsRefusal({ llmErrors: 2, quotaOrRateLimit: 1 }, 'pr run at abc')).toMatch(/^pr run at abc had provider errors: 2 failed LLM call\(s\), 1 naming a 429/);
    expect(isProviderError(Object.assign(new Error('429 You exceeded your current quota'), { status: 429 }))).toBe(true);
    expect(isProviderError(new TypeError('x is undefined'))).toBe(false);
  });
});
