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

/** Bounded References chain for outbound replies: keep the root and the last few IDs. */
export function buildReferencesChain(existing: string[], inboundRfcMessageId: string, max = 8): string {
  const chain = [...existing.filter((x) => x !== inboundRfcMessageId), inboundRfcMessageId];
  if (chain.length <= max) return chain.join(' ');
  return [chain[0]!, ...chain.slice(chain.length - (max - 1))].join(' ');
}

/** The customer is the authenticated top-level sender, never someone quoted in a forward. */
export function stripQuotedContent(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+ wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*(Original|Forwarded) message\s*-{2,}$/i.test(line.trim())) break;
    if (/^Begin forwarded message:?$/i.test(line.trim())) break;
    if (/^From:\s.+$/.test(line.trim()) && out.length > 0) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}
