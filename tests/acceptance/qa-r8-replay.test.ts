import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db';
import { openTestDb } from '../harness';
import replay from '../fixtures/qa-r8-sports-cases.json';
import { replayR8, seedR8, body, type Mode, type Reply } from './qa-r8-harness';

for (const mode of ['rules', 'live'] as Mode[]) {
  describe(`TGQA-R8 sports QA, replayed (${mode === 'live' ? 'recorded model fields' : 'rules reader'})`, () => {
    let h: DbHandle;
    let replies: Map<string, Reply[][]>;
    beforeAll(async () => {
      h = await openTestDb();
      await seedR8(h);
      ({ replies } = await replayR8(h, { mode }));
    }, 240_000);
    afterAll(async () => {
      await h.close();
    });
    const turn = (id: string, n: number) => (replies.get(id)?.[n - 1] ?? []).map(body).join('\n\n=====\n\n');

    it('prints', () => {
      const out = process.env[`PRINT_R8_${mode.toUpperCase()}`];
      if (out) writeFileSync(out, replay.cases.map((k) => k.turns.map((tt, i) => `##### ${k.id} turn ${i + 1} [${(replies.get(k.id)?.[i] ?? []).map((r) => `${r.template}/${r.state}`).join(', ')}]\n> ${tt.text}\n\n${turn(k.id, i + 1) || '(no reply)'}`).join('\n\n')).join('\n\n'));
      expect(replies.size).toBe(27);
    });
  });
}
