import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { linkDecision, recheckPage } from '@/lib/links/click';

export const dynamic = 'force-dynamic';

/** Email security scanners and link previewers open every link; their visits are kept apart from people's. */
const LIKELY_BOT = /bot|crawl|spider|preview|scanner|safelinks|proofpoint|mimecast|barracuda|google-?smtp|outlook|facebookexternalhit|slack|headless/i;

/**
 * A click on a link in one of our emails: counted, then sent on to the stored URL. It only ever redirects to
 * a URL we stored for that id, so it can't be used to send people anywhere else. A click is recorded as a
 * click, never as a purchase. Nothing about the visitor is stored beyond whether it looked automated.
 *
 * A buy link whose advice no longer stands (stale price, withdrawn or replaced advice, a changed or cancelled
 * event) gets a page saying so instead, with the seller's current page offered as that (`?current=1`), never
 * as the quote we sent (R2-LINK-STALE-01).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const { db } = await getDb();
  const [link] = await db.select().from(t.trackedLinks).where(eq(t.trackedLinks.id, id));
  if (!link || !/^https:\/\//i.test(link.url)) return new Response('Not found', { status: 404 });
  const likelyBot = LIKELY_BOT.test(req.headers.get('user-agent') ?? '');
  const current = new URL(req.url).searchParams.get('current') === '1';
  // "The seller's current page" skips the price and advice checks, never the destination check (R2-LINK-CONTEXT-01).
  const checked = await linkDecision(db, link, new Date());
  const decision = current && !(checked.go === false && checked.reason === 'destination_mismatch') ? null : checked;
  const gated = decision && !decision.go ? decision.reason : null;
  await db.insert(t.requestOutcomes).values({ requestId: link.requestId, kind: 'link_click', source: 'redirect', recommendationId: link.recommendationId, details: { linkId: link.id, label: link.label, affiliate: link.affiliate, likelyBot, purpose: link.purpose, ...(gated ? { gated } : {}), ...(current ? { current: true } : {}), ...(decision?.go && decision.legacy ? { legacy: true } : {}) }, actor: 'customer', at: new Date() });
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  if (decision && !decision.go) return new Response(recheckPage(decision, `/go/${link.id}?current=1`), { status: 200, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } });
  return new Response(null, { status: 302, headers: { ...headers, location: link.url } });
}
