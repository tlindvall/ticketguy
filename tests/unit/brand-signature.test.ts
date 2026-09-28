import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { BUILT_IN_BRAND, renderSignature } from '@/lib/email/signature';
import { TemplateValidationError, loadBrandSignature, resetBrandSignature, saveBrandSignature } from '@/lib/email/template-store';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';

const APP = 'https://ticketguy.now';

describe('brand signature', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('renders each logo choice, and no image at all for "none"', () => {
    const badge = renderSignature('full', APP, { ...BUILT_IN_BRAND, logo: 'badge' });
    expect(badge.html).toContain('https://ticketguy.now/email/ticket-badge@3x.png');
    expect(badge.html).toContain('width="44" height="44"');
    expect(renderSignature('full', APP).html).toContain('ticket-mark@3x.png');
    const none = renderSignature('full', APP, { ...BUILT_IN_BRAND, logo: 'none' });
    expect(none.html).not.toContain('<img');
    expect(none.text).toBe('Ticket Guy\nYour second opinion before you buy.\nhttps://ticketguy.now');
  });

  it('escapes what staff type and drops an empty tagline', () => {
    const r = renderSignature('full', APP, { displayName: 'Tobias & Co', tagline: '', shortSignoff: '— Tobias', logo: 'mark' });
    expect(r.html).toContain('Tobias &amp; Co');
    expect(r.text).toBe('Tobias & Co\nhttps://ticketguy.now');
    expect(renderSignature('short', APP, { displayName: 'x', tagline: '', shortSignoff: '— Tobias', logo: 'mark' }).text).toBe('— Tobias');
  });

  it('is the built-in one until staff save, and back after a reset', async () => {
    expect(await loadBrandSignature(h.db)).toEqual(BUILT_IN_BRAND);
    await saveBrandSignature(h.db, { displayName: 'Tobias at Ticket Guy', tagline: 'Good tickets. Better advice.', shortSignoff: '— Tobias', logo: 'badge', staffUserId: 'staff-1' });
    expect(await loadBrandSignature(h.db)).toEqual({ displayName: 'Tobias at Ticket Guy', tagline: 'Good tickets. Better advice.', shortSignoff: '— Tobias', logo: 'badge' });
    await resetBrandSignature(h.db);
    expect(await loadBrandSignature(h.db)).toEqual(BUILT_IN_BRAND);
  });

  it('refuses markup, line breaks, empty required fields and unknown logos', async () => {
    const base = { displayName: 'Ticket Guy', tagline: '', shortSignoff: '— Ticket Guy', logo: 'mark' as const, staffUserId: 's' };
    await expect(saveBrandSignature(h.db, { ...base, displayName: '<b>Ticket Guy</b>' })).rejects.toBeInstanceOf(TemplateValidationError);
    await expect(saveBrandSignature(h.db, { ...base, tagline: 'two\nlines' })).rejects.toBeInstanceOf(TemplateValidationError);
    await expect(saveBrandSignature(h.db, { ...base, shortSignoff: '  ' })).rejects.toBeInstanceOf(TemplateValidationError);
    await expect(saveBrandSignature(h.db, { ...base, logo: 'gif' as never })).rejects.toBeInstanceOf(TemplateValidationError);
  });

  it('reaches the next email sent', async () => {
    await saveBrandSignature(h.db, { displayName: 'Tobias at Ticket Guy', tagline: 'Good tickets. Better advice.', shortSignoff: '— Tobias', logo: 'badge', staffUserId: 'staff-1' });
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Two tickets for the Knicks on October 24, around $300.', from: 'sig@customer.example', subject: 'Knicks' }));
    for (const ev of await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW })) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, (r as { requestId: string }).requestId));
    expect(intent!.bodyText).toContain('Tobias at Ticket Guy\nGood tickets. Better advice.');
    expect(intent!.bodyHtml).toContain('ticket-badge@3x.png');
    await resetBrandSignature(h.db);
  });
});
