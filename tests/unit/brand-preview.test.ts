import { describe, expect, it } from 'vitest';
import { proposedEmail, proposedSignature } from '@/components/preview/signature-proposal';
import { renderSignature } from '@/lib/email/signature';
import PreviewLayout from '@/app/preview/layout';

describe('brand direction 01 previews', () => {
  it('the proposed signature says exactly the three lines on the board, small, with the address as a mailto link', () => {
    const s = proposedSignature({ appUrl: 'https://ticketguy.now/', address: 'my@ticketguy.now' });
    expect(s.text).toBe('Ticket Guy\nYour second opinion before you buy.\nmy@ticketguy.now');
    expect(s.html).toContain('href="mailto:my@ticketguy.now"');
    expect(s.html).toContain('src="https://ticketguy.now/email/ticket-mark@3x.png" width="28" height="22"');
  });

  it('the email is plain text and a signature: no dashes, no second "Ticket Guy" sign-off, the disclosure kept', () => {
    const m = proposedEmail({ appUrl: '', address: 'my@ticketguy.now', paragraphs: ['Hey, I’d start with these two options.'] });
    expect(m.text).not.toMatch(/[—–]/);
    expect(m.html).not.toMatch(/[—–]/);
    expect(m.text.match(/Ticket Guy/g)).toHaveLength(1);
    expect(m.text).toContain('AI-assisted ticket advice.');
  });

  it('leaves the live signature alone', () => {
    expect(renderSignature('full', 'https://ticketguy.now').html).toContain('width="45" height="56"');
  });

  it('answers 404 outside local development to anyone who is not signed-in staff', async () => {
    await expect(PreviewLayout({ children: null })).rejects.toThrow();
  });
});
