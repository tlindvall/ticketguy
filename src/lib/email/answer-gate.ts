import { z } from 'zod';
import type { Effort, StructuredClient, Usage } from '@/lib/ai/model-client';

/**
 * The last check before a reply reaches a customer (fix plan, Phase 0, Oct 16). Three of four live threads on the evening
 * of Oct 15 answered a different question from the one asked, and two sent an internal line ("I haven't been able to check
 * this against any seats yet", "Got it.", a feed name in capitals). A reply that fails here is not sent: a person gets it,
 * with the customer's message, and sends it, edits it or writes their own.
 *
 * Two parts: lines we never send (deterministic, every customer email), and a model's yes/no on whether the reply answers
 * the customer's latest message and gives them a next step (replies that answer a message, where a model is wired).
 */

/** Internal lines that reached customers (live Oct 15): never sent, whatever produced them. */
const BANNED: Array<{ code: string; test: RegExp }> = [
  { code: 'banned_cannot_check', test: /haven[’']t been able to check/i },
  { code: 'banned_nothing_automatic', test: /nothing i can check automatically/i },
  // "Rangers tickets for Monday, October 19. Got it." played the request back instead of answering it.
  { code: 'banned_got_it', test: /\bgot it[.,!]/i },
];

/**
 * A ticket feed's name in capitals ("CBJ V. NEW YORK RANGERS"): three or more capitalised words in a row, one of them four
 * letters or longer. Short codes on their own ("GA", "VIP", "NYC") and a single shouted word ("CONFIRM") pass.
 */
const CAPS_RUN = /(?<![A-Za-z])(?:[A-Z][A-Z.&'’]*\s+){2,}[A-Z][A-Z.&'’]*(?![a-z])/g;

export function feedNameInCaps(text: string): string | null {
  for (const m of text.matchAll(CAPS_RUN)) {
    const words = m[0].trim().split(/\s+/);
    if (words.some((w) => w.replace(/[^A-Z]/g, '').length >= 4)) return m[0].trim();
  }
  return null;
}

/** The lines this reply must not send. `ignore` is text we add ourselves that may legitimately be in capitals (the postal address). */
export function bannedLines(text: string, ignore: string[] = []): string[] {
  let body = text;
  for (const s of ignore) if (s) body = body.split(s).join(' ');
  const found = BANNED.filter((b) => b.test.test(body)).map((b) => b.code);
  if (feedNameInCaps(body)) found.push('banned_caps_feed_name');
  return found;
}

export type AnswerVerdict = { answers: boolean; nextStep: boolean; problem: string };

/** Whether a reply answers the customer's latest message. Implementations throw on any failure; the caller holds the reply. */
export interface AnswerJudge {
  readonly name: string;
  lastUsage: Usage | null;
  judge(input: { latest: string; reply: string }): Promise<AnswerVerdict>;
}

const VERDICT_SCHEMA = z.object({
  answers: z.boolean(),
  nextStep: z.boolean(),
  problem: z.string(),
});

export const ANSWER_GATE_INSTRUCTIONS = `You check a ticket concierge's email to a customer before it is sent. You get the customer's latest message and the reply.

answers: true when the reply responds to what the latest message asks or says. It gives the answer, or, when it can't yet, says plainly why and what happens next. False when the reply answers a different question, ignores part of a question (a budget, an opponent, home games only, a date), only restates the request back, or asks for something the customer already gave. A reply that asks for the one thing still missing to answer (how many tickets, which date) counts as answering, unless the customer asked a question it could have answered first. When the latest message asks nothing ("thanks", "ok"), true.

nextStep: true when the reply gives the customer something to act on or expect: a link, a pick, a question, or when they will hear back.

problem: one short sentence naming what is wrong, in plain words, for the person who will fix it. Empty when both are true.

Judge only against the latest message, read with the reply. Don't judge tone, length or style, and don't fail a reply for facts you can't check.`;

export const ANSWER_GATE_MAX_OUTPUT_TOKENS = 1500;

export class ModelAnswerJudge implements AnswerJudge {
  readonly name: string;
  lastUsage: Usage | null = null;
  constructor(
    private readonly client: StructuredClient,
    private readonly model: string,
    private readonly effort: Effort = 'low',
  ) {
    this.name = client.provider;
  }
  async judge(input: { latest: string; reply: string }): Promise<AnswerVerdict> {
    const text = `<untrusted_customer_message>\n${input.latest.slice(0, 4000)}\n</untrusted_customer_message>\n<reply_to_check>\n${input.reply.slice(0, 8000)}\n</reply_to_check>`;
    const { output, usage } = await this.client.parseStructured({ model: this.model, instructions: ANSWER_GATE_INSTRUCTIONS, input: text, schema: VERDICT_SCHEMA, schemaName: 'answer_gate', maxOutputTokens: ANSWER_GATE_MAX_OUTPUT_TOKENS, effort: this.effort });
    this.lastUsage = usage;
    return VERDICT_SCHEMA.parse(output);
  }
}

/** Why a reply was held, as staff read it. */
export function heldReasonText(codes: string[], problem: string | null): string {
  const words: Record<string, string> = {
    banned_cannot_check: 'it says we haven’t been able to check',
    banned_nothing_automatic: 'it says nothing can be checked automatically',
    banned_got_it: 'it opens with “Got it” instead of an answer',
    banned_caps_feed_name: 'it prints a ticket feed’s name in capitals',
    not_answered: 'it doesn’t answer the customer’s message',
    no_next_step: 'it gives the customer no next step',
    check_failed: 'the answer check could not run',
  };
  const parts = codes.map((c) => words[c] ?? c);
  return `${parts.join('; ')}${problem ? `. ${problem}` : ''}`;
}
