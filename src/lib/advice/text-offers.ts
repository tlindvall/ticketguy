/**
 * Offers a customer lays out in their own words ("Offer A says wheelchair-accessible spaces, $80 each including
 * fees. Offer B is ordinary seats together, section 211 row 12, $105 each including fees."). Each is kept apart
 * with what the text says about it and nothing more: these are their notes, not listings we've seen.
 */
export type TextOffer = {
  label: string;
  perTicketCents: number | null;
  totalCents: number | null;
  feeBasis: 'all_in' | 'before_fees' | 'unknown';
  accessible: boolean;
  together: boolean | null;
  section: string | null;
  row: string | null;
};

const money = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);

export function offersInText(text: string): TextOffer[] {
  const t = text.replace(/[’‘]/g, "'");
  const marks = [...t.matchAll(/\b(?:[Oo]ffer|[Oo]ption|[Ll]isting)\s+([A-Z]|[1-9])\b/g)];
  if (marks.length < 2) return [];
  const out: TextOffer[] = [];
  for (let i = 0; i < marks.length; i++) {
    const label = marks[i]![1]!;
    if (out.some((o) => o.label === label)) continue;
    const seg = t.slice(marks[i]!.index!, marks[i + 1]?.index ?? t.length).split(/[.!?](?:\s|$)/)[0]!;
    const price = /\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(each|a ticket|per ticket|apiece|pp|a seat|per seat|total|in total|for (?:both|all|the two))?/i.exec(seg);
    if (!price) continue;
    const cents = money(price[1]!);
    const isTotal = /total|for (both|all|the two)/i.test(price[2] ?? '');
    out.push({
      label,
      perTicketCents: isTotal ? null : cents,
      totalCents: isTotal ? cents : null,
      feeBasis: /\b(including|incl\.?|with) (all )?fees\b|\ball[- ]in\b/i.test(seg) ? 'all_in' : /\b(before|plus|\+|excluding|excl\.?) fees\b/i.test(seg) ? 'before_fees' : 'unknown',
      accessible: /\b(wheelchair|accessible|companion|ada)\b/i.test(seg),
      together: /\btogether\b/i.test(seg) ? true : /\bnot together|split\b/i.test(seg) ? false : null,
      section: /\bsection\s+([A-Za-z0-9]+)\b/i.exec(seg)?.[1] ?? null,
      row: /\brow\s+([A-Za-z0-9]+)\b/i.exec(seg)?.[1] ?? null,
    });
  }
  return out.length >= 2 ? out : [];
}

/** "Offer B: 211" read as a section is the label, not the seat: keep the value. */
export function cleanSeatField(v: string | null): string | null {
  const s = v?.replace(/^\s*(?:offer|option|listing)\s+[A-Z0-9]+\s*[:\-–]\s*/i, '').trim();
  return s ? s : null;
}
