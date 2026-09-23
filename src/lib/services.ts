import { getDb } from '@/lib/db';
import { env, type Env } from '@/lib/config/env';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { ModelDrafter, ModelExtractor, type Effort, type StructuredClient } from '@/lib/ai/model-client';
import { AnthropicClient } from '@/lib/ai/anthropic';
import { OpenAiClient } from '@/lib/ai/openai';
import { ResendProvider } from '@/lib/email/resend';
import { FIXTURE_OFFERS } from '@/lib/fixtures';

/**
 * Process-wide service wiring. Fixture mode: deterministic extractor/drafter, synthetic offers, no provider.
 * Live mode: whichever model provider EXTRACTION_PROVIDER names, and Resend (only when EMAIL_SEND_ENABLED=true
 * and a key exists).
 */
const g = globalThis as unknown as { __tgConcierge?: Promise<Concierge> };

/** The provider is never inferred from which key happens to be set; EXTRACTION_PROVIDER decides. */
export function selectModelClient(e: Env): { client: StructuredClient; model: string; effort: Effort } | null {
  if (e.EXTRACTION_PROVIDER === 'anthropic' && e.ANTHROPIC_API_KEY) {
    return { client: new AnthropicClient(e.ANTHROPIC_API_KEY), model: e.ANTHROPIC_BASE_MODEL, effort: e.ANTHROPIC_BASE_EFFORT };
  }
  if (e.EXTRACTION_PROVIDER === 'openai' && e.OPENAI_API_KEY) {
    return { client: new OpenAiClient(e.OPENAI_API_KEY), model: e.OPENAI_BASE_MODEL, effort: e.OPENAI_BASE_EFFORT };
  }
  return null;
}

export function getConcierge(): Promise<Concierge> {
  if (!g.__tgConcierge) {
    g.__tgConcierge = (async () => {
      const e = env();
      const { db } = await getDb();
      const fixture = e.APP_MODE === 'fixture';
      // Provider is explicit: a production-like env with EXTRACTION_PROVIDER set to a model provider requires
      // that provider's key (env validation), so the deterministic extractor is only ever reached in fixture
      // mode or by deliberately setting EXTRACTION_PROVIDER=rules.
      const selected = fixture ? null : selectModelClient(e);
      if (!fixture && !selected) console.warn(`[services] extraction/drafting running in rules mode (EXTRACTION_PROVIDER=${e.EXTRACTION_PROVIDER})`);
      return new Concierge({
        db,
        env: e,
        extractor: selected ? new ModelExtractor(selected.client, selected.model, selected.effort) : new FixtureExtractor(),
        drafter: selected ? new ModelDrafter(selected.client, selected.model, selected.effort) : new FixtureDrafter(),
        emailProvider: e.EMAIL_SEND_ENABLED && e.RESEND_API_KEY ? new ResendProvider(e.RESEND_API_KEY) : null,
        fixtureOffers: fixture ? FIXTURE_OFFERS : {},
      });
    })();
  }
  return g.__tgConcierge;
}
