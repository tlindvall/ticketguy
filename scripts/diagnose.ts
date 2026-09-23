/**
 * Read-only production triage (run in the Render shell: `pnpm tsx scripts/diagnose.ts`).
 * Connects with the database URL directly so it never depends on app configuration, and prints the
 * counters the admin board cannot: inbound events by state, outbox rows with their last error, and
 * whether the registry/kill-switch seed ever ran. It writes nothing and prints no message bodies.
 */
import { desc, sql } from 'drizzle-orm';
import { openDatabase, openMigrationDatabase } from '../src/lib/db';
import * as t from '../src/lib/db/schema';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const h = url ? await openMigrationDatabase(url) : await openDatabase();
const db = h.db;
const line = (label: string, value: unknown) => console.log(`${label.padEnd(32)} ${String(value)}`);
const n = sql<number>`count(*)::int`;

console.log(`\n=== driver=${h.driver} at ${new Date().toISOString()} ===\n`);

console.log('-- seed --');
const [reg] = await db.select({ n }).from(t.sourceRegistry);
const switches = await db.select({ k: t.killSwitches.key, enabled: t.killSwitches.enabled }).from(t.killSwitches);
line('source_registry rows', `${reg?.n ?? 0} (expect 135 after seed)`);
line('kill_switches', switches.length ? switches.map((s) => `${s.k}=${s.enabled ? 'allowed' : 'STOPPED'}`).join(' ') : '0 rows — SEED NEVER RAN');

console.log('\n-- inbound --');
for (const r of await db.select({ k: t.inboundEvents.processingState, n }).from(t.inboundEvents).groupBy(t.inboundEvents.processingState)) line(`inbound_events ${r.k}`, r.n);
for (const r of await db.select({ k: t.inboundEvents.eventType, n }).from(t.inboundEvents).groupBy(t.inboundEvents.eventType)) line(`  type ${r.k}`, r.n);
for (const r of await db.select({ id: t.inboundEvents.id, st: t.inboundEvents.processingState, q: t.inboundEvents.quarantineReason, at: t.inboundEvents.receivedAt, payload: t.inboundEvents.payload }).from(t.inboundEvents).orderBy(desc(t.inboundEvents.receivedAt)).limit(10)) {
  // The provider's own id for the message, so the retrieval call can be reproduced by hand. It is an
  // opaque identifier, not content: the payload's keys are listed, never their values.
  const data = ((r.payload as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  const emailId = data.email_id ?? data.id ?? '—';
  console.log(`  ${r.at.toISOString()} ${r.id.slice(0, 8)} ${r.st}${r.q ? ` (${r.q})` : ''} provider_email_id=${String(emailId)}`);
  console.log(`      payload keys: ${Object.keys(data).sort().join(', ') || '(none)'}`);
}

console.log('\n-- outbox --');
for (const r of await db.select({ k: t.outboxEvents.state, n }).from(t.outboxEvents).groupBy(t.outboxEvents.state)) line(`outbox ${r.k}`, r.n);
for (const r of await db
  .select({ type: t.outboxEvents.eventType, state: t.outboxEvents.state, attempts: t.outboxEvents.attempts, next: t.outboxEvents.nextAttemptAt, err: t.outboxEvents.lastError })
  .from(t.outboxEvents)
  .where(sql`${t.outboxEvents.state} <> 'dispatched'`)
  .limit(50))
  console.log(`  ${r.state.padEnd(10)} ${r.type.padEnd(18)} attempts=${r.attempts}/8 next=${r.next.toISOString()} err=${r.err ?? '—'}`);

console.log('\n-- pipeline --');
const [contacts] = await db.select({ n }).from(t.contacts);
const [conversations] = await db.select({ n }).from(t.conversations);
const [messages] = await db.select({ n }).from(t.messages);
const [requests] = await db.select({ n }).from(t.requests);
const [intents] = await db.select({ n }).from(t.sendIntents);
line('contacts', contacts?.n ?? 0);
line('conversations', conversations?.n ?? 0);
line('messages', messages?.n ?? 0);
line('requests', requests?.n ?? 0);
line('send_intents', intents?.n ?? 0);
for (const r of await db.select({ k: t.requests.state, n }).from(t.requests).groupBy(t.requests.state)) line(`  request ${r.k}`, r.n);

console.log('\n-- recent audit --');
for (const r of await db.select({ a: t.auditLog.action, at: t.auditLog.createdAt, d: t.auditLog.diff }).from(t.auditLog).orderBy(desc(t.auditLog.createdAt)).limit(15))
  console.log(`  ${r.at.toISOString()} ${r.a} ${JSON.stringify(r.d ?? {})}`);

console.log('');
await h.close();
