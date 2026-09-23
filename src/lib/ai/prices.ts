/**
 * Model rates, in USD per million tokens. Dependency-free so both the env layer and the budget ledger
 * can use it without an import cycle.
 */
export type Price = { input: number; output: number };

/** Published rates checked on 2026-09-22. */
export const PRICES_USD_PER_MTOKEN: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * Unknown models bill at this rate: high enough that an unpriced model exhausts its budget early rather
 * than overspending silently. There are deliberately no OpenAI rows above — this codebase has never had
 * verified OpenAI pricing, and a guessed rate would under-reserve against the caps. Supply real rates via
 * MODEL_PRICES_USD_PER_MTOKEN.
 */
export const CONSERVATIVE_PRICE: Price = { input: 15, output: 75 };

/** `model=input:output` pairs, comma separated. A malformed entry is an error, never a silent skip. */
export function parsePriceOverrides(raw: string | undefined): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const part of (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^=]+)=([0-9]*\.?[0-9]+):([0-9]*\.?[0-9]+)$/.exec(part);
    if (!m) throw new Error(`MODEL_PRICES_USD_PER_MTOKEN entry must be "model=input:output", got "${part}"`);
    out[m[1]!.trim()] = { input: Number(m[2]), output: Number(m[3]) };
  }
  return out;
}

/**
 * Exact match only. A near-miss id such as 'claude-opus-5-5' is a model we have no published rate for, so
 * it falls through to the conservative default rather than inheriting 'claude-opus-5' pricing and
 * under-reporting spend against the budget caps.
 */
export function priceFor(model: string, overrides: Record<string, Price> = {}): Price {
  return overrides[model] ?? PRICES_USD_PER_MTOKEN[model] ?? CONSERVATIVE_PRICE;
}
