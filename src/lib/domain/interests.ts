import type { RequestExtraction } from './types';

/**
 * Evidence-backed interest observations (ENGINEERING_SPEC §9, A28/A29). Marketing permission is a
 * separate record; nothing here grants it. Gift requests and negations never create positive self tags.
 */
export type InterestObservationDraft = {
  tagKey: string;
  kind: 'artist' | 'team' | 'category' | 'requested-market' | 'quantity' | 'request-budget-total-usd';
  polarity: 'positive' | 'negative' | 'uncertain';
  explicit: boolean;
  confidence: number; // 0–100
  forSelf: boolean | null;
  allowedForMarketing: boolean;
};

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function budgetBand(totalCents: number): string {
  const d = totalCents / 100;
  if (d < 100) return '0-99';
  if (d < 200) return '100-199';
  if (d < 400) return '200-399';
  if (d < 800) return '400-799';
  if (d < 1500) return '800-1499';
  return '1500+';
}

export function deriveInterestObservations(x: RequestExtraction, opts: { category: string | null; entityKind: 'artist' | 'team' | null; wholePartyBudgetCents: number | null }): InterestObservationDraft[] {
  const out: InterestObservationDraft[] = [];
  const forSelf = x.forSelf; // null unknown; false = gift
  const selfConfidence = forSelf === false ? 25 : forSelf === true ? 70 : 55;
  const negated = new Set(x.negatedEntities.map(slugify));

  if (x.performerOrTeam && opts.entityKind) {
    const slug = slugify(x.performerOrTeam);
    const isNegated = negated.has(slug);
    out.push({
      tagKey: `${opts.entityKind}:${slug}`,
      kind: opts.entityKind,
      polarity: isNegated ? 'negative' : forSelf === false ? 'uncertain' : 'positive',
      explicit: false,
      confidence: isNegated ? 80 : selfConfidence,
      forSelf,
      allowedForMarketing: true,
    });
  }
  for (const n of x.negatedEntities) {
    const slug = slugify(n);
    if (x.performerOrTeam && slugify(x.performerOrTeam) === slug) continue;
    out.push({ tagKey: `${opts.entityKind ?? 'artist'}:${slug}`, kind: opts.entityKind ?? 'artist', polarity: 'negative', explicit: true, confidence: 80, forSelf, allowedForMarketing: true });
  }
  if (opts.category) {
    out.push({ tagKey: `category:${slugify(opts.category)}`, kind: 'category', polarity: forSelf === false ? 'uncertain' : 'positive', explicit: false, confidence: Math.min(selfConfidence, 60), forSelf, allowedForMarketing: true });
  }
  if (x.city) {
    // Requested city is not residence; request attribute only.
    out.push({ tagKey: `requested-market:${slugify(x.city)}`, kind: 'requested-market', polarity: 'positive', explicit: false, confidence: 50, forSelf, allowedForMarketing: true });
  }
  if (x.quantity) out.push({ tagKey: `quantity:${x.quantity}`, kind: 'quantity', polarity: 'positive', explicit: false, confidence: 40, forSelf, allowedForMarketing: false });
  if (opts.wholePartyBudgetCents !== null) out.push({ tagKey: `request-budget-total-usd:${budgetBand(opts.wholePartyBudgetCents)}`, kind: 'request-budget-total-usd', polarity: 'positive', explicit: false, confidence: 40, forSelf, allowedForMarketing: false });
  return out;
}

/** Aggregation with 180-day half-life decay and 365-day expiry (configurable heuristic, not a model). */
export const INTEREST_HALF_LIFE_DAYS = 180;
export const INTEREST_EXPIRY_DAYS = 365;

export function aggregateInterest(observations: Array<{ polarity: 'positive' | 'negative' | 'uncertain'; confidence: number; observedAt: Date; explicit: boolean }>, userOverride: 'positive' | 'negative' | null, now: Date): { aggregateConfidence: number; status: 'provisional' | 'confirmed' | 'suppressed' | 'expired'; confirmed: boolean } {
  if (userOverride === 'negative') return { aggregateConfidence: 0, status: 'suppressed', confirmed: false };
  if (userOverride === 'positive') return { aggregateConfidence: 100, status: 'confirmed', confirmed: true };
  let score = 0;
  let anyRecent = false;
  let explicitPositive = false;
  let negative = false;
  for (const o of observations) {
    const ageDays = (now.getTime() - o.observedAt.getTime()) / 86_400_000;
    if (ageDays > INTEREST_EXPIRY_DAYS) continue;
    anyRecent = true;
    const decayed = o.confidence * Math.pow(0.5, ageDays / INTEREST_HALF_LIFE_DAYS);
    if (o.polarity === 'positive') {
      score += decayed;
      if (o.explicit) explicitPositive = true;
    } else if (o.polarity === 'negative') {
      score -= decayed;
      if (o.explicit) negative = true;
    }
  }
  if (!anyRecent) return { aggregateConfidence: 0, status: 'expired', confirmed: false };
  if (negative || score <= 0) return { aggregateConfidence: 0, status: 'suppressed', confirmed: false };
  const agg = Math.min(100, Math.round(score));
  return { aggregateConfidence: agg, status: explicitPositive ? 'confirmed' : 'provisional', confirmed: explicitPositive };
}
