import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import type { DbHandle } from '@/lib/db';
import { FX } from '@/lib/fixtures';
import * as t from '@/lib/db/schema';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, makeConcierge, inbound } from '../harness';
import cases from '../fixtures/qa-music-0930.json';
const CLOCK = new Date('2026-09-30T18:00:00Z');
const ids = ['02', '09', '15', '16', '17', '18', '19'];
describe('concert QA: exact customer messages through intake and email rendering', () => {
  let h: DbHandle;
  const replies = new Map<string, typeof t.sendIntents.$inferSelect[]>();
  const requests = new Map<string, string>();
  beforeAll(async () => {
    h = await openTestDb();
    for (const [i, name] of ['Synthetic Pop Live', 'Synthetic Arena Pop', 'Dua Lipa Tribute Night'].entries()) {
      const id = `30000000-0000-4000-8000-0000000000d${i}`;
      await h.db.insert(t.events).values({ id, name, category: 'concert', genre: 'pop', venueId: FX.venues.msg, localStartAt: new Date(`2026-10-0${i + 2}T23:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
      await h.db.insert(t.eventSourceMappings).values({ eventId: id, sourceId: 'ticketmaster', sourceEventId: `MUSIC-CONTROL-${i}`, authoritativeUrl: `https://www.ticketmaster.com/event/MUSIC-CONTROL-${i}`, role: 'discovery', confidence: 'provider_id' });
    }
    const c = makeConcierge(h, { now: () => CLOCK });
    for (const k of cases.filter((k) => ids.includes(k.id))) {
      let parent: string | null = null;
      for (const [i, text] of k.messages.entries()) {
        const msg = inbound({ text: text.replace(/(.{1,76})(\s+|$)/g, '$1\n'), subject: k.scenario, from: `music-${k.id}@customer.example`, inReplyTo: parent, references: parent, receivedAt: new Date(CLOCK.getTime() + i * 1000) });
        const before = new Set((await h.db.select().from(t.sendIntents)).map((s) => s.id));
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
        replies.set(`${k.id}-${i + 1}`, (await h.db.select().from(t.sendIntents)).filter((s) => !before.has(s.id)));
      }
    }
    if (process.env.PRINT_MUSIC_REPLAY) writeFileSync(process.env.PRINT_MUSIC_REPLAY, [...replies].map(([k, ss]) => `${k}\n${ss.map((s) => s.bodyText).join('\n')}`).join('\n\n'));
  });
  afterAll(async () => { await h.close(); });
  const body = (id: string) => replies.get(id)!.map((s) => s.bodyText).join('\n');
  for (const [id, total] of [['16', '$220'], ['19', '$170']] as const) for (let i = 1; i <= 3; i++) it(`${id} turn ${i}: B admission, no A break-even`, () => {
    expect(replies.get(`${id}-${i}`)).toHaveLength(1);
    expect(body(`${id}-${i}`)).toMatch(/Offer B (?:is the one|wins)/);
    expect(body(`${id}-${i}`)).toContain(total);
    expect(body(`${id}-${i}`)).toContain('$30');
    expect(body(`${id}-${i}`)).toContain('excluded from the admission comparison');
    expect(body(`${id}-${i}`)).not.toMatch(/A only beats|ordinary seats|which.*date/i);
  });
  it('festival bypasses discovery and compares admission', () => {
    expect(body('17-1')).toMatch(/Offer B.*\$320/);
    expect(body('17-1')).not.toContain('Here are my');
    expect(body('17-1')).toContain('$350 budget');
    expect(body('17-1')).toContain('Over your $350');
  });
  for (let i = 1; i <= 2; i++) it(`overnight turn ${i}: B $80, $10 left, no date or budget question`, () => {
    expect(body(`15-${i}`)).toMatch(/Offer B.*\$80/);
    expect(body(`15-${i}`)).toContain('$10');
    expect(body(`15-${i}`)).toContain('at or after the cutoff');
    expect(body(`15-${i}`)).not.toMatch(/which calendar date|per ticket or|gone ahead/i);
    expect(replies.get(`15-${i}`)![0]!.bodyHtml).toContain('<strong>Offer B');
  });
  for (let i = 1; i <= 2; i++) it(`artist absent turn ${i}: direct skip`, () => expect(body(`18-${i}`)).toContain('Skip it'));
  for (let i = 1; i <= 2; i++) it(`minors turn ${i}: no policy invented or repeated shortlist`, () => {
    expect(body(`09-${i}`)).toContain('haven’t verified any event-specific policy');
    expect(body(`09-${i}`)).not.toContain('Here are my');
  });
  it('the explicit artist goal switch replaces the stored exact-artist target', async () => {
    const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requests.get('02')!));
    expect(versions.at(-1)!.brief).toMatchObject({ performerOrTeam: null, eventName: null, intent: 'browse', categoryHint: 'concert' });
    expect(body('02-2')).toContain('Synthetic Pop Live');
    expect(body('02-2')).toContain('Synthetic Arena Pop');
    expect(body('02-2')).not.toContain('Dua Lipa Tribute Night');
    expect(body('02-2')).not.toMatch(/Which Dua Lipa|scheduled Dua Lipa|another date or city/);
  });
});
