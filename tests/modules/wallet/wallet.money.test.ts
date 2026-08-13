import { describe, expect, it } from 'bun:test';

import {
  addSatang,
  MoneyDomainError,
  positiveSatang,
  satang,
} from '@/modules/wallet';

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
});
