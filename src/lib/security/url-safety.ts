import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

/**
 * URL safety (A23): HTTPS only; no credentials, IP literals, localhost/private/link-local/reserved/metadata
 * destinations; every redirect hop is revalidated; DNS answers are checked before connecting.
 */
export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

export function isPrivateOrReservedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reserved/broadcast
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateOrReservedIp(lower.slice(7));
    if (lower.startsWith('fec0')) return true;
    return false;
  }
  return true;
}

export function validateUrlSyntax(input: string, opts: { allowedHosts?: string[] | null } = {}): UrlVerdict {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'non_https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'unsupported_port' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return { ok: false, reason: 'blocked_hostname' };
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return { ok: false, reason: 'ip_literal' };
  if (opts.allowedHosts && !opts.allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase()))) return { ok: false, reason: 'host_not_allowlisted' };
  return { ok: true, url };
}

/** Resolves DNS and rejects if any answer is private/reserved. */
export async function validateUrlDestination(url: URL, resolver: (host: string) => Promise<string[]> = defaultResolver): Promise<UrlVerdict> {
  let addrs: string[];
  try {
    addrs = await resolver(url.hostname);
  } catch {
    return { ok: false, reason: 'dns_failure' };
  }
  if (addrs.length === 0) return { ok: false, reason: 'dns_no_answer' };
  if (addrs.some(isPrivateOrReservedIp)) return { ok: false, reason: 'resolves_to_private_address' };
  return { ok: true, url };
}

async function defaultResolver(host: string): Promise<string[]> {
  const res = await dns.lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
}

export type SafeFetchResult = { ok: true; response: Response; finalUrl: URL; hops: string[] } | { ok: false; reason: string; hops: string[] };

/**
 * Bounded fetcher used only for allowlisted seller/provider hosts. Follows redirects manually,
 * re-validating syntax and destination at every hop. Never forwards credentials.
 */
export async function safeFetch(input: string, opts: { allowedHosts?: string[] | null; maxRedirects?: number; timeoutMs?: number; resolver?: (h: string) => Promise<string[]>; fetchImpl?: typeof fetch } = {}): Promise<SafeFetchResult> {
  const hops: string[] = [];
  let current = input;
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (let i = 0; i <= (opts.maxRedirects ?? 3); i++) {
    const syn = validateUrlSyntax(current, { allowedHosts: opts.allowedHosts ?? null });
    if (!syn.ok) return { ok: false, reason: `hop_${i}_${syn.reason}`, hops };
    const dest = await validateUrlDestination(syn.url, opts.resolver);
    if (!dest.ok) return { ok: false, reason: `hop_${i}_${dest.reason}`, hops };
    hops.push(syn.url.toString());
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
    let res: Response;
    try {
      res = await fetchImpl(syn.url, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'TicketGuy/0.1 (+https://ticketguy.live)' } });
    } catch {
      clearTimeout(t);
      return { ok: false, reason: `hop_${i}_fetch_failed`, hops };
    }
    clearTimeout(t);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, reason: `hop_${i}_redirect_without_location`, hops };
      current = new URL(loc, syn.url).toString();
      continue;
    }
    return { ok: true, response: res, finalUrl: syn.url, hops };
  }
  return { ok: false, reason: 'too_many_redirects', hops };
}
