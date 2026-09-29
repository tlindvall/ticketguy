/**
 * Replies that tell us how it ended: they bought, they didn't, stop watching, and whether our advice changed
 * what or when they bought (the one follow-up question). Read from their words only; anything unclear is left
 * unknown rather than guessed, and a reply that is really a new question is not taken as an outcome.
 */
export type OutcomeReply = {
  bought: boolean | null;
  stopWatching: boolean;
  /** From a follow-up answer: did the advice change which tickets, or when they bought? null when not said. */
  changedWhat: boolean | null;
  changedWhen: boolean | null;
};

const NEGATED_BUY = /\b(didn'?t|did not|haven'?t|have not|never|decided not to|not going to|won'?t)\s+(?:end up\s+)?(buy|get|go|purchase)\b|\bpassed on (them|it)\b|\bno tickets\b/i;
// "Got" counts only with the tickets as its object: "I got your email" is not a purchase.
const BOUGHT = /\b(i|we)\s+(?:just\s+|finally\s+|already\s+|ended up\s+)?(bought|purchased|grabbed|booked)\b|\b(bought|got|purchased|grabbed|picked up) (them|the tickets|tickets|the seats|seats|our tickets|my tickets|the pair|both)\b/i;
const STOP = /\b(stop|quit)\s+(watching|tracking|checking|looking|monitoring)\b|\bno longer need\b|\bdon'?t need (them|it|tickets|the tickets) any ?more\b|\byou can stop\b/i;

export function classifyOutcomeReply(text: string): OutcomeReply | null {
  const t = text.replace(/[’‘]/g, "'").trim(); // "didn’t" is "didn't"
  if (!t) return null;
  const negated = NEGATED_BUY.test(t);
  const bought = negated ? false : BOUGHT.test(t) ? true : null;
  const stopWatching = STOP.test(t) || bought === true;
  const changedWhen = /\b(waited|held off|bought (it |them )?(later|earlier|sooner)|waiting paid off|bought (it |them )?(right away|straight away|immediately) because)\b/i.test(t) ? true : null;
  const changedWhat = /\b(different (seats|section|seller|site|tickets)|went with (the one|your|the option|the seats)|the ones you (suggested|found|recommended)|switched to|instead of the)\b/i.test(t) ? true : null;
  const noChange = /\b(didn'?t change|no difference|bought (them |it )?anyway|already bought|wouldn'?t have changed|made no difference)\b/i.test(t);
  if (bought === null && !stopWatching && changedWhen === null && changedWhat === null && !noChange) return null;
  return { bought, stopWatching, changedWhat: noChange ? false : changedWhat, changedWhen: noChange ? false : changedWhen };
}
