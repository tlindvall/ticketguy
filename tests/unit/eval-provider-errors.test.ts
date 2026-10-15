import { describe, expect, it } from 'vitest';
import { providerErrorRefusal, providerErrors } from '../../evals/run-health';

/** report-failures refuses to file or close issues from a run whose model calls failed. */
describe('provider errors in an eval run', () => {
  const llm = (error?: unknown) => ({ span_attributes: { type: 'llm', name: 'Chat Completion' }, error });
  const task = (error?: unknown) => ({ span_attributes: { type: 'task' }, error });
  const score = (error?: unknown) => ({ span_attributes: { type: 'score' }, error });

  it('a clean run passes', () => {
    const spans = [llm(), llm(null), task(), score(), { span_attributes: { type: 'eval' } }];
    expect(providerErrors(spans)).toEqual({ llmErrors: 0, quotaOrRateLimit: 0, total: 0 });
    expect(providerErrorRefusal(spans, 'exp-1')).toBeNull();
  });

  it('any failed LLM call refuses (llm_errors > 0), whatever its message', () => {
    expect(providerErrors([llm('500 The server had an error while processing your request.')])).toEqual({ llmErrors: 1, quotaOrRateLimit: 0, total: 1 });
    expect(providerErrorRefusal([llm('Request timed out.')], 'exp-1')).toMatch(/^exp-1 had provider errors: 1 failed LLM call\(s\)/);
  });

  it('a 429 or insufficient_quota in a task or scorer error refuses, as a string or an object', () => {
    expect(providerErrors([task('Error: 429 You exceeded your current quota, please check your plan and billing details.')]).quotaOrRateLimit).toBe(1);
    expect(providerErrors([score({ message: 'quota exceeded', code: 'insufficient_quota' })]).quotaOrRateLimit).toBe(1);
    expect(providerErrors([task('RateLimitError: Rate limit reached for requests')]).quotaOrRateLimit).toBe(1);
    // The Oct 15 outage named it credit_balance_exhausted; it counts with or without the status code beside it.
    expect(providerErrors([task({ error: { code: 'credit_balance_exhausted' } })]).quotaOrRateLimit).toBe(1);
    expect(providerErrorRefusal([task('429 Too Many Requests')], 'exp-2')).not.toBeNull();
  });

  it('an ordinary task error that is not the provider does not refuse (the scores say what broke)', () => {
    expect(providerErrorRefusal([task("TypeError: Cannot read properties of undefined (reading 'id')")], 'exp-3')).toBeNull();
  });

  it('counts one failed call once, even when it is also a 429', () => {
    expect(providerErrors([llm('429 insufficient_quota'), task('429 insufficient_quota')])).toEqual({ llmErrors: 1, quotaOrRateLimit: 2, total: 2 });
  });

  it('never echoes the provider message: it can carry a masked key or an organisation id into a public log', () => {
    const msg = providerErrorRefusal([llm('401 Incorrect API key provided: sk-proj-abc*****wxyz. org-Secret123')], 'exp-4')!;
    expect(msg).not.toMatch(/sk-|org-|Incorrect API key/);
    expect(msg).toContain('no issues were filed or closed');
  });
});
