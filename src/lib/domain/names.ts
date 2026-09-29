/**
 * The customer's first name, for "Hey Tobias,". Taken from what they say ("Tobias here", "my name is
 * Tobias", "this is Tobias"), else from the name on their email account ("Tobias Lindvall" <...>). Only a
 * plausible single first name is used: a wrong name is worse than "Hey,", so anything doubtful is dropped.
 */
const NOT_NAMES = new Set([
  'hey', 'hi', 'hello', 'yo', 'thanks', 'thank', 'still', 'right', 'over', 'not', 'nobody', 'everyone', 'someone', 'anyone', 'just', 'back', 'also', 'here', 'there',
  'looking', 'interested', 'going', 'trying', 'wondering', 'new', 'from', 'in', 'at', 'on', 'the', 'a', 'an', 'so', 'sorry', 'excited', 'good', 'fine',
  'info', 'tickets', 'ticket', 'admin', 'support', 'team', 'sales', 'office', 'contact', 'hello', 'noreply', 'mail', 'me', 'us', 'we', 'you',
]);

function clean(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const w = raw.trim().replace(/[’']s$/i, '');
  if (!/^[A-Za-z][A-Za-z'’-]{1,19}$/.test(w)) return null;
  if (NOT_NAMES.has(w.toLowerCase())) return null;
  return w[0]!.toUpperCase() + w.slice(1).toLowerCase();
}

/** A name the customer gave in their message, or null. Capitalised in the message, so "still here" never counts. */
export function statedFirstName(text: string): string | null {
  const t = text.slice(0, 600);
  const patterns = [/\b([A-Z][a-z'’-]{1,19}) here\b/, /\bmy name(?: is|'s|’s) ([A-Z][a-z'’-]{1,19})\b/i, /(?:^|[.!,]\s*)(?:[Tt]his is|[Ii]t's|[Ii]t’s|[Ii]'m|[Ii]’m|[Ii] am) ([A-Z][a-z'’-]{1,19})\b/];
  for (const re of patterns) {
    const m = re.exec(t);
    const n = clean(m?.[1]);
    if (n) return n;
  }
  return null;
}

/** The first word of the account name in the From header, if it looks like a person's first name. */
export function headerFirstName(displayName: string | null | undefined): string | null {
  if (!displayName || /@/.test(displayName)) return null;
  return clean(displayName.replace(/["']/g, '').trim().split(/\s+/)[0]);
}
