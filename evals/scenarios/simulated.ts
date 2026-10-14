/**
 * Simulated customers. An AI customer with a persona, a goal and preferences it only reveals when asked (or when the
 * persona says so) writes each next email from what Ticket Guy actually replied, for up to 12 emails. It ends the
 * thread when it would stop emailing in real life, and says whether it got what it came for.
 */
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { wrapOpenAI } from 'braintrust';
import type { Scenario, Step, TurnOut } from '../harness';
import { AS_OF } from '../world';

type Persona = { id: string; now?: string; who: string; goal: string; hidden: string[]; style: string };
const PERSONAS: Persona[] = [
  { id: 'budget-dad', now: AS_OF.knicksWeek, who: 'A dad in Queens taking his two kids and his wife to a Knicks game this week.', goal: '4 seats together for the Knicks game on Wednesday (vs Celtics), as cheap as possible while sitting together.', hidden: ['Total budget is $900 for all four, fees included — only say so when asked about budget.', 'One kid is 8, so he does not want the top rows if there is a reasonable alternative.', 'He would switch to the Nets game at Barclays if it is clearly cheaper.'], style: 'Polite, a bit unsure about fees, writes full sentences, sometimes asks the same thing twice in different words.' },
  { id: 'impatient-texter', now: AS_OF.rangersWeek, who: 'A 24-year-old who texts in lowercase with typos and slang.', goal: '2 tickets to a Rangers home game this week, whichever is cheaper, and a link to buy.', hidden: ['Budget is about $300 total — only say if asked.', 'Gets annoyed by long emails and replies "which one??" if the answer is not clear.'], style: 'very short messages, lowercase, typos, slang ("tix", "rn", "lmk"), never more than one line.' },
  { id: 'la-visitor', now: AS_OF.laJanuary, who: 'Someone visiting Los Angeles with two friends the week of January 12.', goal: 'One fun sports event that week for 3 people, ideally lower level, total under $500.', hidden: ['Prefers basketball over hockey but is flexible.', 'Halfway through, asks whether parking is easy at the venue.', 'Accepts upper level if lower is far over budget.'], style: 'Friendly and chatty, asks follow-up questions, changes mind once.' },
  { id: 'price-watcher', now: AS_OF.dodgersWeek, who: 'A Dodgers fan who never buys at the first price.', goal: '2 tickets for the Dodgers game next Wednesday, but only if they get to about $100 each; wants to be alerted.', hidden: ['Asks whether prices usually drop closer to game day.', 'Will accept $115 each if told it is unlikely to go lower.'], style: 'Direct, numbers-focused, skeptical of claims.' },
  { id: 'date-night', who: 'Planning a theater date night in New York.', goal: '2 tickets to Hamilton on Saturday October 10, evening show preferred, max $500 total.', hidden: ['Balcony is fine if the view is not obstructed.', 'Would do the matinee only if the evening is over budget.'], style: 'Warm, a little indecisive, writes medium-length emails.' },
];

const Next = z.object({ done: z.boolean(), satisfied: z.boolean().nullable(), message: z.string().nullable(), reason: z.string() });

export function simulatedCustomers(key: string, model: string): Scenario[] {
  const client = wrapOpenAI(new OpenAI({ apiKey: key }));
  return PERSONAS.map((p) => {
    const verdict: { satisfied: boolean | null; reason: string } = { satisfied: null, reason: '' };
    const next = async (soFar: TurnOut[]): Promise<Step | null> => {
      const thread = soFar.map((tu) => `YOU: ${tu.customer}\nTICKET GUY:\n${tu.reply.slice(0, 2500) || '(no reply)'}`).join('\n\n');
      const res = await client.responses.parse({
        model, reasoning: { effort: 'low' }, store: false,
        instructions: `You are role-playing a real customer emailing Ticket Guy, an email ticket-buying assistant. Stay in character.
Who you are: ${p.who}
What you want: ${p.goal}
Things you only reveal when asked or when the moment comes: ${p.hidden.map((h) => `- ${h}`).join('\n')}
How you write: ${p.style}
This is a test environment: links on example.invalid stand in for real checkout links. Treat them as working links; never complain about them.
Write your next email to Ticket Guy, reacting to its last reply. Do not repeat information you already gave unless Ticket Guy asked again (then answer, slightly annoyed). Set done=true when a real customer would stop emailing: you have a clear recommendation with a price and link you'd buy, you've given up, or the thread is going nowhere. When done, set satisfied (did you get what you came for?) and give the reason.`,
        input: thread ? `The thread so far:\n\n${thread}\n\nWrite your next email (or finish).` : 'Write your first email to Ticket Guy.',
        text: { format: zodTextFormat(Next, 'next') },
      });
      const n = res.output_parsed!;
      if (n.done || !n.message || soFar.length >= 12) { verdict.satisfied = n.satisfied ?? false; verdict.reason = n.reason; return null; }
      return { text: n.message };
    };
    return { id: `sim/${p.id}`, capability: 'simulated', now: p.now, tags: ['sim'], steps: [], next, maxSteps: 13, meta: verdict } as Scenario & { meta: typeof verdict };
  });
}

/** The simulated customer's own verdict at the end of the thread. */
export const simGoal = ({ input }: { input: Scenario }) => {
  const m = (input as Scenario & { meta?: { satisfied: boolean | null; reason: string } }).meta;
  if (!m) return { name: 'sim_customer_satisfied', score: null };
  return { name: 'sim_customer_satisfied', score: m.satisfied == null ? 0 : m.satisfied ? 1 : 0, metadata: { reason: m.reason } };
};
