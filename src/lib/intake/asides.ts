import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Mid-request messages that aren't about the tickets (#136): a closing "Perfect, thanks — all set!" and a side question
 * about getting to the venue. Each gets a short answer of its own, and the request it interrupted keeps its brief,
 * revision and state: no new research and no recommendation sent again.
 */

const CLOSING_WORDS = /^(?:(?:hi|hey|ok(?:ay)?|great|perfect|awesome|cool|amazing|brilliant|excellent|nice|lovely|sweet|super|fantastic|wonderful|sounds (?:good|great|perfect)|got it|will do|noted|understood|appreciate (?:it|that|this|the help)|much appreciated|cheers|many thanks|thanks?(?: you)?(?: (?:so|very) much| a (?:lot|ton|bunch)| again| for (?:the|your|all (?:the|your)) (?:help|info|information|reply|answer|options?|advice|tips?|work))?|thx|ty|tysm|all (?:set|good|done|sorted)|(?:we|i)(?:'?re| are|'?m| am) (?:all )?(?:set|good|sorted|done)|that(?:'?s| is| was) (?:all|it|perfect|great|helpful|everything)|that (?:helps|works|helped)|this (?:helps|is (?:great|perfect|helpful))|you(?:'?re| are) (?:the best|a star|great))[\s,.!—–~:)(-]*)+$/i;

/** "Perfect, thanks — all set!": thanks or a sign-off and nothing else (no question, no new detail). A sign-off name is fine. */
export function closingOnly(text: string): boolean {
  const lines = text.replace(/[’‘]/g, "'").split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length || /\?/.test(text) || /\d/.test(lines[0]!)) return false;
  // A short last line without digits is a sign-off ("Tobias", "- T"), not part of what they said.
  const body = lines.length > 1 && lines.at(-1)!.split(/\s+/).length <= 3 && !/\d/.test(lines.at(-1)!) && !CLOSING_WORDS.test(lines.at(-1)!) ? lines.slice(0, -1) : lines;
  const said = body.join(' ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  return said.length > 0 && said.length <= 120 && CLOSING_WORDS.test(said);
}

/** "Is MSG easy to get to from Penn Station?", "how do we get to the arena?": directions or transit, not tickets. */
export function gettingThereAsked(text: string): boolean {
  const t = text.replace(/[’‘]/g, "'");
  if (/\bparking\b/i.test(t)) return false; // a parking pass is a ticket question, answered on its own route
  const directions = /\b(?:easy|hard|quick|best way|how (?:do|can|would|should) (?:i|we|you)|how to|fastest way)\b[^.?!]{0,30}\b(?:get(?:ting)? (?:to|there)|reach|travel to|walk (?:to|from))\b|\b(?:directions|subway|train|metro|bus|lirr|nj transit|uber|lyft|taxi|walk(?:ing)?)\b[^.?!]{0,40}\b(?:to|from) (?:the )?(?:arena|stadium|venue|garden|msg|theat(?:er|re)|station|it)\b|\bfrom (?:penn station|grand central|the station|the airport|my hotel|our hotel)\b/i;
  if (!directions.test(t)) return false;
  // "Need 2 tickets, and how do we get there?" still asks for tickets.
  return !/\b(?:need|want|looking for|find|get me|book)\b[^.?!]{0,30}\b(?:tickets?|seats?|tix)\b/i.test(t);
}

export const GETTING_THERE_LINE = 'Directions are outside what I check: I only help with tickets, so the venue’s own “getting here” page or a maps app is the reliable answer for the best route.';

/**
 * Where a venue sits against the transit it's known for: fixed facts about the building, nothing that changes by the
 * day. "Is MSG easy to get to from Penn Station?" was answered with a pointer elsewhere when the one fact that answers
 * it is that the Garden sits on top of the station (#158). Only venues whose station is part of the venue's identity.
 */
const VENUE_TRANSIT: Array<{ venue: RegExp; fact: string }> = [
  { venue: /\bmadison square garden\b/i, fact: 'Madison Square Garden is built directly on top of Penn Station, so from the trains it’s a short walk up to the Garden’s entrances.' },
  { venue: /\bbarclays cent(?:er|re)\b/i, fact: 'Barclays Center sits right on top of the Atlantic Avenue subway station (2, 3, 4, 5, B, D, N, Q and R trains), next to the LIRR’s Atlantic Terminal.' },
  { venue: /\byankee stadium\b/i, fact: 'Yankee Stadium is across the street from the 161 St-Yankee Stadium subway station (4, B and D trains).' },
  { venue: /\bciti field\b/i, fact: 'Citi Field is next to the Mets-Willets Point station, on the 7 train and the LIRR’s Port Washington line.' },
  { venue: /\bcrypto\.com arena\b/i, fact: 'Crypto.com Arena is a short walk from Pico station on the Metro A and E lines.' },
];

/** The answer to a getting-there question: the venue's transit fact when we hold one, then where the route itself is. */
export function gettingThereLine(venueName: string | null): string {
  const known = venueName ? VENUE_TRANSIT.find((v) => v.venue.test(venueName)) : undefined;
  return known ? `${known.fact} For the best route from where you are, a maps app or the venue’s own “getting here” page is the reliable answer.` : GETTING_THERE_LINE;
}
export const CLOSING_LINE = 'Glad that helps. Just reply here if you want me to look at anything else.';

/** The message changes nothing about the request: no new event, count, date, budget, price, link or listing. */
export function bringsNothingNew(x: RequestExtraction, prior: RequestExtraction, listingSent: boolean): boolean {
  const changed = <K extends keyof RequestExtraction>(k: K) => x[k] != null && x[k] !== prior[k];
  return !listingSent && !x.submittedUrls.length && x.quotedPriceCents == null && !changed('quantity') && !changed('dateExpression') && !changed('resolvedLocalDate') && !changed('budgetCents') && !changed('seatingPreference') && !(x.performerOrTeam && prior.performerOrTeam && x.performerOrTeam.toLowerCase() !== prior.performerOrTeam.toLowerCase()) && !(x.performerOrTeam && !prior.performerOrTeam) && !(x.eventName && !prior.eventName);
}
