/**
 * A typo in a name we know ("Kincks", "Norte Dane"), read as the name. The extraction model is told to correct obvious
 * misspellings; this is the check that doesn't depend on it, against the teams and acts already in the catalog. It
 * corrects only when exactly one known name is close and the typed name is long enough that closeness means something
 * ("Jets" is never read as "Nets"). Live Oct 8: "Norte Dane vs Miami" was searched as typed and found nothing.
 */
export type KnownName = { name: string; aliases: string[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Edit distance with adjacent transpositions ("Kincks" is one step from "Knicks"). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The ways a known name is said: whole, and its leading or trailing words ("Notre Dame", "Knicks"). */
function forms(name: string): string[] {
  const w = norm(name).split(' ').filter(Boolean);
  const out = new Set([w.join(' ')]);
  for (let i = 1; i < w.length; i++) {
    out.add(w.slice(0, i).join(' '));
    out.add(w.slice(i).join(' '));
  }
  return [...out];
}

export function correctToKnown(typed: string | null | undefined, known: KnownName[]): { from: string; to: string } | null {
  const n = norm(typed ?? '');
  // Short names are too close to each other for a typo to be told from another name.
  const allowance = n.length >= 9 ? 2 : n.length >= 6 ? 1 : 0;
  if (!allowance) return null;
  const hits = new Set<string>();
  for (const k of known) {
    const said = [k.name, ...k.aliases].flatMap(forms);
    if (said.includes(n)) return null; // a name we know, as typed
    if (said.some((f) => f.length >= 4 && Math.abs(f.length - n.length) <= allowance && editDistance(f, n) <= allowance)) hits.add(k.name);
  }
  return hits.size === 1 ? { from: typed!.trim(), to: [...hits][0]! } : null;
}
