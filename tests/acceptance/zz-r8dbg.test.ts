import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { openTestDb } from '../harness';
import { replayR8, seedR8, body } from './qa-r8-harness';
import replay from '../fixtures/qa-r8-sports-cases.json';
it('dbg', async () => {
  const out: string[] = [];
  for (const mode of (process.env.R8_MODE ?? 'rules,live').split(',') as Array<'rules' | 'live'>) {
    const h = await openTestDb(); await seedR8(h);
    const only = (process.env.R8_ONLY ?? '15').split(',');
    const { replies } = await replayR8(h, { mode, only });
    for (const k of replay.cases.filter((c) => only.includes(c.id) || only.includes((c as { thread?: string }).thread ?? ''))) {
      (replies.get(k.id) ?? []).forEach((rs, i) => out.push(`##### [${mode}] ${k.id} turn ${i + 1} [${rs.map((r) => r.state).join(',')}]\n> ${k.turns[i]!.text}\n\n${rs.map(body).join('\n=====\n')}`));
    }
    await h.close();
  }
  writeFileSync(process.env.R8_OUT ?? '/tmp/claude-0/-home-user-ticketguy/aa47fb0e-c4ef-5a14-bf5a-324e191ea8b8/scratchpad/dbg.txt', out.join('\n\n').replace(/\nTicket Guy is for US-based.*\n/g, '\n'));
}, 400000);
