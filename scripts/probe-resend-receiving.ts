/**
 * Read-only probe of Resend's received-email list endpoint
 * (`pnpm tsx scripts/probe-resend-receiving.ts`).
 *
 * The reconciliation sweep needs to enumerate received mail, and the documentation is not reachable from
 * the environment this was written in. Guessing a response shape straight into a cron job is how the
 * retrieval call spent a day returning an unexplained 401, so this prints what the endpoint actually
 * returns and the sweep is written against that.
 *
 * It prints structure, not content: HTTP status, the envelope's key names, how many items came back, each
 * item's key names, and only the id and timestamp values — never a sender, recipient, subject or body, and
 * never the API key.
 */
import { env } from '../src/lib/config/env';

const e = env();
if (!e.RESEND_API_KEY) {
  console.error('[probe] RESEND_API_KEY is not set in this environment.');
  process.exit(1);
}

const SAFE_VALUE_KEYS = new Set(['id', 'email_id', 'created_at', 'received_at', 'object', 'has_more']);

async function probe(path: string): Promise<void> {
  const url = `https://api.resend.com${path}`;
  console.log(`\n=== GET ${path} ===`);
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${e.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    console.log(`transport error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  console.log(`HTTP ${res.status}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    console.log(`non-JSON body, ${text.length} bytes, starts: ${JSON.stringify(text.slice(0, 120))}`);
    return;
  }
  if (!res.ok) {
    const err = body as { name?: unknown; message?: unknown };
    console.log(`error name=${String(err.name ?? '—')} message=${String(err.message ?? '—').slice(0, 200)}`);
    return;
  }
  const envelope = body as Record<string, unknown>;
  console.log(`envelope keys: ${Object.keys(envelope).sort().join(', ')}`);
  for (const [k, v] of Object.entries(envelope)) {
    if (SAFE_VALUE_KEYS.has(k) && (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')) console.log(`  ${k} = ${String(v)}`);
  }
  const items = Array.isArray(envelope.data) ? envelope.data : Array.isArray(body) ? (body as unknown[]) : null;
  if (!items) {
    console.log('no array of items found on this response');
    return;
  }
  console.log(`items: ${items.length}`);
  const first = items[0] as Record<string, unknown> | undefined;
  if (first) console.log(`item keys: ${Object.keys(first).sort().join(', ')}`);
  for (const item of items.slice(0, 10)) {
    const r = item as Record<string, unknown>;
    const parts = [...SAFE_VALUE_KEYS].filter((k) => r[k] !== undefined).map((k) => `${k}=${String(r[k])}`);
    console.log(`  ${parts.join(' ') || '(no id or timestamp field)'}`);
  }
}

await probe('/emails/receiving?limit=10');
console.log('');
