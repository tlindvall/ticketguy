import { describe, expect, it } from 'vitest';
import { launchState } from '@/lib/config/launch';

/**
 * The public page invites strangers to email only when a stranger would get a reply. The home page used
 * to say "Email my@ticketguy.now" while the allowlist refused every outside recipient.
 */
describe('public launch state', () => {
  const live = { APP_MODE: 'live' as const, EMAIL_SEND_ENABLED: true, EMAIL_TEST_RECIPIENT_ALLOWLIST: [] as string[] };

  it('is live only in live mode with sending on and no recipient restriction', () => {
    expect(launchState(live)).toBe('live');
  });

  it('stays coming soon while any condition would leave a stranger unanswered', () => {
    expect(launchState({ ...live, EMAIL_TEST_RECIPIENT_ALLOWLIST: ['staff@example.test'] })).toBe('coming_soon');
    expect(launchState({ ...live, EMAIL_SEND_ENABLED: false })).toBe('coming_soon');
    expect(launchState({ ...live, APP_MODE: 'fixture' })).toBe('coming_soon');
  });
});
