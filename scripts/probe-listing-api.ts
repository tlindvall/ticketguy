/**
 * Read-only probe of a candidate listing API, run once after partner credentials arrive
 * (`pnpm tsx scripts/probe-listing-api.ts <stubhub|ticket-evolution|seatgeek>`).
 *
 * No listing adapter is written until this has been run against the real service: an adapter written from
 * documentation alone is a guess about a payload, and the retrieval call that spent a day returning an
 * unexplained 401 is what a guess costs. The probe prints structure, not content — the HTTP status or the
 * provider's error envelope, the top-level key names, the item count and the first item's key names. It
 * never prints the credential.
 *
 * Credentials are read from the environment under the names below. Nothing here is enabled or stored;
 * the adapter row, approval evidence and limits are still entered in /admin/sources afterwards.
 */
const TARGETS: Record<string, { envKey: string; url: string; headers: (secret: string) => Record<string, string>; docs: string }> = {
  stubhub: {
    envKey: 'PROBE_STUBHUB_TOKEN',
    url: 'https://api.stubhub.com/sellers/search/events/v3?q=Rangers&rows=1',
    headers: (s) => ({ authorization: `Bearer ${s}` }),
    docs: 'https://developer.stubhub.com/',
  },
  'ticket-evolution': {
    envKey: 'PROBE_TICKETEVOLUTION_TOKEN',
    url: 'https://api.ticketevolution.com/v9/events?q=Rangers&per_page=1',
    headers: (s) => ({ 'X-Token': s, accept: 'application/json' }),
    docs: 'https://developer.ticketevolution.com/',
  },
  seatgeek: {
    envKey: 'PROBE_SEATGEEK_CLIENT_ID',
    url: 'https://api.seatgeek.com/2/events?q=Rangers&per_page=1',
    headers: () => ({ accept: 'application/json' }),
    docs: 'https://platform.seatgeek.com/',
  },
};

export {};

const name = process.argv[2] ?? '';
const target = TARGETS[name];
if (!target) {
  console.error(`usage: probe-listing-api.ts <${Object.keys(TARGETS).join('|')}>`);
  process.exit(1);
}
const secret = process.env[target.envKey];
if (!secret) {
  console.error(`[probe] ${target.envKey} is not set. Obtain credentials from ${target.docs} and export them for this shell only.`);
  process.exit(1);
}
const credential: string = secret;
const url = name === 'seatgeek' ? `${target.url}&client_id=${encodeURIComponent(credential)}` : target.url;
console.log(`[probe] GET ${url.replace(credential, '<redacted>')}`);
let res: Response;
try {
  res = await fetch(url, { headers: target.headers(credential), signal: AbortSignal.timeout(15_000) });
} catch (e) {
  console.log(`[probe] transport error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
}
console.log(`[probe] HTTP ${res.status}`);
const text = await res.text();
let body: unknown;
try {
  body = JSON.parse(text);
} catch {
  console.log(`[probe] non-JSON body, ${text.length} bytes`);
  process.exit(0);
}
if (!res.ok) {
  const err = body as Record<string, unknown>;
  console.log(`[probe] error keys: ${Object.keys(err).join(', ')}`);
  for (const k of ['error', 'message', 'code', 'name', 'status']) if (typeof err[k] === 'string') console.log(`[probe]   ${k} = ${String(err[k]).slice(0, 200)}`);
  process.exit(0);
}
const envelope = body as Record<string, unknown>;
console.log(`[probe] envelope keys: ${Object.keys(envelope).sort().join(', ')}`);
const list = Object.values(envelope).find((v) => Array.isArray(v)) as unknown[] | undefined;
if (!list) {
  console.log('[probe] no array found at the top level');
  process.exit(0);
}
console.log(`[probe] items: ${list.length}`);
const first = list[0] as Record<string, unknown> | undefined;
if (first) {
  console.log(`[probe] first item keys: ${Object.keys(first).sort().join(', ')}`);
  for (const [k, v] of Object.entries(first)) if (v && typeof v === 'object' && !Array.isArray(v)) console.log(`[probe]   ${k} keys: ${Object.keys(v as object).sort().join(', ')}`);
}
