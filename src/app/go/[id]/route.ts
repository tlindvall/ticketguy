import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

/** Email security scanners and link previewers open every link; their visits are kept apart from people's. */
const LIKELY_BOT = /bot|crawl|spider|preview|scanner|safelinks|proofpoint|mimecast|barracuda|google-?smtp|outlook|facebookexternalhit|slack|headless/i;

/**
 * A click on a link in one of our emails: counted, then sent on to the stored URL. It only ever redirects to
 * a URL we stored for that id, so it can't be used to send people anywhere else. A click is recorded as a
 * click, never as a purchase. Nothing about the visitor is stored beyond whether it looked automated.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const { db } = await getDb();
  const [link] = await db.select().from(t.trackedLinks).where(eq(t.trackedLinks.id, id));
  if (!link || !/^https:\/\//i.test(link.url)) return new Response('Not found', { status: 404 });
  const likelyBot = LIKELY_BOT.test(req.headers.get('user-agent') ?? '');
  await db.insert(t.requestOutcomes).values({ requestId: link.requestId, kind: 'link_click', source: 'redirect', recommendationId: link.recommendationId, details: { linkId: link.id, label: link.label, affiliate: link.affiliate, likelyBot }, actor: 'customer', at: new Date() });
  return new Response(null, { status: 302, headers: { location: link.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
