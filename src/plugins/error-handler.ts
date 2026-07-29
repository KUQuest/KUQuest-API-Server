import { Elysia } from 'elysia';

import { apiError } from '@/shared/api-response';

// Codes a client caused and may safely be told about. Everything absent from this map
// — including arbitrary thrown Errors — becomes a generic 500 so internals never leak.
// A code without its own `message` forwards the error's, which is already client-safe.
const clientErrors: Record<string, { status: number; message?: string }> = {
  VALIDATION: { status: 400 },
  PARSE: { status: 400, message: 'Malformed request body' },
};

export const errorHandlerPlugin = new Elysia({ name: 'error-handler' }).onError(
  { as: 'global' },
  ({ code, error, set }) => {
    const codeName = String(code);
    const clientError = clientErrors[codeName];

    const message = clientError
      ? (clientError.message ?? (error instanceof Error ? error.message : 'Internal server error'))
      : 'Internal server error';

    if (!clientError && error instanceof Error) {
      console.error(error);
    }

    set.status = clientError?.status ?? 500;

    return apiError(codeName, message);
  },
);
