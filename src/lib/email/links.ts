/**
 * Which link goes where in a customer email. Each link takes the customer where they asked to go:
 *  - event title → the official event page (event briefs come later, and only when they add something);
 *  - Listen / Watch / Official info → the performer's or team's own links, as the provider lists them;
 *  - Buy tickets / Event & tickets → the seller's page for that exact event, through an affiliate link when
 *    one is configured for that seller.
 *
 * The affiliate step runs after the recommendation is chosen and never feeds back into it: which event or
 * offer is recommended is decided on fit and price alone (DECISION_LOG #37).
 */
import type { EntityLinks } from '@/lib/sources/adapters';

export type EmailLink = { label: string; url: string };

export const AFFILIATE_DISCLOSURE = 'Some ticket links pay Ticket Guy a small commission. It never changes what we recommend.';

/** The seller link, wrapped in that seller's affiliate format when one is configured. */
export function sellerLink(url: string, seller: string, templates: Record<string, string>): { url: string; affiliate: boolean } {
  const tpl = templates[seller];
  if (!tpl) return { url, affiliate: false };
  return { url: tpl.replace('{url}', encodeURIComponent(url)), affiliate: true };
}

/** The one exploring link worth offering: something to listen to, then to watch, then the official site. */
export function exploreLink(links: EntityLinks | null | undefined, kind: string | null): EmailLink | null {
  if (!links) return null;
  if (kind === 'team') return links.official ? { label: 'Team page', url: links.official } : null;
  if (links.listen) return { label: 'Listen', url: links.listen };
  if (links.watch) return { label: 'Watch', url: links.watch };
  if (links.official) return { label: 'Official site', url: links.official };
  return null;
}
