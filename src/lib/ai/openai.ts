import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { ModelOutputError, type StructuredClient, type StructuredRequest, type StructuredResult } from './model-client';

/**
 * OpenAI Responses API client. Structured output via `text.format` + Zod, so a response that does not
 * satisfy the schema is a typed failure rather than something to salvage. Prompts and schema validation
 * live in model-client.ts; this file is only the provider call and its failure mapping.
 */
export class OpenAiClient implements StructuredClient {
  readonly provider = 'openai';
  readonly client: OpenAI;
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  /**
   * Reasoning effort is explicit; `maxOutputTokens` must leave room for it, because reasoning tokens
   * count against the same ceiling. Unlike the Anthropic path there is no server-side fallback, so a
   * refusal here goes straight to our own refusal handling (route to staff).
   */
  async parseStructured<T extends z.ZodType>(args: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    let res;
    try {
      res = await this.client.responses.parse({
        model: args.model,
        instructions: args.instructions,
        input: args.input,
        max_output_tokens: args.maxOutputTokens,
        reasoning: { effort: args.effort },
        text: { format: zodTextFormat(args.schema, args.schemaName) },
      });
    } catch (e) {
      if (e instanceof OpenAI.APIError) throw new ModelOutputError('transport', `${e.status ?? 'api'}: ${e.message}`);
      throw new ModelOutputError('transport', e instanceof Error ? e.message : String(e));
    }
    // A refusal is an output item, not a status, so it is checked before the incomplete/malformed paths:
    // a refused response is also unparsed, and reporting it as malformed would hide why.
    const refusal = res.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((part): part is { type: 'refusal'; refusal: string } => part.type === 'refusal');
    if (refusal) throw new ModelOutputError('refusal', `declined (${refusal.refusal.slice(0, 200)})`);

    if (res.status === 'incomplete') {
      throw new ModelOutputError('incomplete', `output incomplete (${res.incomplete_details?.reason ?? 'unspecified'}) at max_output_tokens=${args.maxOutputTokens}`);
    }
    if (res.status && res.status !== 'completed') {
      throw new ModelOutputError('transport', `response status ${res.status}${res.error ? `: ${res.error.message}` : ''}`);
    }
    if (res.output_parsed == null) throw new ModelOutputError('malformed', 'response did not satisfy the schema');
    return {
      output: res.output_parsed as z.infer<T>,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      servedByModel: res.model,
    };
  }
}
