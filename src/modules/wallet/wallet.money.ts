export const MAX_WALLET_CAPACITY_SATANG = 2_000_000_000;
export const MAX_OPERATION_SATANG = 70_000_000;

export type Satang = number & { readonly __brand: 'Satang' };
export type SatangDelta = number & { readonly __brand: 'SatangDelta' };
export type SignedSatang = number & { readonly __brand: 'SignedSatang' };

export type MoneyDomainErrorCode =
  | 'AMOUNT_OUT_OF_RANGE'
  | 'FUNDING_RESERVATION_CAPACITY_EXCEEDED'
  | 'FUNDING_RESERVATION_EXISTS'
  | 'FUNDING_RESERVATION_INSUFFICIENT'
  | 'FUNDING_RESERVATION_NOT_ACTIVE'
  | 'FUNDING_RESERVATION_NOT_FOUND'
  | 'FUNDING_SETTLEMENT_FAILED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_UNAVAILABLE'
  | 'INVALID_LEDGER_BALANCE'
  | 'INVALID_LEDGER_POSTINGS'
  | 'INVALID_CALLER_REFERENCE'
  | 'INVALID_LIMIT'
  | 'INVALID_SATANG'
  | 'LEDGER_CREATE_FAILED'
  | 'POLICY_NOT_AVAILABLE'
  | 'POLICY_OVERLAP'
  | 'PLATFORM_FEE_MISMATCH'
  | 'SATANG_OVERFLOW'
  | 'STUDENT_NOT_FOUND'
  | 'UNBALANCED_LEDGER'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ACCOUNT_NOT_FOUND'
  | 'WALLET_CAPACITY_EXCEEDED'
  | 'WALLET_NOT_ACTIVE'
  | 'INSUFFICIENT_SPENDING_BALANCE'
  | 'WALLET_PROVISION_FAILED';

export class MoneyDomainError extends Error {
  readonly code: MoneyDomainErrorCode;

  constructor(code: MoneyDomainErrorCode, message: string) {
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

export const signedSatang = (value: number): SignedSatang => {
  if (
    !Number.isSafeInteger(value) ||
    value === 0 ||
    Math.abs(value) > MAX_WALLET_CAPACITY_SATANG
  ) {
    throw new MoneyDomainError(
      'INVALID_SATANG',
      'Signed Satang must be a non-zero integer within the Wallet capacity.',
    );
  }

  return value as SignedSatang;
};

export const satangDelta = (value: number): SatangDelta => {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_WALLET_CAPACITY_SATANG) {
    throw new MoneyDomainError(
      'INVALID_SATANG',
      'A Satang delta must be an integer within the Wallet capacity.',
    );
  }

  return value as SatangDelta;
};

export const addSatang = (left: Satang, right: Satang): Satang => {
  const total = left + right;

  if (total > MAX_WALLET_CAPACITY_SATANG) {
    throw new MoneyDomainError('SATANG_OVERFLOW', 'The Wallet capacity would be exceeded.');
  }

  return satang(total);
};
