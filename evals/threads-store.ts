/**
 * Real customer threads for replay (evals/production.ts), kept out of Braintrust: one gzipped JSON array, encrypted
 * with AES-256-GCM under EVAL_THREADS_KEY (a repository secret, 32 random bytes as base64), stored as the workflow
 * artifact "production-threads". The repository and its artifacts are public; without the key the file is noise,
 * and a wrong or changed key fails loudly instead of replaying garbage.
 *
 * File layout: "TGT1" | 12-byte IV | 16-byte auth tag | ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const MAGIC = Buffer.from('TGT1');

export function threadsKey(base64: string | undefined): Buffer {
  const key = Buffer.from((base64 ?? '').trim(), 'base64');
  if (key.length !== 32) throw new Error('EVAL_THREADS_KEY must be 32 random bytes, base64 (openssl rand -base64 32)');
  return key;
}

export function sealThreads(records: unknown[], key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify(records)))), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function openThreads<T = unknown>(file: Buffer, key: Buffer): T[] {
  if (file.length < 32 || !file.subarray(0, 4).equals(MAGIC)) throw new Error('not a production-threads file');
  const d = createDecipheriv('aes-256-gcm', key, file.subarray(4, 16));
  d.setAuthTag(file.subarray(16, 32));
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(file.subarray(32)), d.final()]);
  } catch {
    throw new Error('production-threads file does not open with EVAL_THREADS_KEY (wrong key, or the file was changed)');
  }
  return JSON.parse(gunzipSync(plain).toString('utf8')) as T[];
}
