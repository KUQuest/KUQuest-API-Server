import { Elysia } from 'elysia';

import {
  apiFailure,
  type ValidationIssue,
} from '@/http/api-response';
import { CsrfError } from '@/modules/auth';
import { MoneyError } from '@/modules/money/money.errors';
import { JobError } from '@/modules/jobs/job.errors';
import { DevelopmentTestError } from '@/modules/dev-test/dev-test.errors';

const validationIssues = (
  errors: Array<{ path?: string; summary?: string; message?: string }>,
): ValidationIssue[] =>
  errors.map((issue) => ({
    path: issue.path || '/',
    message:
      issue.summary || issue.message || 'The value did not match its schema.',
  }));

export const errorHandlerPlugin = new Elysia({
  name: 'error-handler',
}).onError({ as: 'global' }, ({ code, error, request, set, status }) => {
  set.headers['content-type'] = 'application/json; charset=utf-8';

  if (
    error instanceof MoneyError ||
    error instanceof JobError ||
    error instanceof DevelopmentTestError ||
    error instanceof CsrfError
  ) {
    return status(
      error.status,
      apiFailure(error.status, error.code, error.message, request),
    );
  }

  if (code === 'VALIDATION') {
    return status(
      422,
      apiFailure(
        422,
        'VALIDATION_FAILED',
        'The request did not match the required schema.',
        request,
        validationIssues(error.all),
      ),
    );
  }

  if (code === 'NOT_FOUND') {
    return status(
      404,
      apiFailure(
        404,
        'NOT_FOUND',
        'The requested resource was not found.',
        request,
      ),
    );
  }

  if (code === 'PARSE') {
    return status(
      400,
      apiFailure(
        400,
        'INVALID_REQUEST_BODY',
        'The request body could not be parsed.',
        request,
      ),
    );
  }

  const failure = apiFailure(
    500,
    'INTERNAL_ERROR',
    'An unexpected error occurred.',
    request,
  );
  console.error('Unhandled request error', {
    traceId: failure.trace_id,
    code,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return status(500, failure);
});
