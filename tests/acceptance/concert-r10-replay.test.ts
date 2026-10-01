import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import { FixtureExtractor } from '@/lib/ai/extraction';
import * as t from '@/lib/db/schema';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, makeConcierge, inbound } from '../harness';
import cases from '../fixtures/qa-concert-r10.json';

const CLOCK = new Date('2026-09-30T23:15:00Z');
const picks: Record<string, string[]> = {
  '24': ['A:90', 'none'], '25': ['no', 'yes'], '26': ['no'], '27': ['yes'],
  '28': ['B:200', 'B:200'], '29': ['A:60', 'B:180'], '30': ['B:130', 'B:130'],
  '31': ['B:110', 'none'], '32': ['B:190'], '33': ['B:170'], '34': ['B:200'],
  '35': ['B:160'], '36': ['A:90', 'B:120'], '37': ['B:70', 'A:40'], '38': ['trend', 'trend'], '41': ['B:240'],
};

// Exact customer messages from R10, through ingest/interpret/outbox/email rendering. No network or real sends.
describe.each(['fixture', 'misread-model'] as const)('R10 useful concert replies (%s extraction)', (mode) => {
  let h: DbHandle;
  const replies = new Map<string, typeof t.sendIntents.$inferSelect[]>();
  const requests = new Map<string, string>();
  beforeAll(async () => {
    h = await openTestDb();
    const fixture = new FixtureExtractor();
    const c = makeConcierge(h, { now: () => CLOCK, extractor: mode === 'fixture' ? fixture : {
      name: 'adversarial-model-stub',
      async extract(input) {
        const x = await fixture.extract(input);
        return { ...x, quantity: 1, budgetCents: 3333, budgetBasis: 'whole_party', performerOrTeam: 'Midnight', eventName: 'Midnight' };
      },
    } });
    for (const k of cases) {
      let parent: string | null = null;
      for (const [i, text] of k.messages.entries()) {
        const prior = new Set((await h.db.select().from(t.sendIntents)).map((s) => s.id));
        const msg = inbound({ text: text.replace(/(.{1,76})(\s+|$)/g, '$1\n'), subject: k.scenario, from: `concert-r10-${mode}-${k.id}@customer.example`, inReplyTo: parent, references: parent, receivedAt: new Date(CLOCK.getTime() + i * 1000) });
        const r = await c.ingestInbound(msg) as { requestId: string };
        requests.set(k.id, r.requestId);
        parent ??= msg.rfcMessageId;
        for (let n = 0; n < 10; n++) {
          const events = await leaseDueOutbox(h.db, { limit: 100, now: new Date(CLOCK.getTime() + 10000) });
          if (!events.length) break;
          for (const ev of events) {
            const p = ev.payload as Record<string, string>;
            if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
            if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
            await markDispatched(h.db, ev.id, ev.leaseToken, CLOCK);
          }
        }
        replies.set(`${k.id}-${i + 1}`, (await h.db.select().from(t.sendIntents)).filter((s) => !prior.has(s.id)));
      }
    }
    if (process.env.PRINT_CONCERT_R10) writeFileSync(`${process.env.PRINT_CONCERT_R10}-${mode}.txt`, [...replies].map(([k, ss]) => `${k}\n${ss.map((s) => s.bodyText).join('\n')}`).join('\n\n'));
  });
  afterAll(async () => { await h.close(); });
  const body = (id: string) => replies.get(id)!.map((s) => s.bodyText).join('\n');
  for (const [id, turns] of Object.entries(picks)) for (const [i, pick] of turns.entries()) it(`${id} turn ${i + 1}: ${pick}`, () => {
    const key = `${id}-${i + 1}`;
    const ss = replies.get(key)!;
    expect(ss).toHaveLength(1);
    expect(body(key)).not.toMatch(/Live music in New York|Which.*date|Here are my|another date or city/i);
    expect(ss[0]!.bodyHtml).toContain('<strong>');
    if (pick.includes(':')) {
      const [label, dollars] = pick.split(':');
      expect(body(key)).toMatch(new RegExp(`Offer ${label} (?:wins|is the one|is the straightforward).*\\$${dollars}\\b`));
      expect(ss[0]!.bodyHtml).toContain(`<strong>Offer ${label}`);
    } else if (pick === 'none') expect(body(key)).toContain('None of the two meets all your requirements');
    else if (pick === 'no') expect(body(key)).toContain('cannot attend unaccompanied');
    else if (pick === 'yes') expect(body(key)).toContain('both meet the supplied entry requirements');
    else {
      expect(body(key)).toMatch(/cannot establish a trend|don.t establish a trend/i);
      expect(body(key)).toMatch(/same event|same performance/i);
      expect(body(key)).not.toMatch(/prices (?:will|should) fall|typical range|normal range/i);
    }
  });
  it('24: insufficient package stock is never displayed as a buyable three-person total', () => {
    expect(body('24-2')).not.toMatch(/\$180 for two packages admitting all three|one packages/);
    expect(body('24-2')).toMatch(/only (?:one|1) package|only (?:two|2) (?:tickets|admissions)/);
  });
  it('27: school ID is an accepted alternative, not a government-ID failure', () => {
    expect(body('27-1')).not.toContain('ID does not meet');
    expect(body('27-1')).toContain('haven’t independently verified');
  });
  it('30: known fee correction keeps the base price and adds fees once', () => {
    expect(body('30-1')).toMatch(/only beats it if its fees.*less than \$30/);
    expect(body('30-2')).toMatch(/\$50 each, plus \$20 a ticket in fees.*\$140/);
    expect(body('30-2')).toMatch(/\$10 (?:less|more)/);
  });
  it('31: quoted sold-out stock is explicitly rejected on both turns', () => {
    expect(body('31-1')).toMatch(/sold out|unavailable/i);
    expect(body('31-2')).not.toMatch(/Offer [AB] (?:wins|is the one|is the straightforward)/);
  });
  it('33: a buyer guarantee does not make late delivery safe for attending', () => {
    expect(body('33-1')).toMatch(/delivery.*misses|delivery.*after.*performance/);
    expect(body('33-1')).toMatch(/guarantee.*(?:does not|doesn.t|cannot)/i);
  });
  it('35 and 41: day validity and collection restrictions explain the rejection', () => {
    expect(body('35-1')).toMatch(/Friday.*Saturday|not valid.*Saturday/i);
    expect(body('41-1')).toMatch(/original purchaser|nontransferable|non-transferable/i);
  });
  it('25: mixed ages keep the party size instead of reading a policy age as quantity', async () => {
    const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requests.get('25')!));
    expect(versions.at(-1)!.brief).toMatchObject({ quantity: 2 });
  });
  it('38: the quoted current total is arithmetic, not a prediction', () => {
    expect(body('38-1')).toContain('$550');
    expect(body('38-1')).toContain('$50');
    expect(body('38-2')).toMatch(/fee|fees/);
    expect(body('38-2')).toMatch(/five|5/);
  });
});
