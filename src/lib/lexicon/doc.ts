import { LEXICON, type LexiconEntry } from './lexicon';

const SECTIONS: Array<[LexiconEntry['field'][], string]> = [
  [['intent'], 'What kind of request'],
  [['wantsMore'], 'More of a list'],
  [['resaleAsked'], 'Resale and comparing'],
  [['notifyAsked'], 'Tell me when it goes on sale'],
  [['quotedPriceCents'], 'A price they saw'],
  [['categoryHint'], 'What kind of event (no performer or team named)'],
  [['genreHint'], 'What kind of music'],
  [['quantity', 'quantity_unclear'], 'How many'],
  [['budgetBasis'], 'Budget: each or total'],
  [['togetherRequired'], 'Seats'],
  [['dateExpression'], 'When'],
  [['city'], 'Where'],
];

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** docs/LEXICON.md, generated from src/lib/lexicon/lexicon.ts. */
export function renderLexiconDoc(): string {
  const out: string[] = [
    '# Lexicon',
    '',
    '<!-- Generated from src/lib/lexicon/lexicon.ts by `pnpm lexicon:doc`. Edit the table there, not this file. -->',
    '',
    'How customers say things, and what each phrase means to the concierge. The same table drives the rules',
    'extractor and is taught to the model (entries marked **model**). Every example below is run through the',
    'extractor on each test run, so an entry that stops meaning what it says fails the build.',
    '',
    '**Request types:** find (one named event) · browse ("what\'s on?") · watch (tell me when it changes) ·',
    'change (a correction) · stop (end a watch).',
    '',
    '**To add a phrase:** add it to an entry\'s `phrases` and `pattern` (or add an entry), give it an example,',
    'run `pnpm test`, then `pnpm lexicon:doc`.',
  ];
  for (const [fields, title] of SECTIONS) {
    const rows = LEXICON.filter((e) => fields.includes(e.field));
    if (!rows.length) continue;
    out.push('', `## ${title}`, '', '| Meaning | How customers say it | Sets | Categories | Request types | Example |', '|---|---|---|---|---|---|');
    for (const e of rows) {
      const sets = e.field === 'quantity_unclear' ? 'asks how many' : e.value !== undefined ? `\`${e.field}=${JSON.stringify(e.value)}\`` : `\`${e.field}\``;
      out.push(`| ${cell(e.meaning)}${e.teachModel ? ' **model**' : ''}${e.note ? ` _${cell(e.note)}_` : ''} | ${e.phrases.map((p) => `“${cell(p)}”`).join(', ')} | ${sets} | ${e.categories.join(', ')} | ${e.requestTypes.join(', ')} | “${cell(e.examples[0]!.text)}” |`);
    }
  }
  return `${out.join('\n')}\n`;
}
