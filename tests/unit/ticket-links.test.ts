import { describe, expect, it } from 'vitest';
import { parseTicketLink } from '@/lib/domain/ticket-links';
import { stripQuotedContent } from '@/lib/intake/threading';

describe('ticket links', () => {
  it('reads the StubHub link a customer pasted: date, quantity, listing and event', () => {
    const l = parseTicketLink('https://www.stubhub.com/new-york-rangers-new-york-tickets-10-1-2026/event/161415566/?backUrl=%2Fnew-york-rangers-tickets%2Fperformer%2F2764&quantity=5&listingId=13718391146');
    expect(l).toEqual({ url: expect.any(String), marketplace: 'stubhub', localDate: '2026-10-01', quantity: 5, listingId: '13718391146', eventId: '161415566', slugText: 'new york rangers new york' });
  });

  it('reads Ticketmaster, SeatGeek and Vivid Seats paths', () => {
    expect(parseTicketLink('https://www.ticketmaster.com/new-york-rangers-v-tampa-bay-new-york-ny-10-13-2026/event/3B00630FD2E61A2B')).toMatchObject({ marketplace: 'ticketmaster', localDate: '2026-10-13', eventId: '3b00630fd2e61a2b' });
    expect(parseTicketLink('https://seatgeek.com/lightning-at-rangers-tickets/nhl/2026-10-13-7-pm/17234567?quantity=2')).toMatchObject({ marketplace: 'seatgeek', localDate: '2026-10-13', quantity: 2, slugText: 'lightning at rangers' });
    expect(parseTicketLink('https://www.vividseats.com/new-york-rangers-tickets-madison-square-garden-10-1-2026--sports-nhl-hockey/production/5812345?qty=4')).toMatchObject({ marketplace: 'vividseats', localDate: '2026-10-01', quantity: 4, eventId: '5812345', slugText: 'new york rangers' });
  });

  it('ignores links that are not ticket sites, and dates that are not dates', () => {
    expect(parseTicketLink('https://www.nhl.com/rangers/schedule')).toBeNull();
    expect(parseTicketLink('not a url')).toBeNull();
    expect(parseTicketLink('https://www.stubhub.com/x-tickets-2-30-2026/event/1')?.localDate).toBeNull();
  });
});

describe('quoted replies', () => {
  it('cuts at a Gmail attribution wrapped over two lines', () => {
    const text = 'lets do 6 tickets.\n\nOn Tue, Sep 29, 2026 at 3:53 PM Ticket Guy <\nhello@ticketguy.now> wrote:\nWhen: Thu, Oct 1, 7:00 PM EDT';
    expect(stripQuotedContent(text)).toBe('lets do 6 tickets.');
  });
  it('keeps a customer sentence that starts with "On"', () => {
    const text = 'On Saturday we want 2 Knicks tickets.\nMy friend wrote: get the good ones';
    expect(stripQuotedContent(text)).toBe(text);
  });
});

describe('html-only replies', () => {
  it('drops the Gmail quote block before turning html into text', async () => {
    const { normalizeReceived } = await import('@/lib/email/resend');
    const html = '<div dir="ltr">lets do 6 tickets.</div><br><div class="gmail_quote"><div class="gmail_attr">On Tue, Sep 29, 2026 at 3:53 PM Ticket Guy &lt;hello@ticketguy.now&gt; wrote:<br></div><blockquote>When: Thu, Oct 1, 7:00 PM EDT</blockquote></div>';
    const n = normalizeReceived({ id: 'e1', from: 'Tobias <t@customer.example>', to: ['my@ticketguy.now'], subject: 'Re: Rangers', text: null, html, headers: {}, message_id: '<m1@x>', in_reply_to: null, references: null, created_at: '2026-09-29T19:53:00Z', attachments: [] }, [], true);
    expect(n.text.trim()).toBe('lets do 6 tickets.');
  });
});

describe('Message-IDs from the provider', () => {
  it('brackets bare IDs, so our In-Reply-To threads and their replies find the conversation', async () => {
    const { normalizeReceived } = await import('@/lib/email/resend');
    const n = normalizeReceived({ id: 'e2', from: 't@customer.example', to: ['my@ticketguy.now'], subject: null, text: 'hi', html: null, headers: {}, message_id: 'CAm2@mail.gmail.com', in_reply_to: 'abc@resend.dev', references: 'root@mail.gmail.com abc@resend.dev', created_at: '2026-09-29T19:53:00Z', attachments: [] }, [], true);
    expect(n.rfcMessageId).toBe('<CAm2@mail.gmail.com>');
    expect(n.inReplyTo).toBe('<abc@resend.dev>');
    expect(n.references).toBe('<root@mail.gmail.com> <abc@resend.dev>');
  });
});

describe('StubHub checkout links', () => {
  it('read the listing and quantity from the checkout ID (session|listing|quantity|n), with no event id', () => {
    const l = parseTicketLink('https://checkout.stubhub.com/secure/buy/checkout?ID=f6b361e1-a7a3-40d2-85d3-cd3983c62741%7c14171973095%7c2%7c0');
    expect(l).toMatchObject({ marketplace: 'stubhub', listingId: '14171973095', quantity: 2, eventId: null });
  });
  it('an ID that is not in that shape is no listing', () => {
    expect(parseTicketLink('https://checkout.stubhub.com/secure/buy/checkout?ID=abc')?.listingId).toBeNull();
  });
});
