import { apiError } from '@/shared/api-response';

import { Elysia } from 'elysia';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value: string | undefined) => value !== undefined && uuidPattern.test(value);

type IdempotencyKeyScope =
  | 'quest-join'
  | 'candidate-selection'
  | 'quest-cancellation'
  | 'quest-dispute-resolution';

const pathNeedsIdempotencyKey = (scope: IdempotencyKeyScope, pathname: string) => {
  const parts = pathname.split('/');

  if (scope === 'quest-join') {
    const questId = parts[parts.length - 2];
    return pathname.endsWith('/join') && isUuid(questId);
  }

  if (scope === 'candidate-selection') {
    const questId = parts[parts.length - 4];
    const targetId = parts[parts.length - 2];
    return pathname.endsWith('/select') && isUuid(questId) && isUuid(targetId);
  }

  if (scope === 'quest-cancellation') {
    const questId = parts[parts.length - 2];
    return pathname.endsWith('/cancel') && isUuid(questId);
  }

  const questId = parts[parts.length - 3];
  return pathname.endsWith('/dispute/resolve') && isUuid(questId);
};

export const createQuestIdempotencyKeyGuard = (scope: IdempotencyKeyScope) => new Elysia({
  name: `${scope}-idempotency-key-guard`,
}).onRequest(({ request, set }) => {
  const pathname = new URL(request.url).pathname;
  if (!pathNeedsIdempotencyKey(scope, pathname)) return;

  if (request.headers.get('idempotency-key')?.trim()) return;

  set.status = 400;
  return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
});
