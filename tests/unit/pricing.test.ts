import { describe, expect, it } from 'vitest';
import { priceFor, estimateUsdMicros, parsePriceOverrides, PRICES_USD_PER_MTOKEN, CONSERVATIVE_PRICE } from '@/lib/ai/budget';

describe('model pricing', () => {
  it('prices the models we actually run', () => {
    expect(priceFor('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(priceFor('claude-sonnet-5')).toEqual({ input: 2, output: 10 });
    expect(priceFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5 });
  });
  it('never bills a longer model id at a shorter prefix rate', () => {
    // 'claude-opus-5-5' must not silently inherit the 'claude-opus-5' row.
    expect(priceFor('claude-opus-5-5')).not.toEqual(PRICES_USD_PER_MTOKEN['claude-opus-5']);
    expect(priceFor('claude-opus-5-5')).toEqual({ input: 15, output: 75 });
    expect(priceFor('some-unreleased-model')).toEqual({ input: 15, output: 75 });
  });
  it('estimates a request in integer USD micros', () => {
    // 12k input + 700 output on Opus 5 = 12000/1e6*5 + 700/1e6*25 = $0.0775
    expect(estimateUsdMicros('claude-opus-5', 12_000, 700)).toBe(77_500);
    expect(estimateUsdMicros('claude-sonnet-5', 12_000, 700)).toBe(31_000);
  });
});

describe('operator price overrides', () => {
  it('layers over the built-in table and supplies rates for unpriced models', () => {
    const o = parsePriceOverrides('gpt-5.5=1.25:10,claude-opus-5=6:30');
    expect(priceFor('gpt-5.5', o)).toEqual({ input: 1.25, output: 10 });
    expect(priceFor('claude-opus-5', o)).toEqual({ input: 6, output: 30 }); // override wins
    expect(priceFor('claude-sonnet-5', o)).toEqual({ input: 2, output: 10 }); // untouched
  });

  it('bills an unpriced model conservatively rather than cheaply', () => {
    // No OpenAI rates ship with the code, so without an override the cap is reached early, not overrun.
    expect(priceFor('gpt-5.5')).toEqual(CONSERVATIVE_PRICE);
    expect(CONSERVATIVE_PRICE.input).toBeGreaterThan(Math.max(...Object.values(PRICES_USD_PER_MTOKEN).map((p) => p.input)));
  });

  it('treats a malformed entry as an error, never a silent skip', () => {
    expect(() => parsePriceOverrides('gpt-5.5=1.25')).toThrow(/model=input:output/);
    expect(() => parsePriceOverrides('gpt-5.5:1.25:10')).toThrow();
  });

  it('accepts an empty or absent value', () => {
    expect(parsePriceOverrides(undefined)).toEqual({});
    expect(parsePriceOverrides('')).toEqual({});
  });
});
