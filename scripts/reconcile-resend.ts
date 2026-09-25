/**
 * Inbound reconciliation against Resend (run in the Render shell).
 *
 *   pnpm tsx scripts/reconcile-resend.ts            # dry run: list what the provider received and what is missing here
 *   pnpm tsx scripts/reconcile-resend.ts --apply    # queue each missing message through the normal retrieval path
 *   --limit=N                                       # how many recent received emails to ask for (default 50, max 100)
 *
 * Use it when the webhook has been down, misconfigured or unsubscribed from `email.received`: it finds the
 * messages the provider holds that never became an inbound event here and queues them exactly as a webhook
 * would have. The per-minute dispatcher then retrieves and ingests them. Prints ids and counts only — never a
 * sender, subject or body. If the provider's list response is not in a shape this code recognises it stops and
 * says so rather than reporting zero missing.
 */
import { env } from '../src/lib/config/env';
import { getDb } from '../src/lib/db';
import { reconcileReceived, ReceivedListError } from '../src/lib/email/reconcile';

const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;

const e = env();
if (!e.RESEND_API_KEY) {
  console.error('[reconcile] RESEND_API_KEY is not set in this environment.');
  process.exit(1);
}

const { db } = await getDb();
console.log(`[reconcile] mode=${apply ? 'APPLY' : 'dry run'} limit=${limit ?? 50} at ${new Date().toISOString()}`);
try {
  const r = await reconcileReceived(db, { apiKey: e.RESEND_API_KEY, apply, limit, actor: 'script:reconcile-resend' });
  console.log(`[reconcile] provider listed ${r.listed}, already known ${r.known}, missing ${r.missing.length}, queued ${r.enqueued}`);
  for (const id of r.missing) console.log(`  missing provider_email_id=${id}${apply ? ' → queued' : ''}`);
  if (!apply && r.missing.length) console.log('[reconcile] re-run with --apply to queue these through the retrieval path.');
  if (apply && r.enqueued) console.log('[reconcile] the dispatcher picks them up within a minute; check /admin/inbox and /admin/operations.');
} catch (err) {
  if (err instanceof ReceivedListError) {
    console.error(`[reconcile] could not read the provider list (${err.kind}): ${err.message}`);
    console.error('[reconcile] nothing was changed. Run scripts/probe-resend-receiving.ts and paste its output so the parser can be matched to the real shape.');
    process.exit(2);
  }
  throw err;
}
process.exit(0);
