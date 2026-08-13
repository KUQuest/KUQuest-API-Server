export const MAX_WALLET_CAPACITY_SATANG = 2_000_000_000;
export const MAX_OPERATION_SATANG = 70_000_000;

export type Satang = number & { readonly __brand: 'Satang' };

export class MoneyDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MoneyDomainError';
    this.code = code;
  }
}

export const satang = (value: number): Satang => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_WALLET_CAPACITY_SATANG) {
    throw new MoneyDomainError('INVALID_SATANG', 'Satang must be a non-negative integer within the Wallet capacity.');
  }

  return value as Satang;
};

export const positiveSatang = (value: number): Satang => {
  const amount = satang(value);

  if (amount === 0) {
    throw new MoneyDomainError('INVALID_SATANG', 'Satang must be greater than zero.');
  }

  return amount;
};

export const addSatang = (left: Satang, right: Satang): Satang => {
  const total = left + right;

  if (total > MAX_WALLET_CAPACITY_SATANG) {
    throw new MoneyDomainError('SATANG_OVERFLOW', 'The Wallet capacity would be exceeded.');
  }

  return satang(total);
};
