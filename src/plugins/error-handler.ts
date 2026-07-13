import { Elysia } from 'elysia';

import { CsrfError } from '@/modules/auth';
import { MoneyError, problem } from '@/modules/money/money.errors';

const traceIdFor = (request: Request): string =>
  request.headers.get('x-trace-id') ?? crypto.randomUUID();

export const errorHandlerPlugin = new Elysia({
  name: 'error-handler',
}).onError({ as: 'global' }, ({ code, error, request, set, status }) => {
  const traceId = traceIdFor(request);
  set.headers['content-type'] = 'application/problem+json';

  if (error instanceof MoneyError || error instanceof CsrfError) {
    return status(
      error.status,
      problem(error.status, error.code, error.message, traceId),
    );
  }

  if (code === 'VALIDATION') {
    return status(
      422,
      problem(
        422,
        'VALIDATION_FAILED',
        'The request did not match the required schema.',
        traceId,
      ),
    );
  }

  if (code === 'NOT_FOUND') {
    return status(
      404,
      problem(404, 'NOT_FOUND', 'The requested resource was not found.', traceId),
    );
  }

  console.error('Unhandled request error', {
    traceId,
    code,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return status(
    500,
    problem(
      500,
      'INTERNAL_ERROR',
      'An unexpected error occurred.',
      traceId,
    ),
  );
});
