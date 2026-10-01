/**
 * Service-depth rollout reconciliation (DECISION_LOG #61). Lists, for existing tracked events, active watches,
 * pending watch alerts and drafts awaiting review, what enforcing the policy would keep, pause or invalidate,
 * and why. Dry run unless --apply is passed; --apply pauses (never deletes) and invalidates unsent work.
 * Prints ids and reasons only: no customer data, message bodies or links.
 */
import { openDatabase } from '../src/lib/db';
import { env } from '../src/lib/config/env';
import { reconcileServiceDepth } from '../src/lib/intake/reconcile-service-depth';

const apply = process.argv.includes('--apply');
const h = await openDatabase();
const r = await reconcileServiceDepth(h.db, env(), { apply, now: new Date() });
const counts: Record<string, number> = {};
for (const a of r.actions) counts[`${a.kind}:${a.action}`] = (counts[`${a.kind}:${a.action}`] ?? 0) + 1;
console.log(`[service-depth] ${apply ? 'APPLIED' : 'dry run'}`, JSON.stringify(counts));
for (const a of r.actions.filter((x) => x.action !== 'keep')) console.log(`${a.kind}\t${a.id}\t${a.action}\t${a.reason}`);
await h.close();
