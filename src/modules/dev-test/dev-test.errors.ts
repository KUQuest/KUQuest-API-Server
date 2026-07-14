export class DevelopmentTestError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 422,
    readonly code:
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'VALIDATION_FAILED'
      | 'DEVELOPMENT_FEATURE_DISABLED',
    message: string,
  ) {
    super(message);
    this.name = 'DevelopmentTestError';
  }
}
