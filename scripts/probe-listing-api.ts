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
 * For SeatGeek set PROBE_SEATGEEK_CLIENT_ID and, optionally, PROBE_SEATGEEK_CLIENT_SECRET.
 * For StubHub set PROBE_STUBHUB_CLIENT_ID and PROBE_STUBHUB_CLIENT_SECRET (PROBE_STUBHUB_SANDBOX=1 for the
 * sandbox hosts). The probe exchanges them for an app-only token (client credentials, scope read:events) and
 * searches the catalog: per github.com/viagogo/stubhub-api-docs that is events, venues and a `min_ticket_price`,
 * not other sellers' listings — inventory, sales and webhooks are seller-account APIs.
 */
const TARGETS: Record<string, { envKey: string; url: string; headers: (secret: string) => Record<string, string>; docs: string }> = {
  stubhub: {
    envKey: 'PROBE_STUBHUB_CLIENT_ID',
    // The full name, not "Rangers", for the same reason as SeatGeek; parking passes are listed as events otherwise.
    url: '/catalog/events/search?q=New%20York%20Rangers&exclude_parking_passes=true&page_size=3',
    headers: (token) => ({ authorization: `Bearer ${token}`, accept: 'application/hal+json' }),
    docs: 'https://github.com/viagogo/stubhub-api-docs',
  },
  'ticket-evolution': {
    envKey: 'PROBE_TICKETEVOLUTION_TOKEN',
    url: 'https://api.ticketevolution.com/v9/events?q=Rangers&per_page=1',
    headers: (s) => ({ 'X-Token': s, accept: 'application/json' }),
    docs: 'https://developer.ticketevolution.com/',
  },
  seatgeek: {
    envKey: 'PROBE_SEATGEEK_CLIENT_ID',
    // A named performer, not a free-text query: "Rangers" also matches Texas. Three events so an empty `stats`
    // on one unlisted game is not mistaken for the account tier withholding the field.
    url: 'https://api.seatgeek.com/2/events?performers.slug=new-york-rangers&per_page=3',
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
const sandbox = process.env.PROBE_STUBHUB_SANDBOX === '1';
const hidden: string[] = [credential];

/**
 * StubHub's catalog takes a bearer token, not the client id. The token response is reported by key names,
 * granted scope and lifetime only; an unexpected scope is how an account that lacks read:events shows up.
 */
async function stubhubToken(clientId: string): Promise<string> {
  const clientSecret = process.env.PROBE_STUBHUB_CLIENT_SECRET;
  if (!clientSecret) {
    console.error('[probe] PROBE_STUBHUB_CLIENT_SECRET is not set. The client id alone cannot obtain a token.');
    process.exit(1);
  }
  hidden.push(clientSecret);
  const tokenUrl = `https://${sandbox ? 'sandbox.' : ''}account.stubhub.com/oauth2/token`;
  const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
  console.log(`[probe] POST ${tokenUrl} (client credentials, scope read:events)`);
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'read:events' }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.log(`[probe] token transport error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  }
  console.log(`[probe] token HTTP ${res.status}`);
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    console.log('[probe] token response is not JSON');
    process.exit(0);
  }
  console.log(`[probe] token response keys: ${Object.keys(body).sort().join(', ')}`);
  if (!res.ok || typeof body.access_token !== 'string') {
    // OAuth2 errors are `error` plus an optional `error_description`; both are provider text, not secrets.
    for (const k of ['error', 'error_description', 'message']) if (typeof body[k] === 'string') console.log(`[probe]   ${k} = ${String(body[k]).slice(0, 200)}`);
    process.exit(0);
  }
  console.log(`[probe]   scope = ${typeof body.scope === 'string' ? body.scope : typeof body.scope}, expires_in = ${typeof body.expires_in === 'number' ? body.expires_in : typeof body.expires_in}`);
  hidden.push(body.access_token);
  return body.access_token;
}

const bearer = name === 'stubhub' ? await stubhubToken(credential) : credential;
// SeatGeek authenticates by query parameter; the secret is optional there and sent only when provided.
const sgSecret = name === 'seatgeek' ? process.env.PROBE_SEATGEEK_CLIENT_SECRET : undefined;
if (sgSecret) hidden.push(sgSecret);
const url =
  name === 'seatgeek'
    ? `${target.url}&client_id=${encodeURIComponent(credential)}${sgSecret ? `&client_secret=${encodeURIComponent(sgSecret)}` : ''}`
    : name === 'stubhub'
      ? `https://${sandbox ? 'sandbox.' : ''}api.stubhub.net${target.url}`
      : target.url;
const redact = (u: string) => hidden.reduce<string>((acc, v) => acc.split(encodeURIComponent(v)).join('<redacted>').split(v).join('<redacted>'), u);
console.log(`[probe] GET ${redact(url)}${sgSecret ? ' (client_secret sent)' : ''}`);
let res: Response;
try {
  res = await fetch(url, { headers: target.headers(bearer), signal: AbortSignal.timeout(15_000) });
} catch (e) {
  console.log(`[probe] transport error: ${redact(e instanceof Error ? e.message : String(e))}`);
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
// HAL (StubHub) nests the page under `_embedded.items`; the others put an array at the top level.
const embedded = envelope._embedded as Record<string, unknown> | undefined;
const list = (Array.isArray(embedded?.items) ? embedded.items : Object.values(envelope).find((v) => Array.isArray(v))) as unknown[] | undefined;
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
// Whether price and inventory fields are populated decides what the source can ever feed: keys alone cannot tell
// a withheld field from an empty one. Types only (number / null / string), never the values.
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
for (const [i, item] of list.slice(0, 3).entries()) {
  const r = (item ?? {}) as Record<string, unknown>;
  const stats = r.stats as Record<string, unknown> | undefined;
  if (stats && typeof stats === 'object') {
    console.log(`[probe] item ${i + 1} stats: ${Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${typeOf(v)}`).join(', ')}`);
  }
  // StubHub: a get-in price per event and a link to its page are the whole of what the catalog can feed.
  const minPrice = r.min_ticket_price as Record<string, unknown> | null | undefined;
  const links = r._links as Record<string, unknown> | undefined;
  if (name === 'stubhub') {
    const amount = minPrice && typeof minPrice === 'object' ? typeOf(minPrice.amount) : typeOf(minPrice);
    console.log(`[probe] item ${i + 1} min_ticket_price.amount=${amount}, currency_code=${typeOf(minPrice?.currency_code)}, status=${typeOf(r.status)}, event:webpage=${links && 'event:webpage' in links ? 'present' : 'absent'}`);
  }
}
