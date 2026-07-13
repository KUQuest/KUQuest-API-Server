export type ProblemCode =
  | 'UNAUTHORIZED'
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

export const problem = (
  status: number,
  code: ProblemCode,
  detail: string,
  traceId: string,
) => ({
  type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
  title: code
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' '),
  status,
  code,
  detail,
  trace_id: traceId,
});
