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
  // We check prices and listings, never tickets: no promise about authenticity, entry or delivery.
  'legit',
  'authentic',
  'safe to buy',
  'will be delivered',
  'will arrive',
  'you’ll get in',
  "you'll get in",
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
const MARKET_LEAD = 'The resale market when I last checked:';
const P = (inner: string) => `<p style="margin:0 0 18px;">${inner}</p>`;

/**
 * The header: the event in bold, then where, when and the brief in a lighter line. As one bold run it wrapped into a
 * block that read like a warning (live Red Wings email). A packet from before the split keeps its one line.
 */
function header(packet: AdvicePacket): { text: string; html: string } | null {
  if (packet.headlineTitle && packet.headlineDetails) {
    return {
      text: `${packet.headlineTitle}\n${packet.headlineDetails}`,
      html: `<p style="margin:0 0 18px;"><strong style="font-size:16px;">${esc(packet.headlineTitle)}</strong><br><span style="font-size:14px;color:#6b6b6b;">${esc(packet.headlineDetails)}</span></p>`,
    };
  }
  return packet.headline ? { text: packet.headline, html: `<p style="margin:0 0 18px;font-weight:600;">${esc(packet.headline)}</p>` } : null;
}

/** Escaped, with prices in bold and a leading "My read:" in bold: the numbers and the answer are what people scan for. */
/**
 * Emphasis is for the decision, not every number: bolding each dollar amount made a dozen things compete with
 * the answer (post-#55 writing review). The opener's first sentence carries it; "My read:" marks the read.
 */
function rich(s: string): string {
  return esc(s).replace(/^(My read:)/, '<strong>$1</strong>');
}
function leadRich(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return m ? `<strong>${esc(m[1]!)}</strong>${rich(s.slice(m[1]!.length))}` : `<strong>${esc(s)}</strong>`;
}

/** A bold lead line and its bullets, in both bodies. */
function section(lines: string[], html: string[], lead: string, items: string[]): void {
  lines.push(lead, items.map((i) => `- ${i}`).join('\n'));
  html.push(`<p style="margin:0 0 8px;font-weight:600;">${esc(lead)}</p>`, `<ul style="margin:0 0 18px;padding-left:22px;">${items.map((i) => `<li style="margin:0 0 8px;">${rich(i)}</li>`).join('')}</ul>`);
}

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
  const claim = (id: string) => {
    const c = claimsById.get(id);
    return c?.customerVisible ? c : undefined;
  };
  // Scannable, answer first: what it's about in one line, the recommendation, what their listing shows and its
  // catches, the market as bullets with its source in small print, then questions and links. Every fact is a
  // server claim; the model's prose only connects the claims it cites, and never stands alone.
  const link = claim('C_LINK');
  const verdict = claim('C_VERDICT');
  const read = claim('C_READ');
  const subject = claim('C_SUBJECT');
  const catches = claim('C_CATCHES');
  const alternatives = [claim('C_ALTERNATIVES'), claim('C_VERIFIED')].filter((c): c is ClaimRecord => !!c);
  const quoteMarket = claim('C_QUOTE_MARKET');
  const marketFacts = [claim('C_MARKET'), claim('C_MARKET_TYPICAL')].filter((c): c is ClaimRecord => !!c);
  const coverage = claimsById.get('C_COVERAGE');
  const marketSource = marketFacts.length > 0 && !!coverage && coverage.kind === 'coverage' && /StubHub and Vivid Seats/.test(coverage.text);

  lines.push(GREETING);
  html.push(P(GREETING));
  // The header names the event, the party and the link they sent, so the opening line can be the answer.
  const head = header(packet);
  if (head) {
    lines.push(head.text);
    html.push(head.html);
  }
  // The answer to what they asked comes first: the verdict on their listing, the price they asked about, or,
  // with neither and nothing verified or on official sale to recommend, what the market means for them.
  const quote = claim('C_QUOTE');
  const somethingToBuy = claimsById.has('C_BEST') || claimsById.has('C_OFFICIAL');
  // Their own question first (TG-B02, remediation review §2): the state they asked about, then delivery against
  // their travel, wheelchair spaces against ordinary seats, the verdict on their listing, the price they asked
  // about. The first is the opening; the rest follow it, in that order. Stops and purchases never reach here:
  // they're confirmed on their own, from the saved state, before any advice.
  const watch = claim('C_WATCH');
  // State they asked about comes first (a watch running or not), then the question in their latest message.
  const primary = [claim('C_CORRECTION'), watch, claim('C_ROWS_ANSWER'), claim('C_TREND_ANSWER'), claim('C_LINK_UNREAD'), claim('C_OFFERS'), claim('C_PARKING'), claim('C_DELIVERY'), claim('C_ACCESS'), claim('C_SALES'), verdict, quote, claim('C_REQS'), claim('C_STAFF')].filter((c): c is ClaimRecord => !!c);
  // A claim with bullets (their offers side by side) is its first line, then the bullets.
  const put = (c: ClaimRecord, lead = false) => {
    const fmt = lead ? leadRich : rich;
    if (c.items?.length && c.text.includes('\n')) {
      const head = c.text.split('\n')[0]!;
      lines.push(head, c.items.map((i) => `- ${i}`).join('\n'));
      html.push(P(fmt(head)), `<ul style="margin:0 0 18px;padding-left:22px;">${c.items.map((i) => `<li style="margin:0 0 8px;">${rich(i)}</li>`).join('')}</ul>`);
    } else {
      lines.push(c.text);
      html.push(P(fmt(c.text)));
    }
  };
  // With nothing they asked about to answer first, the official sale is the answer, in the server's words. The
  // model's opener there was filler that named the seller a line before the claim did ("Ticketmaster is the place
  // I'd start." then "It's on general sale on Ticketmaster, and that's where I'd buy.", live Red Wings email).
  const official = !primary.length && !subject && !claimsById.has('C_BEST') ? claim('C_OFFICIAL') : undefined;
  // The official seller's own page, which their screenshot is of: its link only, placed by the server.
  const linkOnly = claim('C_OFFICIAL')?.values.sameSeller === 1 ? claim('C_OFFICIAL') : undefined;
  const opener = primary[0] ?? official ?? (read && !subject && !somethingToBuy ? read : undefined) ?? (packet.headline ? undefined : link);
  if (opener) {
    put(opener, true);
  } else if (b.opening.trim()) {
    lines.push(b.opening.trim());
    html.push(P(rich(b.opening.trim())));
  }
  for (const c of primary.slice(1)) put(c);

  // A made-up example's details are short points (A11), anything else one sentence.
  if (subject?.items?.length) {
    lines.push(subject.items.map((i) => `- ${i}`).join('\n'));
    html.push(`<ul style="margin:0 0 18px;padding-left:22px;">${subject.items.map((i) => `<li style="margin:0 0 8px;">${rich(i)}</li>`).join('')}</ul>`);
  } else if (subject) {
    lines.push(subject.text);
    html.push(P(rich(subject.text)));
  }
  // Their hypothetical about another price, answered right after the listing it's measured against.
  const gap = claim('C_GAP');
  if (gap) {
    lines.push(gap.text);
    html.push(P(rich(gap.text)));
  }
  const synthetic = claim('C_SYNTHETIC');
  // A made-up example has nothing to check before buying: its catches are just what it says.
  if (catches && catches.text.trim()) section(lines, html, synthetic ? 'It also shows:' : CATCHES_LEAD, catches.text.split('\n').filter(Boolean));
  if (synthetic) {
    lines.push(synthetic.text);
    html.push(P(rich(synthetic.text)));
  }
  for (const c of alternatives) {
    lines.push(c.text);
    html.push(P(rich(c.text)));
  }
  // What the comparison rejected and why, right after what it recommends.
  const leftOut = claim('C_LEFT_OUT');
  if (leftOut) {
    lines.push(leftOut.text);
    html.push(P(rich(leftOut.text)));
  }
  if (quoteMarket) {
    lines.push(quoteMarket.text);
    html.push(P(rich(quoteMarket.text)));
  }
  if (marketFacts.length) {
    section(lines, html, MARKET_LEAD, marketFacts.flatMap((c) => c.items?.length ? c.items : [c.text]));
    if (marketSource) {
      lines.push(coverage!.text);
      html.push(`<p style="margin:-8px 0 18px;font-size:13px;color:#6b6b6b;">${esc(coverage!.text)}</p>`);
    }
  }
  if (read && read !== opener) {
    lines.push(read.text);
    html.push(P(rich(read.text)));
  }

  // The model's paragraphs, for the claims the server hasn't placed. A paragraph left with no claim is
  // dropped: its prose only led into a claim now shown elsewhere ("That points to a simple way to judge any
  // seats you're eyeing:" followed by nothing).
  const SERVER_PLACED = new Set([...(official || linkOnly ? ['C_OFFICIAL'] : []), 'C_LINK', 'C_LINK_UNREAD', 'C_CORRECTION', 'C_PARKING', 'C_SYNTHETIC', 'C_GAP', 'C_ROWS_ANSWER', 'C_TREND_ANSWER', 'C_VERDICT', 'C_READ', 'C_WATCH', 'C_REQS', 'C_STAFF', 'C_OFFERS', 'C_SALES', 'C_DELIVERY', 'C_ACCESS', 'C_QUOTE', 'C_LEFT_OUT', 'C_SUBJECT', 'C_CATCHES', 'C_ALTERNATIVES', 'C_VERIFIED', 'C_QUOTE_MARKET', 'C_MARKET', 'C_MARKET_TYPICAL', ...(marketSource ? ['C_COVERAGE'] : [])]);
  for (const p of b.paragraphs) {
    const claimTexts = p.claimIds.filter((id) => !SERVER_PLACED.has(id)).map((id) => claimsById.get(id)!);
    if (!claimTexts.length) continue;
    // The model sometimes paraphrases the claim it cites; the claim is the server's wording, so that lead-in goes.
    const prose = claimTexts.some((c) => restates(p.prose, c.text)) ? '' : p.prose.trim();
    lines.push([prose, ...claimTexts.map((c) => c.text)].filter(Boolean).join(' '));
    html.push(P([esc(prose), ...claimTexts.map((c) => rich(c.text))].filter(Boolean).join(' ')));
  }
  // The coverage line is always there, from the packet (never model-authored).
  if (coverage && coverage.customerVisible && !marketSource && !used.has('C_COVERAGE')) {
    lines.push(coverage.text);
    html.push(P(esc(coverage.text)));
  }
  // The show's own site they started on is always linked back (LAUNCH-07), whichever claims the draft used.
  const linked = packet.claimRecords.filter((c) => c.url && (used.has(c.id) || c === official || c === linkOnly || c.id === 'C_REFERENCE'));
  // The follow-up questions end the email and replace the model's closing, which used to ask for things the
  // customer had already sent.
  const asks = packet.followUps ?? [];
  if (asks.length) section(lines, html, questionsLead(asks.length), asks);
  // Nor over their own question (delivery, their offers, access, sales): a model closing there drifted into
  // generic buy-or-wait advice (post-#54 QA, R3-B03).
  else if (b.closing.trim() && !subject && !['C_OFFERS', 'C_DELIVERY', 'C_ACCESS', 'C_SALES', 'C_PARKING', 'C_LINK_UNREAD'].some((id) => claimsById.has(id))) {
    // With a listing of theirs, the verdict up top is the recommendation; a model closing would only repeat or,
    // worse, ask for the listing they already sent.
    lines.push(b.closing.trim());
    html.push(P(esc(b.closing.trim())));
  }
  // Where to buy, last, with the affiliate disclosure beside the links it's about.
  if (linked.length) {
    lines.push(linked.map((c) => `${c.linkLabel ?? 'Link'}: ${c.url}`).join('\n'));
    html.push(P(linked.map((c) => `<a href="${esc(c.url!)}" style="font-weight:600;">${esc(c.linkLabel ?? 'View this offer')}</a>`).join('<br>')));
  }
  if (opts.affiliateDisclosure) {
    lines.push(opts.affiliateDisclosure);
    html.push(P(esc(opts.affiliateDisclosure)));
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
  // Their buy-or-wait question is answered first, as in the drafted email.
  const link = visible.find((c) => c.id === 'C_ROWS_ANSWER') ?? visible.find((c) => c.id === 'C_TREND_ANSWER') ?? visible.find((c) => c.id === 'C_VERDICT') ?? visible.find((c) => c.id === 'C_LINK');
  // Their offers compared: the answer is the comparison's first line, not a generic lead.
  const answer = visible.find((c) => c.id === 'C_OFFERS');
  const rest = visible.filter((c) => c !== link).map((c) => (c.id === 'C_CATCHES' ? { ...c, text: `${CATCHES_LEAD}\n${c.text.split('\n').map((i) => `- ${i}`).join('\n')}` } : c.items?.length ? { ...c, text: c.items.map((i) => `- ${i}`).join('\n') } : c));
  const lead = link ? link.text : answer ? answer.text.split('\n')[0]! : decisionLine[packet.decision];
  const asks = packet.followUps ?? [];
  const linked = rest.filter((c) => c.url);
  const top = header(packet);
  const head = top ? [top.text] : [];
  const text = [GREETING, ...head, lead, ...rest.map((c) => c.text), ...(asks.length ? [questionsLead(asks.length), asks.map((q) => `- ${q}`).join('\n')] : []), ...(linked.length ? [linked.map((c) => `${c.linkLabel ?? 'Link'}: ${c.url}`).join('\n')] : [])].join('\n\n');
  const html = [P(GREETING), ...(top ? [top.html] : []), P(rich(lead)), ...rest.map((c) => (c.items?.length ? `<ul style="margin:0 0 18px;padding-left:22px;">${c.items.map((i) => `<li style="margin:0 0 8px;">${rich(i)}</li>`).join('')}</ul>` : P(rich(c.text)))), ...(asks.length ? [P(esc(questionsLead(asks.length))), `<ul style="margin:0 0 18px;padding-left:22px;">${asks.map((q) => `<li style="margin:0 0 8px;">${esc(q)}</li>`).join('')}</ul>`] : []), ...(linked.length ? [P(linked.map((c) => `<a href="${esc(c.url!)}">${esc(c.linkLabel ?? 'View this offer')}</a>`).join('<br>'))] : [])].join('\n');
  return { textBody: text, htmlBody: html };
}
