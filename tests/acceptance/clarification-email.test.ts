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

  it('reads "next week", leaves the alumni night out, and takes the one home game in it', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Two tickets for the Rangers next week, up to $200 total.', from: 'alex@customer.example', subject: 'Rangers' }));
    await interpretAll(h, c);
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
    const body = intent!.bodyText;
    // Live Oct 3: "Which date?" three times. The one home game in the week is the answer, said in a line they can correct.
    expect(req!.state).toBe('researching');
    if (process.env.PRINT_CLARIFICATION) {
      // Opt-in: writes the email a customer would get to $PRINT_CLARIFICATION for review.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${process.env.PRINT_CLARIFICATION}/clarification.txt`, body);
      writeFileSync(`${process.env.PRINT_CLARIFICATION}/clarification.html`, intent!.bodyHtml ?? '');
    }

    expect(body).toContain("I've gone with the home game next week, Saturday, October 3. Tell me if you meant a different one.");
    expect(body).toContain('• When: Saturday, October 3, at 7 p.m.');
    expect(body).not.toContain('Are you looking for a home game at Madison Square Garden, or are away games an option?');
    expect(body).not.toMatch(/alumni/i); // neither the November night nor the alumni "team"
    expect(body).not.toContain('Oct 15'); // outside the week
    expect(body).not.toContain('possible matches');
    expect(body).not.toContain('What we have so far');
    expect(body).not.toContain('Could you tell us');
    expect(body).not.toMatch(/which date "next week" means/i);
    // Residency: asked once, on its own line, not as one of the request questions.
    expect(body).toContain("Ticket Guy is for US-based fans for now, so if you're outside the US, just let me know.");
    expect(body.match(/outside the US/g)).toHaveLength(1);
    expect(body).not.toContain('are you based in the US?');
    // The canned closer is gone: the question is the ask (TGQA-R6 writing review).
    expect(body).not.toContain('Just reply and I’ll narrow it down.');
    // First message in the conversation: the full signature, and an honest disclosure.
    expect(body).toContain('Ticket Guy\nYour second opinion before you buy.\nhttps://ticketguy.now');
    expect(intent!.bodyHtml).toContain('/email/ticket-guy-mascot@3x.png');
    // One type size a person reads, 16/24 in Ticket Guy ink, and 20px either side (personal-email design, Oct 3).
    expect(intent!.bodyHtml).toContain('font-size:16px;line-height:24px;color:#142438;');
    expect(intent!.bodyHtml).not.toMatch(/font-size:(?:11|12|13|15)px/);
    expect(body.trim().endsWith('AI-assisted ticket advice.')).toBe(true);
    expect(body).not.toContain('human-reviewed');
    // Left-aligned, not a centred newsletter column.
    expect(intent!.bodyHtml).not.toContain('margin:0 auto');
  });

  it('signs later messages in the same conversation "Ticket Guy" and does not repeat the residency line', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Four tickets for the Knicks, around $300.', from: 'sam@customer.example', subject: 'Knicks' }));
    await interpretAll(h, c);
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.id, req!.contactId));
    const follow = await c.queueSend({ messageClass: 'clarification', contactId: contact!.id, conversationId: req!.conversationId, requestId, revision: 2, recipient: contact!.emailOriginal, subject: 'Re: Knicks', template: 'clarification', vars: { acknowledgement: 'Four Knicks tickets, around $300—got it.', questions: ['Which date?'], countryCheck: false }, inReplyTo: null, approvalId: null, approvedHash: null });
    const [second] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.id, follow.id));
    expect(second!.bodyText).toContain('\n\nTicket Guy\n');
    expect(second!.bodyText).not.toMatch(/[—–]/);
    expect(second!.bodyText).not.toContain('Your second opinion before you buy.');
    expect(second!.bodyText).not.toContain('outside the US');
  });

  it('assumes a bare budget is the total; asks an unstated quantity once', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Two tickets for the Knicks on October 24, around $300.', from: 'jo@customer.example', subject: 'Knicks' }));
    await interpretAll(h, c);
    const requestId = (r as { requestId: string }).requestId;
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
    expect(intent!.bodyText).not.toContain('per ticket or for everyone combined');
    expect(intent!.bodyText).toContain("I've read $300 as the total for both. Tell me if you meant per ticket.");

    const q = await c.ingestInbound(inbound({ text: 'Rangers tickets on Oct 3 please.', from: 'noqty@customer.example', subject: 'Rangers' }));
    await interpretAll(h, c);
    const [qi] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, (q as { requestId: string }).requestId));
    // An unstated quantity is asked, once, rather than assumed to be two (TGQA-R6 1008).
    expect(qi!.bodyText.match(/How many tickets do you need/g)).toHaveLength(1);
    expect(qi!.bodyText).not.toContain("I've assumed two tickets");

    // Real doubt is still asked, not papered over.
    const few = await c.ingestInbound(inbound({ text: 'A few tickets for the Rangers on Oct 3.', from: 'few@customer.example', subject: 'Rangers' }));
    await interpretAll(h, c);
    const [fi] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, (few as { requestId: string }).requestId));
    expect(fi!.bodyText).not.toContain("I've assumed two tickets");
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
    expect(decisiveEventQuestion(homeOnly, brief({ performerOrTeam: 'Rangers' }))).toBe('Which game: Sat, Oct 3 at 7pm (New York Rangers vs. New York Islanders (preseason)) or Thu, Oct 15 at 7pm (New York Rangers vs. Fixture Opponent (regular season))?');
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
    expect(acknowledgementLine(brief({ performerOrTeam: 'rangers', quantity: 2, dateExpression: 'next week', budgetCents: 20000, budgetBasis: 'whole_party' }))).toBe('Two Rangers tickets next week, up to $200 total. Got it.');
    expect(acknowledgementLine(brief({ performerOrTeam: 'Knicks', quantity: 1, budgetCents: 15000, budgetBasis: 'per_ticket' }))).toBe('One Knicks ticket, up to $150 each. Got it.');
    expect(acknowledgementLine(brief({ performerOrTeam: 'Dua Lipa', quantity: 12, togetherRequired: true }))).toBe('12 Dua Lipa tickets together. Got it.');
    expect(acknowledgementLine(brief({ quantity: null }))).toBe('Thanks for getting in touch.');
    // A game reads as a game, with the matchup's "vs" left lower case.
    expect(acknowledgementLine(brief({ performerOrTeam: 'new york rangers vs tampa bay lightning', quantity: 2, togetherRequired: true, dateExpression: 'oct 1st', budgetCents: 40000, budgetBasis: 'whole_party' }))).toBe(
      'Two tickets together for New York Rangers vs Tampa Bay Lightning oct 1st, up to $400 total. Got it.',
    );
  });

  // The first real "Rangers vs Lightning" request came back "no scheduled event": the extractor put the whole
  // matchup in the team field and no team has that name, although the Rangers' games were on file.
  it('resolves a matchup to the game against that opponent', async () => {
    const c = makeConcierge(h);
    const full = await c.resolveEvent(brief({ performerOrTeam: 'New York Rangers vs New York Islanders' }));
    expect(full.kind).toBe('resolved');
    if (full.kind === 'resolved') expect(full.event.name).toContain('Islanders');

    // The opponent settles it even when the date alone would not, and a nickname or city is enough.
    const away = await c.resolveEvent(brief({ performerOrTeam: 'Rangers vs Bruins', dateExpression: 'in October' }));
    expect(away.kind).toBe('resolved');
    if (away.kind === 'resolved') expect(away.event.name).toBe('New York Rangers at Boston Bruins');

    // The matchup in the event name, with the team alone in the team field, narrows the same way.
    const split = await c.resolveEvent(brief({ performerOrTeam: 'Rangers', eventName: 'Rangers vs. Boston' }));
    expect(split.kind).toBe('resolved');
    if (split.kind === 'resolved') expect(split.event.name).toBe('New York Rangers at Boston Bruins');

    // Named second, the known team still resolves.
    const reversed = await c.resolveEvent(brief({ performerOrTeam: 'Tampa Bay Lightning vs New York Rangers' }));
    expect(reversed.kind).toBe('no_match'); // a known team, but no game against the Lightning on file
    if (reversed.kind === 'no_match') expect(reversed.reason).toBe('no_scheduled_event');
    const islanders = await c.resolveEvent(brief({ performerOrTeam: 'Islanders @ Rangers' }));
    expect(islanders.kind).toBe('resolved');
    if (islanders.kind === 'resolved') expect(islanders.event.name).toContain('Islanders');

    // A named opponent is a hard filter: no game against them is "none on file", never a different game.
    const none = await c.resolveEvent(brief({ performerOrTeam: 'New York Rangers vs Tampa Bay Lightning', dateExpression: 'in October' }));
    expect(none.kind).toBe('no_match');
    if (none.kind === 'no_match') expect(none.reason).toBe('no_scheduled_event');
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

