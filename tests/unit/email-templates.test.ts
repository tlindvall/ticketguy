import { describe, expect, it } from 'vitest';
import { STARTER_BODY, renderAuthored, renderSubject, sampleVars, validateTemplateBody } from '@/lib/email/custom-templates';
import { renderTemplate } from '@/lib/email/templates';

describe('authored template rendering', () => {
  it('drops a paragraph whose only placeholder has no value', () => {
    const body = 'Hello.\n\n{{eventNote}}\n\nBye.';
    expect(renderAuthored(body, { eventNote: null }).text).toBe('Hello.\n\nBye.');
    expect(renderAuthored(body, { eventNote: 'We found two games.' }).text).toBe('Hello.\n\nWe found two games.\n\nBye.');
  });

  it('turns a list variable alone on a line into bullets in both formats', () => {
    const r = renderAuthored('What we understood:\n{{knownFacts}}', { knownFacts: ['5 tickets', 'Together'] });
    expect(r.text).toBe('What we understood:\n\n• 5 tickets\n• Together');
    expect(r.html).toContain('<ul><li>5 tickets</li><li>Together</li></ul>');
  });

  it('escapes authored and substituted text, and never emits authored markup', () => {
    const r = renderAuthored('Hello {{reason}}', { reason: '<script>alert(1)</script>' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('links bare URLs without letting them carry markup', () => {
    const r = renderAuthored('{{url}}', { url: 'https://example.com/a"onload="x' });
    expect(r.html).toContain('href="https://example.com/a&quot;onload=&quot;x"');
    expect(r.html).not.toContain('onload="x"');
  });

  it('substitutes into the subject and collapses the gap a missing value leaves', () => {
    expect(renderSubject('Re: {{eventLabel}} request', { eventLabel: 'Rangers' })).toBe('Re: Rangers request');
    expect(renderSubject('Re: {{eventLabel}} request', { eventLabel: null })).toBe('Re: request');
  });

  it('renders every starter body against its own sample data', () => {
    for (const [slot, body] of Object.entries(STARTER_BODY)) {
      const v = validateTemplateBody({ slot: slot as never, body });
      expect(v, `${slot} starter body`).toEqual({ ok: true });
      expect(renderAuthored(body, sampleVars(slot as never)).text.length).toBeGreaterThan(0);
    }
  });
});

describe('save-time validation', () => {
  it('rejects an unknown placeholder and names what is available', () => {
    const v = validateTemplateBody({ slot: 'acknowledgment', body: 'Hi {{customerName}}' });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors[0]).toContain('{{customerName}}');
      expect(v.errors[0]).toContain('{{eventLabel}}');
    }
  });

  it('rejects authored HTML rather than escaping it silently', () => {
    const v = validateTemplateBody({ slot: 'unsupported', body: '<p>Sorry</p>' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).toContain('HTML is not accepted');
  });

  it('refuses a deletion template that drops the CONFIRM keyword the reply parser needs', () => {
    expect(validateTemplateBody({ slot: 'deletion_verification', body: 'Reply yes to delete your data.' }).ok).toBe(false);
    expect(validateTemplateBody({ slot: 'deletion_verification', body: 'Reply CONFIRM to delete your data.' }).ok).toBe(true);
  });

  it('rejects a subject with a line break', () => {
    expect(validateTemplateBody({ slot: 'unsupported', subject: 'a\nb', body: '{{reason}}' }).ok).toBe(false);
  });
});

describe('override wiring', () => {
  const ctx = { appUrl: 'https://app.example', postalAddress: null };
  const FOOTER = 'AI-assisted and human-reviewed';

  it('uses the built-in template when no override is active', () => {
    const r = renderTemplate('acknowledgment', { eventLabel: 'the Rangers game', knownFacts: [] }, ctx);
    expect(r.text).toContain("we're checking options for the Rangers game");
  });

  it('uses staff copy when a slot is overridden, and still appends the disclosure', () => {
    const r = renderTemplate('acknowledgment', { eventLabel: 'the Rangers game', knownFacts: [] }, {
      ...ctx,
      overrides: { acknowledgment: { slot: 'acknowledgment', subject: null, body: 'On it for {{eventLabel}}.', signature: '— Tobias\nTicket Guy', version: 3 } },
    });
    expect(r.text).toContain('On it for the Rangers game.');
    expect(r.text).toContain('— Tobias');
    // An acknowledgment goes out automatically, so it may not claim a person reviewed it.
    expect(r.text).toContain('AI-assisted ticket advice.');
    expect(r.text).not.toContain('human-reviewed');
    expect(r.html).toContain('AI-assisted ticket advice.');
  });

  it('keeps the human-reviewed disclosure for messages a person approved', () => {
    const rec = renderTemplate('raw', { text: 'evidence-backed copy', html: '<p>evidence-backed copy</p>' }, ctx);
    expect(rec.text).toContain(FOOTER);
    const alert = renderTemplate('watch_alert', { quantity: 2, section: '112', totalCents: 30000, observedAt: 'now', url: 'https://x.test/o' }, ctx);
    expect(alert.text).toContain(FOOTER);
  });

  it('never overrides the recommendation body', () => {
    const r = renderTemplate('raw', { text: 'evidence-backed copy', html: '<p>evidence-backed copy</p>' }, {
      ...ctx,
      overrides: { acknowledgment: { slot: 'acknowledgment', subject: null, body: 'nope', signature: null, version: 1 } },
    });
    expect(r.text).toContain('evidence-backed copy');
    expect(r.text).not.toContain('nope');
  });

  it('formats the watch alert price from cents for the author', () => {
    const r = renderTemplate('watch_alert', { quantity: 5, section: '112', totalCents: 43000, observedAt: 'now', url: 'https://x.test/o' }, {
      ...ctx,
      overrides: { watch_alert: { slot: 'watch_alert', subject: null, body: '{{quantity}} seats for {{priceTotal}}.', signature: null, version: 1 } },
    });
    expect(r.text).toContain('5 seats for $430.');
  });
});
