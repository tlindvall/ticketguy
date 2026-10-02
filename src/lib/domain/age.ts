/**
 * Age eligibility from what is said, never assumed (R2-CONCERT-AGE-01): the youngest age the customer states for
 * their group, and the minimum age a listing states in its own title. A listing that says nothing is unknown, and
 * a venue's name is never read as an age policy.
 */

const PERSON = '(?:i\\s*\'?m|i am|we\\s*\'?re|we are|he\\s*\'?s|she\\s*\'?s|they\\s*\'?re|(?:my|our)\\s+(?:\\w+\\s+)?(?:friend|partner|son|daughter|kid|brother|sister|cousin|wife|husband|girlfriend|boyfriend|niece|nephew|mate|roommate|colleague)\\s+is)';

/** The youngest stated age in the group and who it is ("your friend", "you"), or null when no age is stated. */
export function partyMinimumAge(text: string): { age: number; who: string } | null {
  const t = text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
  const found: Array<{ age: number; who: string }> = [];
  for (const m of t.matchAll(new RegExp(`\\b(${PERSON})\\s+(?:only\\s+|just\\s+)?(\\d{1,2})\\b(?!\\s*(?:tickets?|seats?|people|persons?|adults?|friends?|guys|girls|kids|children|of us|in (?:total|all|the group)|total|going|coming|attending|together|minutes?|mins?|miles?|hours?|pm|am|:|%|\\$))`, 'gi'))) {
    const subject = m[1]!.toLowerCase();
    const who = /^(?:i|i'm|i am)/.test(subject.replace(/\s/g, '')) || /^i\s*'?m|^i am/.test(subject) ? 'you' : /^we|^they/.test(subject) ? 'one of you' : subject.replace(/^(?:my|our)\s+/, 'your ').replace(/\s+is$/, '');
    found.push({ age: Number(m[2]), who });
  }
  // "ages 24 and 20", "aged 19 and 22", "a 20-year-old", "20 years old".
  for (const m of t.matchAll(/\bage[sd]?\s+(\d{1,2})((?:\s*(?:,|and|&)\s*\d{1,2})*)\b/gi)) for (const n of [m[1]!, ...(m[2]!.match(/\d{1,2}/g) ?? [])]) found.push({ age: Number(n), who: 'one of you' });
  for (const m of t.matchAll(/\b(\d{1,2})[- ]?(?:years?[- ]old|yo)\b/gi)) found.push({ age: Number(m[1]), who: 'one of you' });
  const adultish = found.filter((f) => f.age >= 5 && f.age <= 99);
  if (!adultish.length) return null;
  return adultish.reduce((a, b) => (b.age < a.age ? b : a));
}

/** "no 21+ nights", "can't go to a 21+ event": the group has ruled out an age floor, whatever ages they gave. */
export function ruledOutAgeFloor(text: string): number | null {
  const m = /\b(?:no|not|can'?t|cannot|can not|won'?t)\s+(?:go\s+to\s+)?(?:an?\s+)?(?:any\s+)?(21|18)\s*\+/i.exec(text.replace(/[’‘]/g, "'"));
  return m ? Number(m[1]) : null;
}

/** The minimum age a listing's own title states ("Dusky - 21+", "(18 and Over)"), 0 for "all ages", else null. */
export function listedMinimumAge(title: string): number | null {
  if (/\ball[- ]ages\b/i.test(title)) return 0;
  const m = /\b(21|18|16)\s*\+|\b(21|18|16)\s*(?:and|&|or)\s*(?:over|up|older)\b|\bages?\s*(21|18|16)\b/i.exec(title);
  return m ? Number(m[1] ?? m[2] ?? m[3]) : null;
}

/** Why a listing can't be used by this group because of age, from stated facts only; null when it isn't known to fail. */
export function ageBlock(title: string, threadText: string): { listed: number; reason: string } | null {
  const listed = listedMinimumAge(title);
  if (!listed) return null;
  const party = partyMinimumAge(threadText);
  if (party && party.age < listed) return { listed, reason: `${party.who === 'you' ? 'you’re' : `${party.who} is`} ${party.age}` };
  const floor = ruledOutAgeFloor(threadText);
  if (floor !== null && listed >= floor) return { listed, reason: `you said no ${floor}+ events` };
  return null;
}

/** A title without its age tag, for saying it back: "Dusky - 21+" → "Dusky". */
export function withoutAgeTag(title: string): string {
  return title.replace(/\s*[-–—(]\s*(?:21|18|16)\s*(?:\+|and over|& over|and up)\s*\)?\s*$/i, '').replace(/\s*\((?:21|18|16)\s*(?:\+|and over|& over)\)\s*/i, ' ').trim();
}
