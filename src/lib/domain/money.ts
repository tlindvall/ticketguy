/** Integer USD cents arithmetic and interpretation. The LLM never computes totals. */

export function assertCents(n: number, label = 'amount'): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${label} must be a non-negative integer number of cents, got ${n}`);
  return n;
}

export function formatUsd(cents: number): string {
  assertCents(cents);
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return `$${dollars.toLocaleString('en-US')}${rem === 0 ? '' : '.' + String(rem).padStart(2, '0')}`;
}

/** Whole-party cents are the source of truth; per-person is display only (rounded down to cents). */
export function perPersonCents(wholePartyCents: number, quantity: number): number {
  assertCents(wholePartyCents);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError('quantity must be positive');
  return Math.floor(wholePartyCents / quantity);
}

export type BudgetBasis = 'per_ticket' | 'whole_party';

/**
 * A01: "two tickets, $300 total" → whole-party 30000, never 60000.
 * Per-ticket budgets multiply by quantity; whole-party budgets are used as-is.
 * If the basis is unknown, we return null and the caller must clarify — never assume per-ticket.
 */
export function wholePartyBudgetCents(budgetCents: number | null, basis: BudgetBasis | null, quantity: number | null): number | null {
  if (budgetCents === null || basis === null) return null;
  assertCents(budgetCents, 'budget');
  if (basis === 'whole_party') return budgetCents;
  if (quantity === null) return null;
  return budgetCents * quantity;
}

/** Savings only exist against a verified comparable baseline; otherwise null. */
export function savingsCents(baselineTotalCents: number | null, candidateTotalCents: number | null): number | null {
  if (baselineTotalCents === null || candidateTotalCents === null) return null;
  assertCents(baselineTotalCents);
  assertCents(candidateTotalCents);
  return baselineTotalCents - candidateTotalCents;
}

/** Percent change as (current − baseline) / baseline; baseline must be positive. */
export function percentChange(baselineCents: number, currentCents: number): number {
  if (baselineCents <= 0) throw new RangeError('baseline must be positive');
  return (currentCents - baselineCents) / baselineCents;
}
