import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { ModelOutputError, type StructuredClient, type StructuredRequest, type StructuredResult } from './model-client';

/**
 * Anthropic Messages API client. Structured output via `output_config.format` + Zod, so a response that
 * does not satisfy the schema is a typed failure rather than something to salvage. Prompts and schema
 * validation live in model-client.ts; this file is only the provider call and its failure mapping.
 */
export class AnthropicClient implements StructuredClient {
  readonly provider = 'anthropic';
  readonly client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  /**
   * Thinking is adaptive with an explicit effort level; `maxOutputTokens` must leave room for it, because
   * thinking tokens count against the same ceiling.
   *
   * Server-side fallbacks are enabled: if a safety classifier declines the request, the API re-runs it on
   * a fallback model inside the same call instead of failing. Our own refusal path (route to staff) stays
   * as the last resort.
   */
  async parseStructured<T extends z.ZodType>(args: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    let res;
    try {
      res = await this.client.beta.messages.parse({
        model: args.model,
        max_tokens: args.maxOutputTokens,
        system: args.instructions,
        messages: [{ role: 'user', content: args.input }],
        thinking: { type: 'adaptive' },
        output_config: { format: betaZodOutputFormat(args.schema), effort: args.effort },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new ModelOutputError('transport', `${e.status ?? 'api'}: ${e.message}`);
      throw new ModelOutputError('transport', e instanceof Error ? e.message : String(e));
    }
    if (res.stop_reason === 'refusal') {
      throw new ModelOutputError('refusal', `declined (${res.stop_details?.category ?? 'unspecified'})`);
    }
    if (res.stop_reason === 'max_tokens') {
      throw new ModelOutputError('incomplete', `output truncated at max_tokens=${args.maxOutputTokens}`);
    }
    if (!res.parsed_output) throw new ModelOutputError('malformed', 'response did not satisfy the schema');
    return {
      output: res.parsed_output as z.infer<T>,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      servedByModel: res.model,
    };
  }
}
