export type ProblemCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'INSUFFICIENT_EARNINGS_BALANCE'
  | 'WALLET_FROZEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class MoneyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ProblemCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}
