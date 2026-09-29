import { z } from 'zod';
import type { AdvicePacket, ClaimRecord } from './packet';

/**
 * Safe response renderer + validator (ADVICE_ENGINE §8 step 5–6).
 * The model returns structured blocks: a decision label, and paragraphs made of claim references and
 * bounded connective prose. The server renders every fact from the packet. Any block that introduces a
 * number, URL, percentage, prohibited phrase, unknown claim ID or conflicting decision is rejected (A63).
 */
export const ResponseBlocksSchema = z
  .object({
    decision: z.enum(['buy_now', 'wait_and_recheck', 'consider_alternative', 'insufficient_evidence']),
    opening: z.string().max(400),
    paragraphs: z
      .array(
        z.object({
          claimIds: z.array(z.string()).max(4),
          /** Connective prose; may not contain digits, currency, percentages or URLs. */
          prose: z.string().max(500),
        }),
      )
      .min(1)
      .max(6),
    closing: z.string().max(300),
  })
  .strict();
export type ResponseBlocks = z.infer<typeof ResponseBlocksSchema>;

export const PROHIBITED_PHRASES = [
  'always',
  'guaranteed',
  'guarantee',
  'only seats left',
  'only tickets left',
  'last seats',
  'i know the venue personally',
  'best on the internet',
  'normally',
  'usually',
  'will drop',
  'will fall',
  'will rise',
  'prices are dropping',
  'sold out everywhere',
  'confidence',
  '% chance',
  'probability',
  // Only a server claim, with the evidence behind it, can call a price fair; the model's prose never judges one.
  'good deal',
  'great deal',
  'a steal',
  'bargain',
];

const NUMERIC_OR_URL = /(\d|\$|%|https?:\/\/|www\.)/i;

export type ValidationResult = { ok: true; textBody: string; htmlBody: string } | { ok: false; errors: string[] };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function checkProse(label: string, prose: string, errors: string[]): void {
  if (NUMERIC_OR_URL.test(prose)) errors.push(`${label}: prose contains a number, currency, percentage or URL; facts must come from claim IDs`);
  const lower = prose.toLowerCase();
  for (const p of PROHIBITED_PHRASES) {
    if (lower.includes(p)) errors.push(`${label}: prohibited phrase "${p}"`);
  }
}

/**
 * The body reads like our other emails: "Hey," then the answer. The signature and the one disclosure line
 * ("human-reviewed" only when a person approved it) are added when it is sent (the raw templates), so the
 * body carries neither; it used to carry its own, and the email said it twice.
 */
const GREETING = 'Hey,';
const CATCHES_LEAD = 'Worth checking before you buy:';
const questionsLead = (n: number) => (n === 1 ? 'One thing that would help me:' : n === 2 ? 'Two things that would help me narrow it down:' : 'A few things that would help me narrow it down:');
const P = (inner: string) => `<p style="margin:0 0 18px;">${inner}</p>`;

const words = (s: string) => new Set(s.toLowerCase().replace(/[’']/g, '').match(/[a-z]+/g) ?? []);

/** Prose that repeats a claim: most of its words are the claim's own (a short lead-in like "Where to buy:" never is). */
export function restates(prose: string, claim: string): boolean {
  const p = words(prose);
  if (p.size < 6) return false;
  const c = words(claim);
  let shared = 0;
  for (const w of p) if (c.has(w)) shared += 1;
  return shared / p.size >= 0.7;
}

export function validateAndRender(packet: AdvicePacket, blocks: unknown, opts: { affiliateDisclosure?: string | null; reviewed?: boolean } = {}): ValidationResult {
  const parsed = ResponseBlocksSchema.safeParse(blocks);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const b = parsed.data;
  const errors: string[] = [];
  if (b.decision !== packet.decision) errors.push(`decision "${b.decision}" conflicts with policy decision "${packet.decision}"`);
  const claimsById = new Map(packet.claimRecords.map((c) => [c.id, c]));
  const used = new Set<string>();
  checkProse('opening', b.opening, errors);
  checkProse('closing', b.closing, errors);
  b.paragraphs.forEach((p, i) => {
    checkProse(`paragraph[${i}]`, p.prose, errors);
    for (const id of p.claimIds) {
      const c = claimsById.get(id);
      if (!c) errors.push(`paragraph[${i}]: unknown claim ID "${id}"`);
      else if (!c.customerVisible) errors.push(`paragraph[${i}]: claim "${id}" is not permitted in customer output (licensing/adequacy)`);
      else used.add(id);
    }
  });
  // Scope: a benchmark claim can only be used when the packet's historical adequacy permits it.
  if (used.has('C_BENCH') && packet.historicalAdequacy === 'insufficient') errors.push('benchmark claim used while historical adequacy is insufficient');
  if (used.has('C_TREND') && packet.trendAdequacy === 'insufficient') errors.push('trend claim used while trend adequacy is insufficient');
  // Required claims for a substantive recommendation.
  const hasBest = claimsById.has('C_BEST');
  if (hasBest && !used.has('C_BEST')) errors.push('the best current offer claim (C_BEST) must be included');
  // Resale market numbers we are allowed to show are the answer when there is no listing: never left out.
  if (claimsById.get('C_MARKET')?.customerVisible && !used.has('C_MARKET')) errors.push('the resale market claim (C_MARKET) must be included');
  if (!used.has('C_COVERAGE')) {
    // coverage footer is always appended server-side; not an error
  }
  if (packet.decision === 'wait_and_recheck' && !used.has('C_CHECKPOINT')) errors.push('a wait recommendation must include the checkpoint claim (C_CHECKPOINT)');
  if (errors.length) return { ok: false, errors };

  const lines: string[] = [];
  const html: string[] = [];
  // The customer's link is acknowledged first, in the server's words, and stands in for the model's opening.
  const link = claimsById.get('C_LINK');
  const opening = link?.customerVisible ? link.text : b.opening.trim();
  lines.push(GREETING, opening);
  html.push(P(GREETING), P(esc(opening)));
  // What the market means for them (C_READ) goes straight after the market figures, whether or not the model
  // placed it; C_LINK is never repeated in a paragraph.
  const read = claimsById.get('C_READ');
  // What their listing shows and the catches in it are placed by the server, straight after the answer.
  const subject = claimsById.get('C_SUBJECT');
  const catches = claimsById.get('C_CATCHES');
  const SERVER_PLACED = new Set(['C_LINK', 'C_SUBJECT', 'C_CATCHES']);
  const paragraphs = b.paragraphs
    .map((p) => ({ ...p, claimIds: p.claimIds.filter((id) => !SERVER_PLACED.has(id) && !(read && id === 'C_READ')) }))
    .flatMap((p) => (read?.customerVisible && p.claimIds.includes('C_MARKET') ? [p, { claimIds: ['C_READ'], prose: '' }] : [p]))
    .filter((p) => p.claimIds.length || p.prose.trim());
  const listingBlock = () => {
    if (subject?.customerVisible) {
      lines.push(subject.text);
      html.push(P(esc(subject.text)));
    }
    if (catches?.customerVisible) {
      const items = catches.text.split('\n').filter(Boolean);
      lines.push(CATCHES_LEAD, items.map((i) => `- ${i}`).join('\n'));
      html.push(P(esc(CATCHES_LEAD)), `<ul style="margin:0 0 18px;padding-left:22px;">${items.map((i) => `<li style="margin:0 0 8px;">${esc(i)}</li>`).join('')}</ul>`);
    }
  };
  let placed = false;
  for (const p of paragraphs) {
    const claimTexts = p.claimIds.map((id) => claimsById.get(id)!);
    // The model sometimes paraphrases the claim it cites ("I can't see live resale listings…" twice in a row).
    // The claim is the server's wording, so a lead-in that says the same thing is dropped.
    const prose = claimTexts.some((c) => restates(p.prose, c.text)) ? '' : p.prose.trim();
    const text = [prose, ...claimTexts.map((c) => c.text)].filter(Boolean).join(' ');
    lines.push(text);
    const htmlClaims = claimTexts.map((c) => (c.url ? `${esc(c.text)} <a href="${esc(c.url)}">${esc(c.linkLabel ?? 'View this offer')}</a>` : esc(c.text)));
    html.push(P([esc(prose), ...htmlClaims].filter(Boolean).join(' ')));
    if (!placed) {
      listingBlock();
      placed = true;
    }
  }
  if (!placed) listingBlock();
  // Always append the coverage footer and observation caveat from the packet (never model-authored).
  const coverage = claimsById.get('C_COVERAGE');
  if (coverage && !used.has('C_COVERAGE')) {
    lines.push(coverage.text);
    html.push(P(esc(coverage.text)));
  }
  for (const c of packet.claimRecords.filter((c) => c.url && used.has(c.id))) {
    lines.push(`${c.linkLabel ?? 'Link'}: ${c.url}`);
  }
  if (opts.affiliateDisclosure) {
    lines.push(opts.affiliateDisclosure);
    html.push(P(esc(opts.affiliateDisclosure)));
  }
  // The follow-up questions end the email and replace the model's closing, which used to ask for things the
  // customer had already sent.
  const asks = packet.followUps ?? [];
  if (asks.length) {
    lines.push(questionsLead(asks.length), asks.map((q) => `- ${q}`).join('\n'));
    html.push(P(esc(questionsLead(asks.length))), `<ul style="margin:0 0 18px;padding-left:22px;">${asks.map((q) => `<li style="margin:0 0 8px;">${esc(q)}</li>`).join('')}</ul>`);
  } else if (b.closing.trim()) {
    lines.push(b.closing.trim());
    html.push(P(esc(b.closing.trim())));
  }
  return { ok: true, textBody: lines.join('\n\n'), htmlBody: html.join('\n') };
}

/** Safe evidence-only fallback when generation fails repeatedly (no model prose at all). */
export function renderEvidenceOnly(packet: AdvicePacket, _opts: { reviewed?: boolean } = {}): { textBody: string; htmlBody: string } {
  const visible: ClaimRecord[] = packet.claimRecords.filter((c) => c.customerVisible);
  const decisionLine: Record<AdvicePacket['decision'], string> = {
    buy_now: 'Given your priorities, securing the option below is reasonable.',
    wait_and_recheck: 'Given your priorities, a bounded wait is reasonable. See the recheck point below.',
    consider_alternative: 'Nothing qualifying fits inside your budget; the alternative below is the closest we verified.',
    insufficient_evidence: 'Here’s what I can tell you so far.',
  };
  const link = visible.find((c) => c.id === 'C_LINK');
  const rest = visible.filter((c) => c.id !== 'C_LINK').map((c) => (c.id === 'C_CATCHES' ? { ...c, text: `${CATCHES_LEAD}\n${c.text.split('\n').map((i) => `- ${i}`).join('\n')}` } : c));
  const lead = link ? link.text : decisionLine[packet.decision];
  const asks = packet.followUps ?? [];
  const text = [GREETING, lead, ...rest.map((c) => c.text + (c.url ? `\n${c.linkLabel ?? 'Link'}: ${c.url}` : '')), ...(asks.length ? [questionsLead(asks.length), asks.map((q) => `- ${q}`).join('\n')] : [])].join('\n\n');
  const html = [P(GREETING), P(esc(lead)), ...rest.map((c) => P(`${esc(c.text)}${c.url ? ` <a href="${esc(c.url)}">${esc(c.linkLabel ?? 'View this offer')}</a>` : ''}`)), ...(asks.length ? [P(esc(questionsLead(asks.length))), `<ul style="margin:0 0 18px;padding-left:22px;">${asks.map((q) => `<li style="margin:0 0 8px;">${esc(q)}</li>`).join('')}</ul>`] : [])].join('\n');
  return { textBody: text, htmlBody: html };
}
