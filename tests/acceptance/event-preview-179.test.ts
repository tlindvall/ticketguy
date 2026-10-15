import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb } from '../harness';
import { FX } from '@/lib/fixtures';
import { eventAssetKey, eventPreview, guardedGet, parseOpenGraph, upsertEventImage, FETCH_LIMITS } from '@/lib/brand/event-image';
import { eventCard } from '@/lib/email/ticket-brief';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { previewCardProblems } from '../../evals/scorers';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';

/** Issue #179: a preview card with the event's own image, fetched safely, kept as our copy, served from our domain. */

const APP = 'https://ticketguy.now';
const publicDns = async () => ['93.184.216.34'];
const jpeg = (w = 1024, h = 576) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
const res = (body: BodyInit | null, init: ResponseInit & { type?: string } = {}) => new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/html', ...(init.headers as Record<string, string> | undefined) } });

/** A fake network: url → response, with every request recorded. */
function net(routes: Record<string, () => Response | Promise<Response>>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const u = String(input);
    seen.push(u);
    const r = routes[u];
    if (!r) return res('missing', { status: 404 });
    return r();
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe('Open Graph', () => {
  it('reads og:image in either attribute order, prefers secure_url and makes it absolute', () => {
    expect(parseOpenGraph('<meta content="https://img.example/a.jpg" property="og:image"><meta property="og:title" content="Club &amp; Night">', 'https://ra.co/events/1')).toEqual({ image: 'https://img.example/a.jpg', title: 'Club & Night', description: null });
    expect(parseOpenGraph('<meta property="og:image" content="http://x/a.jpg"><meta property="og:image:secure_url" content="https://x.example/b.jpg">', 'https://ra.co/e').image).toBe('https://x.example/b.jpg');
    expect(parseOpenGraph("<meta property='og:image' content='/img/c.jpg'>", 'https://www.ticketmaster.com/event/1').image).toBe('https://www.ticketmaster.com/img/c.jpg');
    // A plain-http image is not used.
    expect(parseOpenGraph('<meta property="og:image" content="http://insecure.example/a.jpg">', 'https://ra.co/e').image).toBeNull();
  });
});

describe('the fetcher (customers send links too: untrusted input)', () => {
  it('refuses a private, loopback or link-local destination', async () => {
    for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.1', '::1']) {
      const n = net({ 'https://evil.example/x.jpg': async () => res(await jpeg(), { type: 'image/jpeg' }) });
      expect(await guardedGet('https://evil.example/x.jpg', /^image\//, { fetchImpl: n.fetchImpl, resolver: async () => [ip] })).toBeNull();
      expect(n.seen).toEqual([]);
    }
  });
  it('re-checks every redirect: to http, to a private address, or more than 3 hops is refused', async () => {
    const toHttp = net({ 'https://a.example/x': () => res(null, { status: 302, headers: { location: 'http://a.example/y' } }) });
    expect(await guardedGet('https://a.example/x', /^image\//, { fetchImpl: toHttp.fetchImpl, resolver: publicDns })).toBeNull();
    const toPrivate = net({ 'https://a.example/x': () => res(null, { status: 302, headers: { location: 'https://internal.example/y' } }) });
    expect(await guardedGet('https://a.example/x', /^image\//, { fetchImpl: toPrivate.fetchImpl, resolver: async (h) => (h === 'internal.example' ? ['10.1.2.3'] : ['93.184.216.34']) })).toBeNull();
    expect(toPrivate.seen).toEqual(['https://a.example/x']);
    const loop = net(Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`https://a.example/${i}`, () => res(null, { status: 302, headers: { location: `https://a.example/${i + 1}` } })])));
    expect(await guardedGet('https://a.example/0', /^image\//, { fetchImpl: loop.fetchImpl, resolver: publicDns })).toBeNull();
    expect(loop.seen).toHaveLength(FETCH_LIMITS.maxRedirects + 1);
  });
  it('refuses more than 2 MB, the wrong type, and a body that never finishes in 3 seconds', async () => {
    const big = new Uint8Array(FETCH_LIMITS.maxBytes + 1);
    const declared = net({ 'https://a.example/big.jpg': () => res(big, { type: 'image/jpeg' }) });
    expect(await guardedGet('https://a.example/big.jpg', /^image\//, { fetchImpl: declared.fetchImpl, resolver: publicDns })).toBeNull();
    // Streamed with no length: cut off once past the cap.
    const streamed = net({ 'https://a.example/s.jpg': () => res(new ReadableStream({ start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(FETCH_LIMITS.maxBytes / 2)); c.close(); } }), { type: 'image/jpeg' }) });
    expect(await guardedGet('https://a.example/s.jpg', /^image\//, { fetchImpl: streamed.fetchImpl, resolver: publicDns })).toBeNull();
    const html = net({ 'https://a.example/p': () => res('<html></html>', { type: 'text/html' }) });
    expect(await guardedGet('https://a.example/p', /^image\//, { fetchImpl: html.fetchImpl, resolver: publicDns })).toBeNull();
    const slow = net({ 'https://a.example/slow.jpg': () => res(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); } }), { type: 'image/jpeg' }) });
    const t0 = Date.now();
    expect(await guardedGet('https://a.example/slow.jpg', /^image\//, { fetchImpl: slow.fetchImpl, resolver: publicDns })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(FETCH_LIMITS.timeoutMs + 1000);
  }, 10_000);
  it('without a network (tests, fixture mode, the eval) nothing is fetched', async () => {
    expect(await guardedGet('https://a.example/x.jpg', /^image\//, {})).toBeNull();
  });
});

describe('the preview image for an event', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('a Ticketmaster event shows its official image: copied once, 600px wide, served from our domain', async () => {
    const ev = FX.events.rangersPreseason;
    await upsertEventImage(h.db, { eventId: ev, name: 'Rangers vs. Islanders', source: 'ticketmaster', imageUrl: 'https://s1.ticketm.net/dam/a/rp_16_9.jpg', width: 1024, height: 576, sourceUrl: 'https://www.ticketmaster.com/event/RP1' });
    const n = net({ 'https://s1.ticketm.net/dam/a/rp_16_9.jpg': async () => res(await jpeg(), { type: 'image/jpeg' }) });
    const p = await eventPreview(h.db, { id: ev, name: 'Rangers vs. Islanders' }, APP, { fetchImpl: n.fetchImpl, resolver: publicDns });
    expect(p!.url).toMatch(/^https:\/\/ticketguy\.now\/event-art\/[0-9a-f-]{36}\.jpg$/);
    expect([p!.width, p!.height]).toEqual([600, 338]);
    const [asset] = await h.db.select().from(t.brandAssets).where(and(eq(t.brandAssets.kind, 'event'), eq(t.brandAssets.key, eventAssetKey(ev))));
    expect(asset).toMatchObject({ source: 'ticketmaster', rights: 'provider_terms', sourceUrl: 'https://www.ticketmaster.com/event/RP1' });
    // Fetched once: the next email uses our copy.
    const again = await eventPreview(h.db, { id: ev, name: 'Rangers vs. Islanders' }, APP, { fetchImpl: n.fetchImpl, resolver: publicDns });
    expect(again!.url).toBe(p!.url);
    expect(n.seen).toHaveLength(1);
  });

  it('a club night linked to its Resident Advisor page shows the RA image (Open Graph from the official page)', async () => {
    const ev = FX.events.rangersRegular;
    const page = 'https://ra.co/events/2034567';
    await h.db.insert(t.eventSourceMappings).values({ eventId: ev, sourceId: 'resident_advisor', sourceEventId: '2034567', authoritativeUrl: page, role: 'official', confidence: 'verified' }).onConflictDoNothing();
    const n = net({
      [page]: () => res('<html><head><meta property="og:image" content="https://images.ra.co/flyer.jpg"><meta property="og:title" content="Club night"></head></html>'),
      'https://images.ra.co/flyer.jpg': async () => res(await jpeg(800, 800), { type: 'image/jpeg' }),
    });
    const p = await eventPreview(h.db, { id: ev, name: 'Club night' }, APP, { fetchImpl: n.fetchImpl, resolver: publicDns });
    expect(p!.url).toMatch(/\/event-art\/[0-9a-f-]{36}\.jpg$/);
    const [asset] = await h.db.select().from(t.brandAssets).where(and(eq(t.brandAssets.kind, 'event'), eq(t.brandAssets.key, eventAssetKey(ev))));
    expect(asset).toMatchObject({ source: 'open_graph', rights: 'provider_terms', imageUrl: 'https://images.ra.co/flyer.jpg', sourceUrl: page });
  });

  it('nothing usable: null (the banner is used), recorded so the pages are not fetched again for a week', async () => {
    const ev = FX.events.knicks;
    await h.db.insert(t.eventSourceMappings).values({ eventId: ev, sourceId: 'official_site', sourceEventId: 'k1', authoritativeUrl: 'https://www.nba.com/knicks/game/1', role: 'official', confidence: 'verified' }).onConflictDoNothing();
    const n = net({ 'https://www.nba.com/knicks/game/1': () => res('<html><head><title>no og</title></head></html>') });
    expect(await eventPreview(h.db, { id: ev, name: 'Knicks' }, APP, { fetchImpl: n.fetchImpl, resolver: publicDns })).toBeNull();
    const fetched = n.seen.length;
    expect(await eventPreview(h.db, { id: ev, name: 'Knicks' }, APP, { fetchImpl: n.fetchImpl, resolver: publicDns })).toBeNull();
    expect(n.seen).toHaveLength(fetched);
    // A week later it is asked again.
    expect(await eventPreview(h.db, { id: ev, name: 'Knicks' }, APP, { fetchImpl: n.fetchImpl, resolver: publicDns, now: () => new Date(Date.now() + 8 * 24 * 3600_000) })).toBeNull();
    expect(n.seen.length).toBeGreaterThan(fetched);
  });

  it('an image whose rights are not cleared for email is never used', async () => {
    const ev = FX.events.yankees;
    await h.db.insert(t.brandAssets).values({ kind: 'event', key: eventAssetKey(ev), name: 'x', imageUrl: 'https://img.example/u.jpg', source: 'staff', rights: 'unreviewed' }).onConflictDoNothing();
    const n = net({ 'https://img.example/u.jpg': async () => res(await jpeg(), { type: 'image/jpeg' }) });
    expect(await eventPreview(h.db, { id: ev, name: 'x' }, APP, { fetchImpl: n.fetchImpl, resolver: publicDns })).toBeNull();
    expect(n.seen).not.toContain('https://img.example/u.jpg');
  });
});

describe('the card', () => {
  it('a preview is full width with the title and date as alt text; the facts stay text', () => {
    const html = eventCard({ category: 'Hockey', name: 'Rangers vs. Islanders', details: 'Madison Square Garden, New York · Sat, Oct 3, 7pm', artworkUrl: `${APP}/event-art/7e7e0000-0000-4000-8000-000000000900.jpg`, alt: 'Rangers vs. Islanders, Sat, Oct 3, 7pm' });
    expect(html).toContain('alt="Rangers vs. Islanders, Sat, Oct 3, 7pm"');
    expect(html).toMatch(/width="600" style="display:block;width:100%/);
    expect(html).toContain('<h2');
    expect(html).toContain('Madison Square Garden, New York · Sat, Oct 3, 7pm');
  });
  it('a drawn banner keeps its size, now with alt text', () => {
    const html = eventCard({ category: 'Hockey', name: 'Rangers vs. Islanders', details: 'MSG', artworkUrl: `${APP}/brief-art/v1/hockey/new-york-rangers/_.jpg` });
    expect(html).toContain('alt="Rangers vs. Islanders"');
    expect(html).toContain('width="300" height="100"');
  });
});

describe('the eval check (email_design)', () => {
  it('a recommendation for an eval-world event carries the card: our image, alt text, title, date and venue in text', async () => {
    const [turn] = (await runThread({ id: 'preview-179', capability: 'design', steps: [{ text: 'Hi Ticket Guy, can you find me 5 tickets together for the Rangers preseason game against the Islanders on Oct 3? Budget is $500 total.' }] } as unknown as Scenario, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() })) as [TurnOut];
    const rec = turn.emails.find((e) => e.cls === 'recommendation');
    expect(rec).toBeDefined();
    expect(previewCardProblems(rec!)).toEqual([]);
    expect(rec!.html).toMatch(/src="https:\/\/ticketguy\.now\/event-art\/[0-9a-f-]{36}\.jpg"/);
  }, 60_000);
  it('a short follow-up answer passes: its text is answer-first, the card keeps the event as text (side-question step 3)', async () => {
    const turns = (await runThread({ id: 'side-question-179', capability: 'design', steps: [{ text: '5 tickets for the Rangers preseason game, $500 total.' }, { text: 'Quick question — is MSG easy to get to from Penn Station?' }, { text: 'Great. So which seats would you go for?' }] } as unknown as Scenario, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() })) as TurnOut[];
    const recs = turns.flatMap((t) => t.emails).filter((e) => e.cls === 'recommendation');
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) expect(previewCardProblems(r)).toEqual([]);
  }, 60_000);
  it('flags an image hotlinked from elsewhere and one with no alt text', () => {
    const html = '<img src="https://s1.ticketm.net/x.jpg" alt=""><h2 style="">Game</h2><p style="">MSG, New York · Sat, Oct 3</p>';
    expect(previewCardProblems({ html, text: 'Game\nMSG, New York · Sat, Oct 3' })).toEqual(['recommendation: image not on our domain (s1.ticketm.net)', 'recommendation: image without alt text']);
  });
});
