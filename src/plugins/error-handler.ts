import { Elysia } from 'elysia';

import { apiError } from '@/shared/api-response';

const statusByCode: Record<string, number> = {
  VALIDATION: 400,
};

export const errorHandlerPlugin = new Elysia({ name: 'error-handler' }).onError(
  { as: 'global' },
  ({ code, error, set }) => {
    const codeName = String(code);
    const status = statusByCode[codeName] ?? 500;

    // Only client-safe codes forward their real message; anything else (including
    // arbitrary thrown Errors) gets a generic message so internals never leak.
    const message = codeName === 'VALIDATION' && error instanceof Error ? error.message : 'Internal server error';

    if (status === 500 && error instanceof Error) {
      console.error(error);
    }

    set.status = status;

    return apiError(codeName, message);
  },
);
