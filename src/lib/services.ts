import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { OpenAIClient, OpenAIDrafter, OpenAIExtractor } from '@/lib/ai/openai';
import { ResendProvider } from '@/lib/email/resend';
import { FIXTURE_OFFERS } from '@/lib/fixtures';

/**
 * Process-wide service wiring. Fixture mode: deterministic extractor/drafter, synthetic offers, no provider.
 * Live mode: OpenAI (when configured) and Resend (only when EMAIL_SEND_ENABLED=true and a key exists).
 */
const g = globalThis as unknown as { __tgConcierge?: Promise<Concierge> };

export function getConcierge(): Promise<Concierge> {
  if (!g.__tgConcierge) {
    g.__tgConcierge = (async () => {
      const e = env();
      const { db } = await getDb();
      const fixture = e.APP_MODE === 'fixture';
      const openai = !fixture && e.OPENAI_API_KEY ? new OpenAIClient(e.OPENAI_API_KEY, e.OPENAI_BASE_MODEL, e.OPENAI_ESCALATION_MODEL) : null;
      return new Concierge({
        db,
        env: e,
        extractor: openai ? new OpenAIExtractor(openai, e.OPENAI_BASE_MODEL) : new FixtureExtractor(),
        drafter: openai ? new OpenAIDrafter(openai, e.OPENAI_BASE_MODEL) : new FixtureDrafter(),
        emailProvider: e.EMAIL_SEND_ENABLED && e.RESEND_API_KEY ? new ResendProvider(e.RESEND_API_KEY) : null,
        fixtureOffers: fixture ? FIXTURE_OFFERS : {},
      });
    })();
  }
  return g.__tgConcierge;
}
