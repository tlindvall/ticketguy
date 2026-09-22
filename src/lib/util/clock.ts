import { randomUUID } from 'node:crypto';

/** Server-side time/ID helpers kept out of React render bodies (react-hooks/purity). */
export function nowMs(): number {
  return Date.now();
}
export function newIdempotencyKey(prefix = 'ui'): string {
  return `${prefix}-${randomUUID()}`;
}
