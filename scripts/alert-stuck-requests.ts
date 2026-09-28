/**
 * Alerts staff about requests already waiting on a person from before alerts existed
 * (`pnpm tsx scripts/alert-stuck-requests.ts` to list them, `--apply` to queue one alert each).
 *
 * Staff only: the customers are not emailed. A "a person is picking this up" note days after they wrote is
 * worse than a person simply answering, so those replies are for staff to write by hand. Alerts go through
 * the normal outbox, deduplicated per request and revision, so running this twice sends nothing new.
 */
import { eq } from 'drizzle-orm';
import { openDatabase } from '../src/lib/db';
import * as t from '../src/lib/db/schema';
import { enqueueOutbox } from '../src/lib/intake/outbox';

const apply = process.argv.includes('--apply');
const h = await openDatabase();
const rows = await h.db.select({ id: t.requests.id, revision: t.requests.currentRevision, updatedAt: t.requests.updatedAt }).from(t.requests).where(eq(t.requests.state, 'manual_attention'));
console.log(`[stuck] ${rows.length} request(s) waiting on a person; mode=${apply ? 'APPLY' : 'dry run'}`);
let queued = 0;
for (const r of rows) {
  const hours = ((Date.now() - r.updatedAt.getTime()) / 3_600_000).toFixed(1);
  let note = '';
  if (apply) {
    const q = await enqueueOutbox(h.db, { eventType: 'staff.alert', eventKey: `staff_alert:${r.id}:${r.revision}`, entityId: r.id, payload: { requestId: r.id, revision: r.revision }, now: new Date() });
    if (q.inserted) queued += 1;
    note = q.inserted ? ' → alert queued' : ' → already alerted';
  }
  console.log(`  ${r.id.slice(0, 8)} revision ${r.revision}, waiting ${hours}h${note}`);
}
if (apply) console.log(`[stuck] ${queued} alert(s) queued; the dispatcher sends them within a minute.`);
else if (rows.length) console.log('[stuck] re-run with --apply to alert staff. Customers are not emailed.');
await h.close();
