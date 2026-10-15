/**
 * One-time move of the real customer threads out of Braintrust: reads the private dataset "production-threads"
 * (reading is free), drops what a replay doesn't use (the customer's email address and first name), and writes the
 * encrypted file evals/production.ts replays (evals/threads-store.ts). Run by .github/workflows/export-threads.yml,
 * which uploads the file as the "production-threads" artifact; eval runs then never touch Braintrust.
 *
 *   EVAL_THREADS_KEY=… BRAINTRUST_API_KEY=… tsx evals/export-threads-from-braintrust.ts [out-file]
 *
 * Prints counts only: the threads are private and Actions logs are public.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sealThreads, threadsKey } from './threads-store';

const BT = 'https://api.braintrust.dev/v1';
const out = process.argv[2] ?? '.eval-data/production-threads.enc';
const key = threadsKey(process.env.EVAL_THREADS_KEY);
if (!process.env.BRAINTRUST_API_KEY) throw new Error('BRAINTRUST_API_KEY is not set');

async function bt<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BT}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  // Large results come back as a 303 to a presigned URL that must be fetched without our auth header.
  if (res.status >= 300 && res.status < 400) return (await fetch(res.headers.get('location')!)).json() as Promise<T>;
  if (!res.ok) throw new Error(`braintrust ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

type Thread = { conversationId: string; inbound: Array<{ at: string }>; email?: unknown; firstName?: unknown } & Record<string, unknown>;
const projects = await bt<{ objects: Array<{ id: string }> }>(`/project?project_name=${encodeURIComponent(process.env.BRAINTRUST_PROJECT ?? 'My Project')}`);
const projectId = projects.objects[0]?.id;
if (!projectId) throw new Error('Braintrust project not found');
const sets = await bt<{ objects: Array<{ id: string }> }>(`/dataset?project_id=${projectId}&dataset_name=production-threads`);
const id = sets.objects[0]?.id;
if (!id) throw new Error('dataset production-threads not found');

const byConversation = new Map<string, Thread>();
let cursor: string | undefined;
do {
  const page = await bt<{ events: Array<{ input: Thread }>; cursor?: string }>(`/dataset/${id}/fetch`, { limit: 100, ...(cursor ? { cursor } : {}) });
  for (const e of page.events) {
    if (!e.input?.inbound?.length) continue;
    const { email: _email, firstName: _firstName, ...rest } = e.input;
    byConversation.set(rest.conversationId, rest as Thread);
  }
  cursor = page.events.length ? page.cursor : undefined;
} while (cursor);

const threads = [...byConversation.values()].sort((a, b) => a.inbound[0]!.at.localeCompare(b.inbound[0]!.at));
if (!threads.length) throw new Error('dataset production-threads has no threads');
mkdirSync(dirname(out), { recursive: true });
const file = sealThreads(threads, key);
writeFileSync(out, file);
console.log(`sealed ${threads.length} threads (${threads.reduce((n, t) => n + t.inbound.length, 0)} customer emails, ${(file.length / 1e6).toFixed(1)} MB)`);
