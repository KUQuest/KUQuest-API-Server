import {
  addSatang,
  MoneyDomainError,
  positiveSatang,
  satang,
  satangDelta,
  signedSatang,
} from '@/modules/wallet';

import { describe, expect, it } from 'bun:test';

describe('Satang', () => {
  it('accepts exact integer satang and rejects fractional or negative values', () => {
    expect(satang(125)).toBe(satang(125));
    expect(() => satang(1.5)).toThrow(MoneyDomainError);
    expect(() => satang(-1)).toThrow(MoneyDomainError);
  });

  it('rejects zero for positive amounts and protects the Wallet capacity', () => {
    expect(() => positiveSatang(0)).toThrow(MoneyDomainError);
    expect(() => addSatang(satang(2_000_000_000), satang(1))).toThrow(MoneyDomainError);
  });

  it('validates signed ledger posting amounts', () => {
    expect(Number(signedSatang(125))).toBe(125);
    expect(Number(signedSatang(-125))).toBe(-125);
    expect(() => signedSatang(0)).toThrow(MoneyDomainError);
    expect(() => signedSatang(1.5)).toThrow(MoneyDomainError);
    expect(() => signedSatang(-2_000_000_001)).toThrow(MoneyDomainError);
  });

  it('validates signed activity deltas including zero', () => {
    expect(Number(satangDelta(0))).toBe(0);
    expect(Number(satangDelta(-125))).toBe(-125);
    expect(() => satangDelta(1.5)).toThrow(MoneyDomainError);
    expect(() => satangDelta(2_000_000_001)).toThrow(MoneyDomainError);
  });
});
