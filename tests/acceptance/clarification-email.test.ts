import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { FX } from '@/lib/fixtures';
import { RequestExtractionSchema, type RequestExtraction } from '@/lib/domain/types';
import { weekWindowFor } from '@/lib/domain/dates';
import { decisiveEventQuestion, acknowledgementLine } from '@/lib/intake/pipeline';

/**
 * The first real clarification for "Two Rangers tickets next week, up to $200 total" offered a November
 * alumni night, dumped the candidates into the email under "What we have so far" / "Could you tell us",
 * asked for US residency as one of the request questions, and claimed human review on an automatic reply.
 * These pin the corrected behaviour against the fixture world's Rangers schedule plus the events that
 * caused it. FIXTURE_NOW is Tuesday 2026-09-22, so "next week" is Mon 28 Sep – Sun 4 Oct.
 */
const brief = (over: Partial<RequestExtraction>): RequestExtraction =>
  RequestExtractionSchema.parse({ intent: 'new_search', eventName: null, performerOrTeam: null, city: null, state: null, dateExpression: null, resolvedLocalDate: null, quantity: 2, budgetCents: null, budgetBasis: null, seatingPreference: null, togetherRequired: null, accessibilityNeeds: null, alternativesAllowed: null, submittedUrls: [], evidence: [], ambiguities: [], ...over });

/** Runs interpretation only. Sends stay queued, as they would while the dispatcher is between runs. */
async function interpretAll(h: DbHandle, c: ReturnType<typeof makeConcierge>) {
  for (let i = 0; i < 5; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
    const work = leased.filter((ev) => ev.eventType === 'request.interpret');
    if (!work.length) return;
    for (const ev of work) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
}

const TD_GARDEN = '10000000-0000-4000-8000-0000000000b0';
const ALUMNI_TEAM = '20000000-0000-4000-8000-0000000000a1';

describe('the clarification email', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: TD_GARDEN, name: 'TD Garden', city: 'Boston', state: 'MA', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: ALUMNI_TEAM, kind: 'team', name: 'New York Rangers Alumni', slug: 'new-york-rangers-alumni', aliases: ['Alumni'], league: null, homeVenueId: FX.venues.msg });
    await h.db.insert(t.events).values([
      // Next week, away: with the fixture's Oct 3 home game this makes the window mixed home/away.
      { name: 'New York Rangers at Boston Bruins', category: 'nhl', venueId: TD_GARDEN, primaryEntityId: FX.entities.rangers, isHome: false, localStartAt: new Date('2026-10-01T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true },
      // The event that was offered for "next week": filed under the Rangers, in November, not a game.
      { name: 'New York Rangers Alumni Classic', category: 'nhl', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, isHome: true, localStartAt: new Date('2026-11-14T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true },
      // A separate alumni "team" whose name merely contains the word.
      { name: 'New York Rangers Alumni vs. Legends', category: 'nhl', venueId: FX.venues.msg, primaryEntityId: ALUMNI_TEAM, isHome: true, localStartAt: new Date('2026-09-30T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true },
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('reads "next week", leaves the alumni night out, and asks the one question that decides it', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Two tickets for the Rangers next week, up to $200 total.', from: 'alex@customer.example', subject: 'Rangers' }));
    await interpretAll(h, c);
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('needs_clarification');
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
    const body = intent!.bodyText;
    if (process.env.PRINT_CLARIFICATION) {
      // Opt-in: writes the email a customer would get to $PRINT_CLARIFICATION for review.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${process.env.PRINT_CLARIFICATION}/clarification.txt`, body);
      writeFileSync(`${process.env.PRINT_CLARIFICATION}/clarification.html`, intent!.bodyHtml ?? '');
    }

    expect(body).toMatch(/^Hey,\n\nTwo (New York )?Rangers tickets next week, up to \$200 total—got it\./);
    expect(body).toContain('Are you looking for a home game at Madison Square Garden, or are away games an option?');
    expect(body).not.toMatch(/alumni/i); // neither the November night nor the alumni "team"
    expect(body).not.toContain('Oct 15'); // outside the week
    expect(body).not.toContain('possible matches');
    expect(body).not.toContain('What we have so far');
    expect(body).not.toContain('Could you tell us');
    expect(body).not.toMatch(/which date "next week" means/i);
    // Residency: asked once, on its own line, not as one of the request questions.
    expect(body).toContain('One more thing, since we can only help US-based customers for now: are you based in the US?');
    expect(body.match(/based in the US/g)).toHaveLength(1);
    expect(body).toContain('Just reply and I’ll narrow it down.');
    // First message in the conversation: the full signature, and an honest disclosure.
    expect(body).toContain('Ticket Guy\nYour second opinion before you buy.\nhttps://ticketguy.now');
    expect(intent!.bodyHtml).toContain('/email/ticket-mark@3x.png');
    expect(body.trim().endsWith('AI-assisted ticket advice.')).toBe(true);
    expect(body).not.toContain('human-reviewed');
    // Left-aligned, not a centred newsletter column.
    expect(intent!.bodyHtml).not.toContain('margin:0 auto');
  });

  it('signs later messages in the same conversation "— Ticket Guy" and does not repeat the residency line', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Four tickets for the Knicks, around $300.', from: 'sam@customer.example', subject: 'Knicks' }));
    await interpretAll(h, c);
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.id, req!.contactId));
    const follow = await c.queueSend({ messageClass: 'clarification', contactId: contact!.id, conversationId: req!.conversationId, requestId, revision: 2, recipient: contact!.emailOriginal, subject: 'Re: Knicks', template: 'clarification', vars: { acknowledgement: 'Four Knicks tickets, around $300—got it.', questions: ['Which date?'], countryCheck: false }, inReplyTo: null, approvalId: null, approvedHash: null });
    const [second] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.id, follow.id));
    expect(second!.bodyText).toContain('— Ticket Guy');
    expect(second!.bodyText).not.toContain('Your second opinion before you buy.');
    expect(second!.bodyText).not.toContain('based in the US');
  });

  it('asks what the extractor was unsure of: a budget with no basis reaches the email as a question', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Two tickets for the Knicks on October 24, around $300.', from: 'jo@customer.example', subject: 'Knicks' }));
    await interpretAll(h, c);
    const requestId = (r as { requestId: string }).requestId;
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
    expect(intent!.messageClass).toBe('clarification');
    expect(intent!.bodyText).toContain('Is your budget of $300 per ticket or for everyone combined?');
  });

  it('names up to three games when they are all home games, and asks for a date beyond that', async () => {
    const c = makeConcierge(h);
    const r = await c.resolveEvent(brief({ performerOrTeam: 'Rangers', dateExpression: 'next week', city: 'New York' }));
    expect(r.kind).toBe('resolved'); // the city leaves one home game in the week
    const both = await c.resolveEvent(brief({ performerOrTeam: 'Rangers', dateExpression: 'in October' }));
    expect(both.kind).toBe('ambiguous');
    if (both.kind !== 'ambiguous') return;
    expect(both.candidates.map((x) => x.name)).not.toContain('New York Rangers Alumni Classic');
    const homeOnly = both.candidates.filter((x) => x.isHome);
    expect(decisiveEventQuestion(homeOnly, brief({ performerOrTeam: 'Rangers' }))).toBe('Which game: Sat, Oct 3 (New York Rangers vs. New York Islanders (preseason)) or Thu, Oct 15 (New York Rangers vs. Fixture Opponent (regular season))?');
    const many = [...homeOnly, ...homeOnly, ...homeOnly];
    expect(decisiveEventQuestion(many, brief({ performerOrTeam: 'Rangers' }))).toBe('Which date are you looking at? Send a date or ticket link if you have one.');
  });

  it('still finds a non-game event when the customer asks for it by name', async () => {
    const c = makeConcierge(h);
    const r = await c.resolveEvent(brief({ performerOrTeam: 'Rangers', eventName: 'alumni game', dateExpression: 'in November' }));
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.event.name).toBe('New York Rangers Alumni Classic');
  });

  it('two teams in the window is asked as a choice between them', () => {
    const cands = [
      { id: 'a', label: '', entityName: 'New York Rangers', league: 'NHL', name: 'x', venueName: 'Madison Square Garden', isHome: true, when: 'Tue, Sep 29' },
      { id: 'b', label: '', entityName: 'Texas Rangers', league: 'MLB', name: 'y', venueName: 'Globe Life Field', isHome: true, when: 'Tue, Sep 29' },
    ];
    expect(decisiveEventQuestion(cands, brief({ performerOrTeam: 'rangers' }))).toBe('Which Rangers do you mean: the New York Rangers (NHL) or the Texas Rangers (MLB)?');
  });

  it('plays the request back in one sentence', () => {
    expect(acknowledgementLine(brief({ performerOrTeam: 'rangers', quantity: 2, dateExpression: 'next week', budgetCents: 20000, budgetBasis: 'whole_party' }))).toBe('Two Rangers tickets next week, up to $200 total—got it.');
    expect(acknowledgementLine(brief({ performerOrTeam: 'Knicks', quantity: 1, budgetCents: 15000, budgetBasis: 'per_ticket' }))).toBe('One Knicks ticket, up to $150 each—got it.');
    expect(acknowledgementLine(brief({ performerOrTeam: 'Dua Lipa', quantity: 12, togetherRequired: true }))).toBe('12 Dua Lipa tickets together—got it.');
    expect(acknowledgementLine(brief({ quantity: null }))).toBe('Thanks for getting in touch.');
  });
});

describe('week windows', () => {
  const tz = 'America/New_York';
  const tuesday = new Date('2026-09-22T15:00:00Z');
  const saturday = new Date('2026-09-26T15:00:00Z');
  it('reads weeks Monday to Sunday in the venue zone', () => {
    expect(weekWindowFor('next week', tuesday, tz)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(weekWindowFor('sometime next week', tuesday, tz)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(weekWindowFor('this week', tuesday, tz)).toEqual({ from: '2026-09-22', to: '2026-09-27' });
    expect(weekWindowFor('this weekend', tuesday, tz)).toEqual({ from: '2026-09-25', to: '2026-09-27' });
    expect(weekWindowFor('this weekend', saturday, tz)).toEqual({ from: '2026-09-26', to: '2026-09-27' });
  });
  it('spans both readings of "next weekend" rather than guessing one', () => {
    expect(weekWindowFor('next weekend', tuesday, tz)).toEqual({ from: '2026-09-25', to: '2026-10-04' });
  });
  it('names no window for a day or a month', () => {
    expect(weekWindowFor('tomorrow', tuesday, tz)).toBeNull();
    expect(weekWindowFor('in November', tuesday, tz)).toBeNull();
  });
});

