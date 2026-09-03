import { apiError } from '@/shared/api-response';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value: string | undefined) => value !== undefined && uuidPattern.test(value);

type IdempotencyKeyScope =
  | 'quest-join'
  | 'candidate-selection'
  | 'candidate-application-v2'
  | 'candidate-team-v2'
  | 'proof-submission-v2'
  | 'quest-cancellation'
  | 'quest-dispute-resolution';

const pathNeedsIdempotencyKey = (scope: IdempotencyKeyScope, pathname: string, method: string) => {
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

  if (scope === 'candidate-application-v2') {
    if (!pathname.startsWith(`${API_V2_PREFIX}/quests/`)) return false;
    if (method !== 'POST') return false;
    const questId = parts[parts.length - 4];
    const applicationId = parts[parts.length - 2];
    return (
      (pathname.endsWith('/applications') && isUuid(parts[4])) ||
      (pathname.endsWith('/withdraw') && isUuid(questId) && isUuid(applicationId)) ||
      (pathname.endsWith('/select') && isUuid(questId) && isUuid(applicationId))
    );
  }

  if (scope === 'candidate-team-v2') {
    if (!pathname.startsWith(`${API_V2_PREFIX}/quests/`)) return false;
    if (!isUuid(parts[4]) || parts[5] !== 'teams') return false;
    if (method === 'POST' && parts.length === 6) return true;
    if (method === 'PATCH' && parts.length === 7) {
      return isUuid(parts[6]);
    }
    if (method === 'POST' && parts.length === 8) {
      return isUuid(parts[6]) && ['join', 'join-code', 'leave', 'select', 'submit'].includes(parts[7]!);
    }
    return method === 'DELETE' &&
      parts.length === 9 &&
      isUuid(parts[6]) &&
      parts[7] === 'members' &&
      isUuid(parts[8]);
  }

  if (scope === 'proof-submission-v2') {
    if (!pathname.startsWith(`${API_V2_PREFIX}/quests/`)) return false;
    if (!isUuid(parts[4])) return false;
    if (method === 'POST' && parts.length === 6 && parts[5] === 'proof-submissions') return true;
    if ((method === 'PATCH' || method === 'DELETE') && parts.length === 7 && parts[5] === 'proof-submissions') {
      return isUuid(parts[6]);
    }
    if (method === 'POST' && parts.length === 8 && parts[5] === 'proof-submissions') {
      return isUuid(parts[6]) && ['submit', 'review'].includes(parts[7]!);
    }
    return method === 'POST' && parts.length === 6 && parts[5] === 'completion-confirmation';
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
  if (!pathNeedsIdempotencyKey(scope, pathname, request.method)) return;

  if (request.headers.get('idempotency-key')?.trim()) return;

  set.status = 400;
  return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
});
