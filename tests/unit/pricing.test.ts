import { describe, expect, it } from 'vitest';
import { priceFor, estimateUsdMicros, PRICES_USD_PER_MTOKEN } from '@/lib/ai/budget';

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
