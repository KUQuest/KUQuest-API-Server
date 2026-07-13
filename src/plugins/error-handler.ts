import { Elysia } from 'elysia';

import { MoneyError, problem } from '@/modules/money/money.errors';

const traceIdFor = (request: Request): string =>
  request.headers.get('x-trace-id') ?? crypto.randomUUID();

export const errorHandlerPlugin = new Elysia({
  name: 'error-handler',
}).onError({ as: 'global' }, ({ code, error, request, set }) => {
  const traceId = traceIdFor(request);
  set.headers['content-type'] = 'application/problem+json';

  if (error instanceof MoneyError) {
    set.status = error.status;
    return problem(error.status, error.code, error.message, traceId);
  }

  if (code === 'VALIDATION') {
    set.status = 422;
    return problem(
      422,
      'VALIDATION_FAILED',
      'The request did not match the required schema.',
      traceId,
    );
  }

  console.error('Unhandled request error', { traceId, code, error });
  set.status = 500;
  return problem(
    500,
    'INTERNAL_ERROR',
    'An unexpected error occurred.',
    traceId,
  );
});
