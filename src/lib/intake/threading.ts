/**
 * Thread correlation and participant authorization (A20). In-Reply-To/References are matched
 * against stored messages, THEN the sender must be the conversation's authorized contact.
 * A stranger copying a Message-ID gets a fresh conversation and no history.
 */
export type StoredMessageRef = { conversationId: string; contactEmailLookup: string; rfcMessageId: string };

export type ThreadResolution =
  | { kind: 'existing'; conversationId: string }
  | { kind: 'new'; reason: 'no_reference' | 'unknown_reference' | 'participant_mismatch' };

export function normalizeEmailLookup(email: string): string {
  // Conservative: trim + lowercase only. Never strip dots or plus tags.
  return email.trim().toLowerCase();
}

export function parseReferences(inReplyTo: string | null | undefined, references: string | null | undefined): string[] {
  const ids = new Set<string>();
  for (const raw of [inReplyTo ?? '', references ?? '']) {
    for (const m of raw.matchAll(/<[^<>\s]+>/g)) ids.add(m[0]);
  }
  return [...ids];
}

export function resolveThread(args: { senderEmail: string; inReplyTo: string | null; references: string | null; lookup: (rfcMessageId: string) => StoredMessageRef | undefined }): ThreadResolution {
  const ids = parseReferences(args.inReplyTo, args.references);
  if (ids.length === 0) return { kind: 'new', reason: 'no_reference' };
  const sender = normalizeEmailLookup(args.senderEmail);
  let sawKnown = false;
  for (const id of ids) {
    const ref = args.lookup(id);
    if (!ref) continue;
    sawKnown = true;
    if (ref.contactEmailLookup === sender) return { kind: 'existing', conversationId: ref.conversationId };
  }
  return { kind: 'new', reason: sawKnown ? 'participant_mismatch' : 'unknown_reference' };
}

/**
 * A Message-ID in its header form, angle brackets included. Some providers hand it over bare
 * ("abc@mail.gmail.com"); a bare one in our In-Reply-To is one mail clients may not thread on, and one our own
 * lookups (which read bracketed IDs) never match.
 */
export function normalizeMessageId(id: string | null | undefined): string | null {
  const t = (id ?? '').trim();
  if (!t) return null;
  if (/^<[^<>\s]+>$/.test(t)) return t;
  if (/^[^<>\s]+@[^<>\s]+$/.test(t)) return `<${t}>`;
  return t;
}

/** A References (or In-Reply-To) header with each bare ID bracketed; bracketed ones are left as they are. */
export function normalizeReferencesHeader(h: string | null | undefined): string | null {
  const t = (h ?? '').trim();
  if (!t) return null;
  return t.split(/[\s,]+/).filter(Boolean).map((x) => normalizeMessageId(x) ?? x).join(' ');
}

/** Bounded References chain for outbound replies: keep the root and the last few IDs. */
export function buildReferencesChain(existing: string[], inboundRfcMessageId: string, max = 8): string {
  const chain = [...existing.filter((x) => x !== inboundRfcMessageId), inboundRfcMessageId];
  if (chain.length <= max) return chain.join(' ');
  return [chain[0]!, ...chain.slice(chain.length - (max - 1))].join(' ');
}

/** "On <date> <sender> wrote:" on one line or wrapped over up to three, with a date, a time or an address in it. */
function isAttribution(next: string[]): boolean {
  if (!/^On\s/.test(next[0] ?? '')) return false;
  for (let n = 1; n <= next.length; n++) {
    const joined = next.slice(0, n).join(' ');
    if (/wrote:\s*$/.test(joined)) return /\b(?:19|20)\d{2}\b|\d:\d{2}|@/.test(joined);
  }
  return false;
}

/** The customer is the authenticated top-level sender, never someone quoted in a forward. */
export function stripQuotedContent(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Gmail wraps a long attribution: "On Tue, Sep 29, 2026 at 3:53 PM Ticket Guy <\nhello@ticketguy.now> wrote:".
    if (isAttribution(lines.slice(i, i + 3).map((l) => l.trim()))) break;
    if (/^_{8,}\s*$/.test(line.trim())) break; // Outlook's rule above "From: ... Sent: ...
    if (/^-{2,}\s*(Original|Forwarded) message\s*-{2,}$/i.test(line.trim())) break;
    if (/^Begin forwarded message:?$/i.test(line.trim())) break;
    if (/^From:\s.+$/.test(line.trim()) && out.length > 0) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}
