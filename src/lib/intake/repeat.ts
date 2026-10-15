/**
 * The same reply twice in a thread (live Oct 15, Rangers: "yes what other games can I see for that price? total yes."
 * got the previous email back word for word). A repeat is the same pick in the same words: the same prices and links,
 * and nearly the same text. A reply that only moved a price, or named another listing, is an update, not a repeat.
 */

/** The answer part of an email: no greeting, no signature, no review notice. */
export function answerBody(text: string): string {
  return text
    .replace(/^\s*(?:hey|hi|hello)[^\n]*\n+/i, '')
    .replace(/\n+Ticket Guy\n[\s\S]*$/, '')
    .replace(/\n+(?:—|-)?\s*Ticket Guy\s*$/, '')
    .trim();
}

const shingles = (s: string): Set<string> => {
  const w = s.toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(w.slice(i, i + 3).join(' '));
  if (!out.size && w.length) out.add(w.join(' '));
  return out;
};

export function similarity(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const s of x) if (y.has(s)) n++;
  return n / (x.size + y.size - n);
}

const prices = (s: string) => [...new Set(s.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? [])].sort().join('|');
const links = (s: string) => [...new Set(s.match(/https?:\/\/\S+/g) ?? [])].sort().join('|');

/** True when `next` would tell the customer what `previous` already did: same prices, same links, ≥90% the same words. */
export function sameReply(previous: string, next: string): boolean {
  const a = answerBody(previous);
  const b = answerBody(next);
  if (!a || !b) return false;
  return prices(a) === prices(b) && links(a) === links(b) && similarity(a, b) >= 0.9;
}
