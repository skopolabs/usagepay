import { describe, expect, it } from 'vitest';
import { bigIntToDecimal, cumulativeChargeBaseUnits, decimalToBigInt } from '../src/index.js';

const PRICE_0_40_USDC_PER_KWH_7_DECIMALS = 4_000_000n;

describe('tariff arithmetic: floor(cumulativeWh * pricePerKwhBaseUnits / 1000) with bigint', () => {
  it.each([
    [250n, 1_000_000n],
    [500n, 2_000_000n],
    [750n, 3_000_000n],
  ])('S1: %s Wh cumulative at 0.40 USDC/kWh (7 decimals) -> %s base units', (wh, expected) => {
    expect(cumulativeChargeBaseUnits(wh, PRICE_0_40_USDC_PER_KWH_7_DECIMALS)).toBe(expected);
  });

  it('rounds once on the cumulative total, not per interval (no drift from summing floored deltas)', () => {
    const price = 3n; // 0.003 base units per Wh
    const perIntervalSum = [1n, 1n, 1n].reduce((sum, wh) => sum + cumulativeChargeBaseUnits(wh, price), 0n);
    expect(perIntervalSum).toBe(0n);
    expect(cumulativeChargeBaseUnits(1000n, price)).toBe(3n);
  });

  it('stays exact beyond Number.MAX_SAFE_INTEGER', () => {
    const wh = 10n ** 20n;
    expect(cumulativeChargeBaseUnits(wh, PRICE_0_40_USDC_PER_KWH_7_DECIMALS)).toBe(4n * 10n ** 23n);
  });

  it('F2 data: a 2,500,000 cap admits 2,000,000 but not 3,000,000', () => {
    const cap = 2_500_000n;
    expect(cumulativeChargeBaseUnits(500n, PRICE_0_40_USDC_PER_KWH_7_DECIMALS) <= cap).toBe(true);
    expect(cumulativeChargeBaseUnits(750n, PRICE_0_40_USDC_PER_KWH_7_DECIMALS) <= cap).toBe(false);
  });

  it('refuses negative inputs and non-canonical decimal strings', () => {
    expect(() => cumulativeChargeBaseUnits(-1n, 1n)).toThrow(RangeError);
    expect(() => bigIntToDecimal(-1n)).toThrow(RangeError);
    expect(() => decimalToBigInt('1.5')).toThrow();
    expect(decimalToBigInt('3000000')).toBe(3_000_000n);
  });
});
