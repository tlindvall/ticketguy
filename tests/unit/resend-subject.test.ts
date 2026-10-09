import { describe, expect, it } from 'vitest';
import { oneLineSubject } from '@/lib/email/resend';

/** Live, Oct 2: a staff alert dead-lettered after 8 tries on Resend's "The `\n` is not allowed in the `subject` field". */
describe('email subjects are one line', () => {
  it('line breaks and tabs become single spaces; ordinary subjects are untouched', () => {
    expect(oneLineSubject('Needs a person: model said\nURI malformed')).toBe('Needs a person: model said URI malformed');
    expect(oneLineSubject('Re: Rangers\r\n tickets\t tonight')).toBe('Re: Rangers tickets tonight');
    expect(oneLineSubject('Re: Your ticket brief')).toBe('Re: Your ticket brief');
  });
});
