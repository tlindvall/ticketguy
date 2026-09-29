import { describe, expect, it } from 'vitest';
import { formatUsd, formatUsdChange } from '@/lib/domain/money';

describe('formatUsdChange', () => {
  it('signs a fall and a rise; formatUsd alone refuses a fall', () => {
    expect(formatUsdChange(-850)).toBe('-$8.50');
    expect(formatUsdChange(1200)).toBe('+$12');
    expect(formatUsdChange(0)).toBe('+$0');
    expect(() => formatUsd(-850)).toThrow(RangeError);
  });
});
