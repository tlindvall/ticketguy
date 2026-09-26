import type { Env } from './env';

/**
 * Whether the public site may invite strangers to email the concierge.
 *
 * The home page used to say "Email my@ticketguy.now" while the send gate was refusing every recipient
 * outside the test allowlist, so anyone who took it up got silence. The public page now follows what
 * the system will actually do: it invites mail only when a stranger's email would get a reply — live
 * mode, outbound sending on, and no recipient restriction. Anything short of that shows "coming soon".
 */
export type LaunchState = 'live' | 'coming_soon';

export function launchState(e: Pick<Env, 'APP_MODE' | 'EMAIL_SEND_ENABLED' | 'EMAIL_TEST_RECIPIENT_ALLOWLIST'>): LaunchState {
  const open = e.APP_MODE === 'live' && e.EMAIL_SEND_ENABLED && e.EMAIL_TEST_RECIPIENT_ALLOWLIST.length === 0;
  return open ? 'live' : 'coming_soon';
}
