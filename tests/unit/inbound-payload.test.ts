import { describe, expect, it } from 'vitest';
import { detailFromWebhookPayload } from '@/lib/email/resend';

/**
 * The retrieval call is one more thing that can fail — and did, for every inbound email on production.
 * When the signature-verified payload already carries the message, it is used directly. The guard has to
 * be conservative: anything it does not clearly recognise must fall through to the retrieval path.
 */
const base = {
  data: {
    email_id: '7c1f9b6e-0000-4000-8000-000000000001',
    from: 'Alice <alice@customer.example>',
    to: ['my@ticketguy.now'],
    subject: 'Rangers tickets',
    text: 'Five of us want the Rangers game.',
    headers: { 'Message-ID': '<abc@mail.example>', 'In-Reply-To': '<prior@mail.example>' },
    created_at: '2026-09-23T19:08:27.000Z',
  },
};

describe('webhook payload as the message source', () => {
  it('uses a payload that carries the body', () => {
    const d = detailFromWebhookPayload(base)!;
    expect(d.id).toBe('7c1f9b6e-0000-4000-8000-000000000001');
    expect(d.text).toBe('Five of us want the Rangers game.');
    expect(d.to).toEqual(['my@ticketguy.now']);
    expect(d.message_id).toBe('<abc@mail.example>');
    expect(d.in_reply_to).toBe('<prior@mail.example>');
  });

  it('falls through when the payload is metadata only', () => {
    expect(detailFromWebhookPayload({ data: { email_id: 'x', from: 'a@b.test', subject: 'hi' } })).toBeNull();
  });

  it('falls through when there is no sender', () => {
    expect(detailFromWebhookPayload({ data: { text: 'body but no sender' } })).toBeNull();
  });

  it('falls through when an attachment has no download URL, because the bytes are only behind the API', () => {
    expect(detailFromWebhookPayload({ data: { ...base.data, attachments: [{ id: 'a1', filename: 'ticket.pdf' }] } })).toBeNull();
  });

  it('uses a payload whose attachments already carry their URL', () => {
    const d = detailFromWebhookPayload({ data: { ...base.data, attachments: [{ id: 'a1', filename: 'ticket.pdf', download_url: 'https://resend.com/a/1' }] } });
    expect(d?.attachments[0]?.download_url).toBe('https://resend.com/a/1');
  });

  it('accepts headers as a name/value array as well as an object', () => {
    const d = detailFromWebhookPayload({ data: { ...base.data, headers: [{ name: 'Message-ID', value: '<arr@mail.example>' }] } });
    expect(d?.message_id).toBe('<arr@mail.example>');
  });

  it('takes html when there is no text', () => {
    const { text: _text, ...rest } = base.data;
    const d = detailFromWebhookPayload({ data: { ...rest, html: '<p>hello</p>' } });
    expect(d?.html).toBe('<p>hello</p>');
    expect(d?.text).toBeNull();
  });

  it('falls through on anything that is not a payload', () => {
    for (const bad of [null, undefined, 'string', 42, {}, { data: null }]) expect(detailFromWebhookPayload(bad)).toBeNull();
  });
});
