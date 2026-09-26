/**
 * Staff-authored email copy.
 *
 * Deliberate limits, because this text is sent automatically to customers:
 *  - A template overrides a named built-in slot. It cannot create a new automatic send, and the
 *    recommendation body ('raw') is not overridable — that copy comes from the advice renderer and
 *    carries the evidence rules (no invented availability).
 *  - Bodies are plain text. HTML is derived by escaping and wrapping, never authored, so a template
 *    cannot inject markup or break a client. Authors get paragraphs, bullet lists and links.
 *  - The compliance footer is appended by the renderer after the signature and is not part of the
 *    editable body, so it cannot be edited away.
 *  - Placeholders are validated against the slot's declared variables at save time; an unknown name
 *    is a save error rather than an empty gap in a live email.
 */

export type SlotName = 'acknowledgment' | 'clarification' | 'unsupported' | 'deletion_verification' | 'watch_alert';

export type SlotVariable = { name: string; kind: 'text' | 'list' | 'flag'; description: string; sample: string | string[] | boolean };

export type SlotSpec = { name: SlotName; label: string; description: string; variables: SlotVariable[] };

export const SLOTS: SlotSpec[] = [
  {
    name: 'acknowledgment',
    label: 'Acknowledgment',
    description: 'First automatic reply after a request arrives. Sent without human review, so it must not promise prices or availability.',
    variables: [
      { name: 'eventLabel', kind: 'text', description: 'What we think they asked for', sample: 'the New York Rangers vs. New Jersey Devils game' },
      { name: 'knownFacts', kind: 'list', description: 'What we understood, one per line', sample: ['5 tickets', 'Seated together', 'Madison Square Garden'] },
      { name: 'countryUnconfirmed', kind: 'flag', description: 'True when we could not confirm the customer is in the US', sample: true },
    ],
  },
  {
    name: 'clarification',
    label: 'Clarification request',
    description: 'Asks the customer for missing details before any price research.',
    variables: [
      { name: 'acknowledgement', kind: 'text', description: 'One sentence saying what we understood', sample: 'Two Rangers tickets next week, up to $200 total—got it.' },
      { name: 'eventNote', kind: 'text', description: 'What we found (or did not) about the event, when there is something to say', sample: 'We don’t have a scheduled Dua Lipa event on file, so we haven’t looked at prices yet.' },
      { name: 'questions', kind: 'list', description: 'The questions that decide it, most important first', sample: ['Are you looking for a home game at Madison Square Garden, or are away games an option?'] },
      { name: 'countryCheck', kind: 'flag', description: 'True on the first clarification to a customer whose country is not yet confirmed', sample: true },
      { name: 'knownFacts', kind: 'list', description: 'What we have so far, as a list (kept for existing templates)', sample: ['4 tickets', 'Budget $600 total'] },
    ],
  },
  {
    name: 'unsupported',
    label: 'Unsupported request',
    description: 'Sent when we cannot help with a request at all.',
    variables: [{ name: 'reason', kind: 'text', description: 'Why we cannot help', sample: 'We only cover events in the United States right now.' }],
  },
  {
    name: 'deletion_verification',
    label: 'Deletion confirmation',
    description: 'Confirms a data deletion request. The CONFIRM instruction must survive any rewrite — the reply parser looks for that word.',
    variables: [],
  },
  {
    name: 'watch_alert',
    label: 'Watch alert',
    description: 'Sent when a watched event hits the target. Requires human approval before it goes out.',
    variables: [
      { name: 'quantity', kind: 'text', description: 'Number of tickets', sample: '5' },
      { name: 'section', kind: 'text', description: 'Section, when known', sample: '112' },
      { name: 'priceTotal', kind: 'text', description: 'Formatted total price', sample: '$430' },
      { name: 'observedAt', kind: 'text', description: 'When we last checked the price', sample: '2026-09-23 14:02 ET' },
      { name: 'url', kind: 'text', description: 'Link to the offer', sample: 'https://example.com/offer/123' },
    ],
  },
];

export const SLOT_NAMES = SLOTS.map((s) => s.name);
export const isSlotName = (v: string): v is SlotName => (SLOT_NAMES as string[]).includes(v);
export const slotSpec = (name: SlotName): SlotSpec => SLOTS.find((s) => s.name === name)!;

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_BODY_LENGTH = 8_000;
export const MAX_SIGNATURE_LENGTH = 2_000;

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export function placeholdersIn(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/** Save-time validation. Rejects unknown placeholders, authored markup, and oversized copy. */
export function validateTemplateBody(args: { slot: SlotName; subject?: string | null; body: string; signature?: string | null }): ValidationResult {
  const errors: string[] = [];
  const allowed = new Set(slotSpec(args.slot).variables.map((v) => v.name));
  const checkMarkup = (label: string, text: string) => {
    if (/<[a-zA-Z/!]/.test(text)) errors.push(`${label}: HTML is not accepted. Write plain text — paragraphs, "- " bullets and bare links are formatted for you.`);
  };
  const checkPlaceholders = (label: string, text: string, permitted: Set<string>) => {
    const unknown = placeholdersIn(text).filter((p) => !permitted.has(p));
    if (unknown.length) errors.push(`${label}: unknown placeholder${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `{{${u}}}`).join(', ')}. Available: ${permitted.size ? [...permitted].map((a) => `{{${a}}}`).join(', ') : 'none for this template'}.`);
    if (/\{\{(?![\s]*[A-Za-z])/.test(text)) errors.push(`${label}: malformed placeholder. Use {{name}}.`);
  };

  if (!args.body.trim()) errors.push('Body: cannot be empty.');
  if (args.body.length > MAX_BODY_LENGTH) errors.push(`Body: ${args.body.length} characters exceeds the ${MAX_BODY_LENGTH} limit.`);
  checkMarkup('Body', args.body);
  checkPlaceholders('Body', args.body, allowed);

  if (args.subject) {
    if (args.subject.length > MAX_SUBJECT_LENGTH) errors.push(`Subject: exceeds ${MAX_SUBJECT_LENGTH} characters.`);
    if (/[\r\n]/.test(args.subject)) errors.push('Subject: cannot contain line breaks.');
    checkPlaceholders('Subject', args.subject, allowed);
  }

  if (args.signature) {
    if (args.signature.length > MAX_SIGNATURE_LENGTH) errors.push(`Signature: exceeds ${MAX_SIGNATURE_LENGTH} characters.`);
    checkMarkup('Signature', args.signature);
    checkPlaceholders('Signature', args.signature, new Set());
  }

  if (args.slot === 'deletion_verification' && !/\bCONFIRM\b/.test(args.body)) {
    errors.push('Body: must contain the word CONFIRM — the reply parser matches on it, so removing it breaks deletion requests.');
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Links the bare URLs in already-escaped text. Escaping first means the href can never carry markup. */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}">${u}</a>`);
}

export type TemplateValue = string | string[] | boolean | number | null | undefined;

const isEmpty = (v: TemplateValue): boolean => v === null || v === undefined || v === false || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Renders one block of authored copy. A paragraph whose placeholder resolves to nothing is dropped
 * entirely, which is how a template expresses "only say this when we have it".
 */
export function renderAuthored(body: string, vars: Record<string, TemplateValue>): { text: string; html: string } {
  const paragraphs = body.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const textOut: string[] = [];
  const htmlOut: string[] = [];

  for (const para of paragraphs) {
    const used = placeholdersIn(para);
    if (used.length && used.some((name) => isEmpty(vars[name]))) continue; // nothing to say here

    const lines = para.split('\n').map((l) => l.trim());
    const bulletLines = lines.filter((l) => l.startsWith('- '));
    const isBulletBlock = bulletLines.length > 0 && bulletLines.length === lines.length;

    // A list variable standing alone on a line becomes a bullet list.
    const expandLine = (line: string): { kind: 'text'; value: string } | { kind: 'list'; items: string[] } => {
      const solo = line.match(/^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/);
      if (solo) {
        const v = vars[solo[1]!];
        if (Array.isArray(v)) return { kind: 'list', items: v.map(String) };
      }
      return { kind: 'text', value: line.replace(PLACEHOLDER, (_m, name: string) => {
        const v = vars[name];
        if (Array.isArray(v)) return v.map(String).join(', ');
        if (typeof v === 'boolean') return '';
        return v === null || v === undefined ? '' : String(v);
      }) };
    };

    if (isBulletBlock) {
      const items = lines.flatMap((l) => {
        const e = expandLine(l.slice(2));
        return e.kind === 'list' ? e.items : [e.value];
      }).filter(Boolean);
      if (!items.length) continue;
      textOut.push(items.map((i) => `• ${i}`).join('\n'));
      htmlOut.push(`<ul>${items.map((i) => `<li>${linkify(esc(i))}</li>`).join('')}</ul>`);
      continue;
    }

    const textLines: string[] = [];
    const htmlChunks: string[] = [];
    for (const line of lines) {
      const e = expandLine(line);
      if (e.kind === 'list') {
        if (!e.items.length) continue;
        if (textLines.length) {
          textOut.push(textLines.join('\n'));
          htmlOut.push(`<p>${htmlChunks.join('<br>')}</p>`);
          textLines.length = 0;
          htmlChunks.length = 0;
        }
        textOut.push(e.items.map((i) => `• ${i}`).join('\n'));
        htmlOut.push(`<ul>${e.items.map((i) => `<li>${linkify(esc(i))}</li>`).join('')}</ul>`);
      } else if (e.value.trim()) {
        textLines.push(e.value);
        htmlChunks.push(linkify(esc(e.value)));
      }
    }
    if (textLines.length) {
      textOut.push(textLines.join('\n'));
      htmlOut.push(`<p>${htmlChunks.join('<br>')}</p>`);
    }
  }

  return { text: textOut.join('\n\n'), html: htmlOut.join('\n') };
}

export function renderSubject(subject: string, vars: Record<string, TemplateValue>): string {
  return subject.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars[name];
    if (Array.isArray(v)) return v.map(String).join(', ');
    if (typeof v === 'boolean') return '';
    return v === null || v === undefined ? '' : String(v);
  }).replace(/\s+/g, ' ').trim();
}

/** Sample variables for the editor preview. Marked as sample data so a preview is never mistaken for a real send. */
export function sampleVars(slot: SlotName): Record<string, TemplateValue> {
  return Object.fromEntries(slotSpec(slot).variables.map((v) => [v.name, v.sample as TemplateValue]));
}

export type ActiveTemplate = { slot: SlotName; subject: string | null; body: string; signature: string | null; version: number };
export type TemplateOverrides = Partial<Record<SlotName, ActiveTemplate>>;

/** Starter copy shown in the editor: the built-in wording, in the authoring syntax. */
export const STARTER_BODY: Record<SlotName, string> = {
  acknowledgment: `Got it — we're checking options for {{eventLabel}}.

What we understood:
{{knownFacts}}

{{countryUnconfirmed}}One quick check: we serve US customers only — reply if you're not in the US.

We'll reply in this thread once a person has reviewed the comparison. No purchases happen on our side.`,
  clarification: `Hey,

{{acknowledgement}}

{{eventNote}}

{{questions}}

{{countryCheck}}One more thing, since we can only help US-based customers for now: are you based in the US?

Just reply and I’ll narrow it down.`,
  unsupported: `{{reason}}

We're sorry we can't help with this one yet.`,
  deletion_verification: `We received a request to delete your Ticket Guy data. To confirm, reply to this email with the word CONFIRM.

If you didn't ask for this, ignore this message.`,
  watch_alert: `A verified option for {{quantity}} together in section {{section}} is now {{priceTotal}} total (checked {{observedAt}}).

{{url}}

Prices can change before checkout. Reply "stop" to end this watch.`,
};
