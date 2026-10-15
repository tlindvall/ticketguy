/**
 * Whether an eval run's results can be trusted enough to file or close issues from (evals/report-failures.ts).
 *
 * A run whose model calls failed scores the failure, not the product: a 429 or an exhausted quota leaves threads
 * unanswered (or answered by the rules fallback) and judges unscored, and every issue it touches would be filed or
 * closed on noise. Every OpenAI client in the eval (the app's, the judges', the simulated customer's) is wrapped with
 * Braintrust's wrapOpenAI, so a failed call is an `llm` span with `error` set (the summary's llm_errors); a task or
 * scorer that threw carries its error on its own span.
 */
export type Span = { span_attributes?: { type?: string; name?: string }; error?: unknown };

const PROVIDER = /\b429\b|insufficient_quota|rate[_ ]limit/i;

const errorText = (e: unknown): string => (e == null ? '' : typeof e === 'string' ? e : JSON.stringify(e));

export type ProviderErrors = { llmErrors: number; quotaOrRateLimit: number; total: number };

/** Counts failed LLM calls and any span error naming a 429, a rate limit or insufficient_quota. */
export function providerErrors(spans: Span[]): ProviderErrors {
  let llmErrors = 0;
  let quotaOrRateLimit = 0;
  let total = 0;
  for (const s of spans) {
    const text = errorText(s.error);
    if (!text) continue;
    const llm = s.span_attributes?.type === 'llm';
    const provider = PROVIDER.test(text);
    if (llm) llmErrors++;
    if (provider) quotaOrRateLimit++;
    if (llm || provider) total++;
  }
  return { llmErrors, quotaOrRateLimit, total };
}

/**
 * The refusal, or null when the run is clean. Counts only: provider messages can echo a masked key or an
 * organisation id, and this line lands in a public Actions log.
 */
export function providerErrorRefusal(spans: Span[], experimentName: string): string | null {
  const p = providerErrors(spans);
  if (!p.total) return null;
  return `${experimentName} had provider errors: ${p.llmErrors} failed LLM call(s), ${p.quotaOrRateLimit} span(s) naming a 429, a rate limit or insufficient_quota. Its scores measure the outage, not the product, so no issues were filed or closed. Fix the provider (quota or rate limit) and re-run the workflow.`;
}
