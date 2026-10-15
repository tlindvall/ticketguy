/**
 * Counts failed model calls in a local eval run. With Braintrust (before), every failed call was an `llm` span with
 * an error; a local run has no spans, so this watches the OpenAI HTTP traffic instead: the app's client, the judges'
 * and the simulated customer's all use the global fetch (the SDK reads it when a client is constructed, so this is
 * installed before any client exists).
 *
 * Only a call that has finally failed counts: the SDK retries 408/409/429/5xx up to twice (maxRetries 2, every client
 * here), so a 429 that succeeds on retry is not an outage. A response the provider marks "don't retry"
 * (x-should-retry: false, e.g. insufficient_quota) is final at once. Counts only: provider messages can echo a masked
 * key or an organisation id, and the counts land in a public log.
 */
import { PROVIDER } from './run-health';
import type { ProviderCounts } from './results';

const MAX_RETRIES = 2;
const OPENAI = /^https:\/\/api\.openai\.com\//;

/** Whether a failed attempt is the last one the SDK will make. */
export function finalFailure(status: number, retryCount: number, shouldRetryHeader: string | null): boolean {
  if (shouldRetryHeader === 'false') return true;
  const retryable = shouldRetryHeader === 'true' || status === 408 || status === 409 || status === 429 || status >= 500;
  return !retryable || retryCount >= MAX_RETRIES;
}

const urlOf = (input: unknown) => (typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? '');
const retryCountOf = (input: unknown, init?: RequestInit) => {
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return Number(h.get('x-stainless-retry-count') ?? 0);
};

export function installProviderWatch(): { counts: () => ProviderCounts } {
  const counts: ProviderCounts = { llmErrors: 0, quotaOrRateLimit: 0 };
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!OPENAI.test(urlOf(input))) return inner(input, init);
    const tries = retryCountOf(input, init);
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (e) {
      if (tries >= MAX_RETRIES) counts.llmErrors++; // connection errors are retried like 5xx
      throw e;
    }
    if (res.status >= 400 && finalFailure(res.status, tries, res.headers.get('x-should-retry'))) {
      counts.llmErrors++;
      const body = await res.clone().text().catch(() => '');
      if (res.status === 429 || PROVIDER.test(body)) counts.quotaOrRateLimit++;
    }
    return res;
  }) as typeof fetch;
  return { counts: () => ({ ...counts }) };
}
