import { Elysia } from 'elysia';

import { apiError } from '@/shared/api-response';

const statusByCode: Record<string, number> = {
  PARSE: 400,
  VALIDATION: 400,
};

// A body that is not the declared content type never reached the application's own
// rules, so its own message describes the parser rather than anything a caller can act
// on. Saying so plainly keeps a malformed request a client error, not a server fault.
const PARSE_MESSAGE = 'Malformed request body';

export const errorHandlerPlugin = new Elysia({ name: 'error-handler' }).onError(
  { as: 'global' },
  ({ code, error, set }) => {
    const codeName = String(code);
    const status = statusByCode[codeName] ?? 500;

    // Only client-safe codes forward their real message; anything else (including
    // arbitrary thrown Errors) gets a generic message so internals never leak.
    const message =
      codeName === 'VALIDATION' && error instanceof Error
        ? error.message
        : codeName === 'PARSE'
          ? PARSE_MESSAGE
          : 'Internal server error';

    if (status === 500 && error instanceof Error) {
      console.error(error);
    }

    set.status = status;

    return apiError(codeName, message);
  },
);
