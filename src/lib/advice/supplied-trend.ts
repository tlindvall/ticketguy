import { ALL_IN, flat, partyTerms } from './text-offers';

const NUMBERS: Record<string, number> = { single: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT = '(single|one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,2})';
type Snapshot = { quantity: number | null; zone: string | null; fees: 'all_in' | 'before_fees' | null; totalCents: number | null };

function snapshot(text: string): Snapshot {
  const q = new RegExp(`\\b${COUNT}\\s+(?:[a-z-]+\\s+){0,3}seats?\\b`, 'i').exec(text)?.[1];
  const quantity = q ? NUMBERS[q.toLowerCase()] ?? Number(q) : null;
  const zone = /\b(upper|lower)[- ]level\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
  const fees = /\bbefore fees\b/i.test(text) ? 'before_fees' : ALL_IN.test(text) ? 'all_in' : null;
  const price = /\$(\d[\d,]*(?:\.\d{2})?)\s*(each|per (?:seat|ticket)|total|for (?:all|both))?\b/i.exec(text);
  const cents = price ? Math.round(Number(price[1]!.replace(/,/g, '')) * 100) : null;
  const totalCents = cents !== null && (price?.[2] && /total|for/i.test(price[2]) || quantity === 1) ? cents
    : cents !== null && quantity !== null && /each|per/i.test(price?.[2] ?? '') ? cents * quantity : null;
  return { quantity, zone, fees, totalCents };
}

/** A supplied pair of mismatched baskets is not a market time series. Comparable quotes stay on the market-data path. */
export function suppliedTrendQuestion(messages: string[]): { lead: string; items: string[] } | null {
  const latest = flat(messages.at(-1) ?? '');
  if (!/\b(?:trend|comparable history|prove prices|data points|buy or wait)\b/i.test(latest)) return null;
  const observations = messages.flatMap((raw) => [...flat(raw).matchAll(/\b(?:Yesterday|Today)\b((?:[^.!?]|\.(?=\d))+)/gi)].map((m) => snapshot(m[1]!))).filter((s) => s.quantity !== null && s.totalCents !== null);
  if (observations.length < 2) return null;
  const first = observations[0]!;
  const current = observations.at(-1)!;
  const different = first.quantity !== null && current.quantity !== null && first.quantity !== current.quantity
    || first.zone !== null && current.zone !== null && first.zone !== current.zone
    || first.fees !== null && current.fees !== null && first.fees !== current.fees;
  if (!different) return null;
  const party = partyTerms(messages);
  const cap = [...messages].reverse().map((m) => /\bbudget \$(\d[\d,]*(?:\.\d{2})?) TOTAL\b/i.exec(flat(m))).find((m) => m !== null);
  const budget = cap ? Math.round(Number(cap[1]!.replace(/,/g, '')) * 100) : null;
  const usd = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: c % 100 ? 2 : 0 }).format(c / 100);
  return {
    lead: 'Those two prices cannot establish a trend or justify a buy-now or hold-off recommendation.',
    items: [
      'Your observations use different seat quantities, seating zones or fee bases. That price difference does not show that comparable tickets became more expensive.',
      ...(current.totalCents === null ? [] : [`Your latest supplied quote adds up to ${usd(current.totalCents)}${current.fees === 'all_in' ? ', fees included' : '; final fees are not established'}${budget !== null && current.fees === 'all_in' && budget >= current.totalCents ? `, leaving ${usd(budget - current.totalCents)} of your ${usd(budget)} budget` : ''}. That is arithmetic from your quote, not checked inventory or historical value.`]),
      `For your group, I’d need dated observations for the same event and performance date, the same seating zone and restrictions, ${party.attendees ?? current.quantity ?? 'your required number of'} ${party.seating === 'together' ? 'adjacent ' : ''}seats, and the same fee-inclusive total. Check stock and freshness at each observation; a vanished listing does not prove a sale.`,
      'I haven’t verified comparable price history here. Send the exact event or listing and I can check what evidence is available; I won’t fill missing history with guesses or make a price prediction.',
    ],
  };
}
