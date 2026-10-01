import { flat } from './text-offers';

/** Supplied conditions, separate from prices. Null means omitted, not an assertion that the offer works. */
export type OfferEligibility = {
  availability?: 'available' | 'unavailable' | null;
  validDays?: string[] | null;
  invalidDays?: string[] | null;
  transferRestriction?: string | null;
  transferStated?: boolean;
  collectionRestriction?: string | null;
  collectionStated?: boolean;
};
const DAYS = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';

export function eligibilityIn(text: string): OfferEligibility {
  const t = flat(text).replace(/https?:\/\/\S+/g, '');
  const reopened = /\b(?:no longer|not) sold[- ]out\b|\bwas sold[- ]out[,;]? (?:but )?(?:is )?now available\b/i.test(t);
  const unavailable = !reopened && /\b(?:sold[- ]out|not (?:currently )?(?:purchasable|available)|unavailable|no longer available)\b/i.test(t);
  const available = /\b(?:marked |now )?available\b|\bback in stock\b/i.test(t);
  const day = new RegExp(`\\b(${DAYS})[- ]only\\b|\\b(?:valid|admission|entry) (?:only )?(?:on|for) (${DAYS}) only\\b`, 'i').exec(t);
  const nontransferable = /\bnon[- ]?transferable\b|\b(?:cannot|can't|may not) (?:be )?transfer(?:red)?\b/i.test(t);
  const originalId = /\boriginal purchaser\b[^.;]{0,60}\b(?:ID|identification)\b/i.test(t);
  const impossibleCollection = originalId && /\b(?:we|I) (?:are|am) not (?:the )?original purchasers?\b|\bseller (?:is not|isn't) attending\b/i.test(t);
  const transferable = !nontransferable && /\b(?:official )?transferable (?:tickets?|admission)|\bofficial transfer (?:is )?(?:allowed|permitted)\b/i.test(t);
  const invalidDays = [...t.matchAll(new RegExp(`\\b(?:not valid|no (?:admission|entry)) (?:on |for )?(${DAYS})\\b`, 'gi'))].map((m) => m[1]!.toLowerCase());
  const collectionReleased = /\bno original purchaser (?:ID|identification) (?:is )?required\b/i.test(t);
  return {
    availability: reopened ? 'available' : unavailable ? 'unavailable' : available ? 'available' : null,
    validDays: day ? [(day[1] ?? day[2])!.toLowerCase()] : null,
    invalidDays: invalidDays.length ? invalidDays : null,
    transferRestriction: nontransferable ? 'the tickets are nontransferable under the supplied terms; this resale plan does not establish usable admission' : null,
    transferStated: nontransferable || transferable,
    collectionRestriction: impossibleCollection && !collectionReleased ? 'collection requires the original purchaser’s ID; your resale plan cannot meet those supplied terms' : null,
    collectionStated: impossibleCollection || collectionReleased,
  };
}

export function requestedDay(messages: string[]): string | null {
  let day: string | null = null;
  for (const raw of messages) {
    // The customer's requested day, never the cheaper offer's valid day.
    const t = flat(raw).split(/\b(?:Offer|Option|Listing) [A-Z]\b/)[0]!;
    const m = new RegExp(`\\b(?:only want|need|want|can only attend|only attending) (?:on )?(${DAYS})\\b`, 'i').exec(t);
    if (m) day = m[1]!.toLowerCase();
  }
  return day;
}

/** A positive view requirement must be the customer's words, not merely B's description. */
export function requiredView(messages: string[]): 'unobstructed' | 'any' | null {
  let view: 'unobstructed' | 'any' | null = null;
  for (const raw of messages) {
    const own = flat(raw).split(/\b(?:Offer|Option|Listing) [A-Z]\b/)[0]!;
    if (/\b(?:restricted|obstructed|partial|limited) views? (?:are|is) (?:now )?(?:fine|acceptable|okay|ok)\b/i.test(own)) view = 'any';
    else if (/\b(?:need|want|require|must have)\b[^.;]{0,70}\b(?:unobstructed|clear|full) (?:stage )?view\b|\bfull view is mandatory\b/i.test(own)) view = 'unobstructed';
  }
  return view;
}

export function obstructedView(text: string): boolean | null {
  const t = flat(text).replace(/https?:\/\/\S+/g, '');
  if (/\bnot (?:an? )?(?:unobstructed|clear|full) (?:stage )?view\b/i.test(t)) return true;
  // A positive guarantee of a full view never overrides an explicit obstruction in the same supplied offer.
  if (/\bobstructed\b|\b(?:limited|partial|restricted)[- ]view\b|\bview (?:is )?(?:obstructed|limited)\b/i.test(t.replace(/\b(?:not|no|without) (?:an? |any )?(?:obstructed|limited|partial|restricted)(?:[- ]views?)?\b/gi, ''))) return true;
  return /\bunobstructed\b|\b(?:clear|full) (?:stage )?view\b|\bnot obstructed\b|\bno (?:obstructed|restricted) view\b/i.test(t) ? false : null;
}
