import { Elysia } from 'elysia';

import { apiError } from '@/shared/api-response';

const statusByCode: Record<string, number> = {
  VALIDATION: 400,
};

export const errorHandlerPlugin = new Elysia({ name: 'error-handler' }).onError(
  { as: 'global' },
  ({ code, error, set }) => {
    const codeName = String(code);
    const message = error instanceof Error ? error.message : codeName;

    set.status = statusByCode[codeName] ?? 500;

    return apiError(codeName, message);
  },
);
