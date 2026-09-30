import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import type { DbHandle } from '@/lib/db';
import { FX } from '@/lib/fixtures';
import { FixtureExtractor } from '@/lib/ai/extraction';
import * as t from '@/lib/db/schema';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, makeConcierge, inbound } from '../harness';
import cases from '../fixtures/qa-concert-r9.json';

const CLOCK = new Date('2026-09-30T18:00:00Z');
const picks: Record<string, string[]> = {
  '03': ['B:80', 'B:80'], '04': ['B:220', 'B:220', 'B:220'], '05': ['B:320'],
  '07': ['B:170', 'B:170', 'B:170'], '08': ['A:180', 'B:200', 'A:180'],
  '09': ['B:220', 'A:180', 'B:220'], '10': ['B:255', 'B:90', 'B:90'],
  '11': ['C:280', 'B:320', 'B:320'], '12': ['B:180', 'A:60'],
  '14': ['B:80', 'A:50', 'A:50'], '15': ['B:80'], '16': ['B:80', 'B:80'],
  '17': ['B:220'], '19': ['A:60', 'A:60'], '22': ['A:180', 'A:180'], '23': ['B:180', 'A:60'],
};

describe.each(['fixture', 'misread-model'] as const)('R9 complete email conversations (%s extraction)', (mode) => {
  let h: DbHandle;
  const replies = new Map<string, typeof t.sendIntents.$inferSelect[]>();
  const requests = new Map<string, string>();
  beforeAll(async () => {
    h = await openTestDb();
    for (const [i, name] of ['Synthetic Pop Live', 'Synthetic Arena Pop', 'Dua Lipa Tribute Night'].entries()) {
      const id = `30000000-0000-4000-8000-0000000000e${i}`;
      await h.db.insert(t.events).values({ id, name, category: 'concert', genre: 'pop', venueId: FX.venues.msg, localStartAt: new Date(`2026-10-0${i + 2}T23:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
      await h.db.insert(t.eventSourceMappings).values({ eventId: id, sourceId: 'ticketmaster', sourceEventId: `R9-CONTROL-${i}`, authoritativeUrl: `https://www.ticketmaster.com/event/R9-CONTROL-${i}`, role: 'discovery', confidence: 'provider_id' });
    }
    const fixture = new FixtureExtractor();
    const c = makeConcierge(h, { now: () => CLOCK, extractor: mode === 'fixture' ? fixture : {
      name: 'adversarial-model-stub',
      async extract(input) {
        const x = await fixture.extract(input);
        // Reproduce production misreads, independently of the fixture extractor:
        // source price -> budget; room name -> party; cutoff -> an unrelated artist.
        return { ...x, quantity: 1, budgetCents: 3333, budgetBasis: 'whole_party', performerOrTeam: 'Midnight', eventName: 'Midnight' };
      },
    } });
    // Full fixture replay includes discovery; hostile-model controls target the quoted-term decisions.
    for (const k of cases.filter((k) => mode === 'fixture' || k.id !== '01')) {
      let parent: string | null = null;
      for (const [i, text] of k.messages.entries()) {
        const msg = inbound({ text: text.replace(/(.{1,76})(\s+|$)/g, '$1\n'), subject: k.scenario, from: `concert-r9-${mode}-${k.id}@customer.example`, inReplyTo: parent, references: parent, receivedAt: new Date(CLOCK.getTime() + i * 1000) });
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
    if (process.env.PRINT_CONCERT_R9) writeFileSync(`${process.env.PRINT_CONCERT_R9}-${mode}.txt`, [...replies].map(([k, ss]) => `${k}\n${ss.map((s) => s.bodyText).join('\n')}`).join('\n\n'));
  });
  afterAll(async () => { await h.close(); });
  const body = (id: string) => replies.get(id)!.map((s) => s.bodyText).join('\n');
  if (mode === 'fixture') it('01: an unconfirmed artist premise can change into useful similar-pop discovery', () => {
    expect(replies.get('01-1')).toHaveLength(1);
    expect(replies.get('01-2')).toHaveLength(1);
    expect(body('01-2')).toContain('Synthetic Pop Live');
    expect(body('01-2')).toContain('Synthetic Arena Pop');
    expect(body('01-2')).not.toContain('Dua Lipa Tribute Night');
  });
  for (const [id, turns] of Object.entries(picks)) for (const [i, pick] of turns.entries()) it(`${id} turn ${i + 1}: ${pick}, one rendered reply, no unrelated show`, () => {
    const [label, dollars] = pick.split(':');
    const ss = replies.get(`${id}-${i + 1}`)!;
    expect(ss).toHaveLength(1);
    expect(body(`${id}-${i + 1}`)).toMatch(new RegExp(`Offer ${label} (?:wins|is the one|is the straightforward).*\\$${dollars}\\b`));
    expect(body(`${id}-${i + 1}`)).not.toMatch(/Gimme Gimme|Daryl Roth|The Neighbourhood|Here are my|Which.*date/i);
    expect(ss[0]!.bodyHtml).toContain(`<strong>Offer ${label}`);
  });
  it('16: unknown arrival date stays unknown in the first reply', () => expect(body('16-1')).toContain('calendar dates'));
  for (const id of ['02', '06', '13', '18', '20', '21']) for (let i = 1; i <= cases.find((c) => c.id === id)!.messages.length; i++) it(`${id} turn ${i}: direct admission/artist answer`, () => {
    expect(replies.get(`${id}-${i}`)).toHaveLength(1);
    expect(body(`${id}-${i}`)).not.toMatch(/Here are my|Which.*date|another date or city/i);
    expect(replies.get(`${id}-${i}`)![0]!.bodyHtml).toContain('<strong>');
  });
  it('13: no guardian -> ID still fails -> updated ID qualifies', () => {
    expect(body('13-1')).toContain('cannot attend unaccompanied');
    expect(body('13-2')).toContain('ID does not meet');
    expect(body('13-3')).toContain('both meet the supplied entry requirements');
  });
  it('20: latest named-artist confirmation wins over old absence', () => {
    expect(body('20-1')).toContain('Skip it');
    expect(body('20-2')).toContain('original artist will perform');
  });
  it('18: direct no-admission answer, no need for another offer', () => expect(body('18-1')).toContain('cannot get you into the concert'));
  it('19 final: room access, useful official-source link, no invented budget or party', async () => {
    expect(body('19-3')).toContain('separate event');
    expect(body('19-3')).not.toMatch(/up to \$33.33|one ticket|send.*link/i);
    expect(replies.get('19-3')![0]!.bodyHtml).toContain('https://www.elsewhere.club/events/1992080179442');
    expect(replies.get('19-3')![0]!.bodyHtml).toContain('Event page you sent (elsewhere.club)');
    const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requests.get('19')!));
    expect(versions.at(-1)!.brief).toMatchObject({ quantity: 2, budgetCents: null });
  });
  it('11: the festival price correction retains the right product and fee basis, not the shuttle’s terms', () => {
    expect(body('11-2')).toMatch(/Offer C \(concert admission\): \$200 each including fees, \$400/);
    expect(body('11-2')).toContain('Over your $350 budget by $50');
    expect(body('11-2')).not.toContain('Offer C (shuttle)');
  });
  it('22: package quantities and prices scan correctly in HTML', () => {
    expect(body('22-1')).toContain('one admission per package');
    expect(body('22-1')).toContain('$180 for two packages admitting both');
    expect(replies.get('22-1')![0]!.bodyHtml).toContain('<strong>Offer A</strong>');
    expect(replies.get('22-1')![0]!.bodyHtml).toContain('<strong>$180</strong>');
  });
  it('10: corrected budget and party survive a model misread', async () => {
    const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requests.get('10')!));
    expect(versions.at(-1)!.brief).toMatchObject({ quantity: 3, budgetCents: 10000, budgetBasis: 'whole_party' });
    expect(body('10-2')).toContain('$10 of your $100 budget');
  });
});
