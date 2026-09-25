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

const CATEGORY_LABELS: Record<string, string> = { nhl: 'NHL', nba: 'NBA', mlb: 'MLB', wnba: 'WNBA', nfl: 'NFL', concert: 'Concerts', broadway: 'Broadway', comedy: 'Comedy' };
const MARKET_LABELS: Record<string, string> = { 'new-york': 'New York' };

/** Human labels for the pilot scope, for public copy. Unknown keys fall back to a title-cased key. */
export function pilotScopeLabels(e: Pick<Env, 'pilotSupportedCategories' | 'pilotSupportedMarkets'>): { categories: string[]; markets: string[] } {
  const title = (k: string) => k.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    categories: e.pilotSupportedCategories.map((c) => CATEGORY_LABELS[c] ?? title(c)),
    markets: e.pilotSupportedMarkets.map((m) => MARKET_LABELS[m] ?? title(m)),
  };
}
