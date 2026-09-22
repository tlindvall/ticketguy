import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { AnthropicClient, AnthropicDrafter, AnthropicExtractor } from '@/lib/ai/anthropic';
import { ResendProvider } from '@/lib/email/resend';
import { FIXTURE_OFFERS } from '@/lib/fixtures';

/**
 * Process-wide service wiring. Fixture mode: deterministic extractor/drafter, synthetic offers, no provider.
 * Live mode: the Anthropic Messages API (when configured) and Resend (only when EMAIL_SEND_ENABLED=true and a key exists).
 */
const g = globalThis as unknown as { __tgConcierge?: Promise<Concierge> };

export function getConcierge(): Promise<Concierge> {
  if (!g.__tgConcierge) {
    g.__tgConcierge = (async () => {
      const e = env();
      const { db } = await getDb();
      const fixture = e.APP_MODE === 'fixture';
      // Provider is explicit: EXTRACTION_PROVIDER=openai in a production-like env requires a key (env validation),
      // so the deterministic extractor is only ever reached in fixture mode or by deliberate configuration.
      const useModel = !fixture && e.EXTRACTION_PROVIDER === 'anthropic' && !!e.ANTHROPIC_API_KEY;
      const anthropic = useModel ? new AnthropicClient(e.ANTHROPIC_API_KEY!, e.ANTHROPIC_BASE_MODEL, e.ANTHROPIC_BASE_MODEL) : null;
      if (!fixture && !anthropic) console.warn(`[services] extraction/drafting running in rules mode (EXTRACTION_PROVIDER=${e.EXTRACTION_PROVIDER}, key ${e.ANTHROPIC_API_KEY ? 'present' : 'absent'})`);
      return new Concierge({
        db,
        env: e,
        extractor: anthropic ? new AnthropicExtractor(anthropic, e.ANTHROPIC_BASE_MODEL, e.ANTHROPIC_BASE_EFFORT) : new FixtureExtractor(),
        drafter: anthropic ? new AnthropicDrafter(anthropic, e.ANTHROPIC_BASE_MODEL, e.ANTHROPIC_BASE_EFFORT) : new FixtureDrafter(),
        emailProvider: e.EMAIL_SEND_ENABLED && e.RESEND_API_KEY ? new ResendProvider(e.RESEND_API_KEY) : null,
        fixtureOffers: fixture ? FIXTURE_OFFERS : {},
      });
    })();
  }
  return g.__tgConcierge;
}
