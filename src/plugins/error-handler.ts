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
  ({ code, error, request, set }) => {
    if (
      code === 'VALIDATION' &&
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'headers'
    ) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('/idempotency-key')) {
        const pathname = new URL(request.url).pathname;
        const questMatch = pathname.match(/\/quests\/([^/]+)/);
        const questSegment = questMatch?.[1];
        const isSpecialSegment =
          questSegment === 'mine' ||
          questSegment === 'board' ||
          questSegment === 'invitations' ||
          questSegment === 'edit-requests';
        const isInvalidUuidParam =
          questSegment !== undefined &&
          !isSpecialSegment &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(questSegment);

        const isLegacyGuardedPath =
          pathname.endsWith('/join') ||
          pathname.includes('/applications') ||
          pathname.includes('/teams') ||
          pathname.includes('/proof-submissions') ||
          pathname.includes('/completion-confirmation') ||
          pathname.includes('/reviews') ||
          pathname.includes('/edit-requests') ||
          pathname.endsWith('/cancel') ||
          pathname.endsWith('/select');
        if (!isInvalidUuidParam && isLegacyGuardedPath) {
          set.status = 400;
          const headerVal = request.headers.get('idempotency-key');
          if (headerVal === null || headerVal.trim() === '') {
            return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
          }
          return apiError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must not be empty');
        }
      }
    }
    const codeName = String(code);
    const clientError = clientErrors[codeName];
    const isV2Request = new URL(request.url).pathname.startsWith('/api/v2/');
    const responseCode = !clientError && isV2Request ? 'INTERNAL_ERROR' : codeName;

    const message = clientError
      ? (clientError.message ?? (error instanceof Error ? error.message : 'Internal server error'))
      : 'Internal server error';

    if (!clientError && error instanceof Error) {
      console.error(error);
    }

    set.status = clientError?.status ?? 500;

    return apiError(responseCode, message);
  }
);
