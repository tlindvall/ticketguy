/** Writes docs/LEXICON.md from the lexicon table (`pnpm lexicon:doc`). */
import { writeFileSync } from 'node:fs';
import { renderLexiconDoc } from '../src/lib/lexicon/doc';

writeFileSync(new URL('../docs/LEXICON.md', import.meta.url), renderLexiconDoc());
console.log('[lexicon] wrote docs/LEXICON.md');
