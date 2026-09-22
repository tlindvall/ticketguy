import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Resend webhooks are Svix-signed: headers `svix-id`, `svix-timestamp`, `svix-signature`
 * ("v1,<base64>" entries, space separated); secret "whsec_<base64>"; signed content is
 * `${id}.${timestamp}.${rawBody}`. Verification runs on the raw bytes with a timestamp tolerance (A15).
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type WebhookVerification = { ok: true; id: string; timestamp: number } | { ok: false; reason: string };

export function verifySvixSignature(args: { rawBody: string | Uint8Array; headers: Record<string, string | undefined>; secret: string; now?: Date }): WebhookVerification {
  const id = args.headers['svix-id'];
  const ts = args.headers['svix-timestamp'];
  const sigHeader = args.headers['svix-signature'];
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_signature_headers' };
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  const nowSec = Math.floor((args.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp_outside_tolerance' };
  const secretB64 = args.secret.startsWith('whsec_') ? args.secret.slice(6) : args.secret;
  let key: Buffer;
  try {
    key = Buffer.from(secretB64, 'base64');
  } catch {
    return { ok: false, reason: 'invalid_secret' };
  }
  if (key.length === 0) return { ok: false, reason: 'invalid_secret' };
  const body = typeof args.rawBody === 'string' ? Buffer.from(args.rawBody, 'utf8') : Buffer.from(args.rawBody);
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), body]);
  const expected = createHmac('sha256', key).update(signed).digest();
  for (const entry of sigHeader.split(' ')) {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(value, 'base64');
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return { ok: true, id, timestamp };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/** Test/simulator helper: produce valid headers for a payload. Never used by production code paths. */
export function signSvix(args: { rawBody: string; secret: string; id: string; timestamp: number }): Record<string, string> {
  const secretB64 = args.secret.startsWith('whsec_') ? args.secret.slice(6) : args.secret;
  const key = Buffer.from(secretB64, 'base64');
  const sig = createHmac('sha256', key).update(`${args.id}.${args.timestamp}.${args.rawBody}`).digest('base64');
  return { 'svix-id': args.id, 'svix-timestamp': String(args.timestamp), 'svix-signature': `v1,${sig}` };
}
