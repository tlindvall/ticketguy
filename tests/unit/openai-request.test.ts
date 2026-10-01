import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenAiClient } from '@/lib/ai/openai';
import { parseEnv } from '@/lib/config/env';
import { selectModelClient } from '@/lib/services';

/**
 * What we send to OpenAI, checked against the GPT-6 migration guide: model gpt-6.1-sol, an explicit effort it
 * accepts (low through max; never none or minimal), Responses API with Structured Outputs, no sampling
 * parameters (temperature, top_p, top_logprobs are unsupported with reasoning), and nothing stored server-side.
 */
describe('OpenAI request shape (GPT-6.1 Sol)', () => {
  const captured: Array<Record<string, unknown>> = [];
  const client = new OpenAiClient('sk-test');
  // The SDK call is replaced; everything the app builds before it is real.
  (client.client.responses as unknown as { parse: (b: Record<string, unknown>) => Promise<unknown> }).parse = async (body) => {
    captured.push(body);
    return { status: 'completed', output: [], output_parsed: { ok: true }, usage: { input_tokens: 10, output_tokens: 5 }, model: body.model };
  };

  it('the production default is gpt-6.1-sol at low effort, through the Responses API', async () => {
    const e = parseEnv({ NODE_ENV: 'test', APP_MODE: 'fixture', EXTRACTION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
    expect(e.OPENAI_BASE_MODEL).toBe('gpt-6.1-sol');
    expect(e.OPENAI_BASE_EFFORT).toBe('low');
    const selected = selectModelClient(e)!;
    expect(selected).toMatchObject({ model: 'gpt-6.1-sol', effort: 'low' });
    expect(selected.client.provider).toBe('openai');
  });

  it('sends the model, an explicit effort, a strict schema, store:false and no sampling parameters', async () => {
    const r = await client.parseStructured({ model: 'gpt-6.1-sol', instructions: 'x', input: 'y', schema: z.object({ ok: z.boolean() }), schemaName: 'probe', maxOutputTokens: 4000, effort: 'low' });
    expect(r.servedByModel).toBe('gpt-6.1-sol');
    const body = captured.at(-1)!;
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' }, max_output_tokens: 4000, store: false });
    expect((body.text as { format: { type: string; strict?: boolean } }).format).toMatchObject({ type: 'json_schema', strict: true });
    for (const k of ['temperature', 'top_p', 'top_logprobs', 'prompt_cache_retention', 'include']) expect(body).not.toHaveProperty(k);
  });

  it('only offers efforts GPT-6.1 Sol accepts', () => {
    for (const effort of ['none', 'minimal']) expect(() => parseEnv({ NODE_ENV: 'test', APP_MODE: 'fixture', OPENAI_BASE_EFFORT: effort })).toThrow();
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(parseEnv({ NODE_ENV: 'test', APP_MODE: 'fixture', OPENAI_BASE_EFFORT: effort }).OPENAI_BASE_EFFORT).toBe(effort);
  });
});
