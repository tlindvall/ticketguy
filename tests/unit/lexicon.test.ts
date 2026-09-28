import { describe, expect, it } from 'vitest';
import { FixtureExtractor, type ExtractionInput } from '@/lib/ai/extraction';
import { LEXICON, modelPhrasebook } from '@/lib/lexicon/lexicon';
import { EXTRACTION_INSTRUCTIONS } from '@/lib/ai/model-client';
import { FIXTURE_NOW } from '@/lib/fixtures';

const KNOWN: ExtractionInput['knownEntities'] = [
  { name: 'New York Rangers', aliases: ['Rangers', 'NY Rangers'], kind: 'team', category: 'nhl' },
  { name: 'New York Knicks', aliases: ['Knicks'], kind: 'team', category: 'nba' },
];

const extract = (text: string) =>
  new FixtureExtractor().extract({ messageId: 'm1', text, subject: null, receivedAt: FIXTURE_NOW, venueTimeZone: 'America/New_York', knownEntities: KNOWN });

describe('the lexicon means what it says', () => {
  for (const entry of LEXICON) {
    for (const ex of entry.examples) {
      it(`${entry.id}: "${ex.text}"`, async () => {
        const out = await extract(ex.text);
        const { ambiguities, ...rest } = ex.expect;
        expect(out).toMatchObject(rest);
        for (const a of ambiguities ?? []) expect(out.ambiguities).toContain(a);
        // Every phrase is spelled out for people and matched by its own pattern.
        expect(entry.pattern.test(ex.text), `${entry.id} pattern should match its example`).toBe(true);
      });
    }
  }

  it('every entry has a meaning, a phrase and at least one example', () => {
    for (const e of LEXICON) {
      expect(e.meaning.length, e.id).toBeGreaterThan(0);
      expect(e.phrases.length, e.id).toBeGreaterThan(0);
      expect(e.examples.length, e.id).toBeGreaterThan(0);
    }
    expect(new Set(LEXICON.map((e) => e.id)).size).toBe(LEXICON.length);
  });

  it('teaches the model the entries marked for it', () => {
    const book = modelPhrasebook();
    expect(EXTRACTION_INSTRUCTIONS).toContain(book);
    expect(book).toContain('"just me"');
    expect(book).toContain('categoryHint="concert"');
    expect(book).not.toContain('WNBA'); // not marked teachModel
  });
});

describe('docs/LEXICON.md', () => {
  it('is up to date with the table (run `pnpm lexicon:doc`)', async () => {
    const { readFileSync } = await import('node:fs');
    const { renderLexiconDoc } = await import('@/lib/lexicon/doc');
    expect(readFileSync('docs/LEXICON.md', 'utf8')).toBe(renderLexiconDoc());
  });
});
