import type { AuthedContext } from '@/modules/auth';
import { apiError, type ApiError } from '@/shared/api-response';

import type { QuestCommandOutcomeCode } from './quest-command.service';

/**
 * Maps a Quest Command outcome to the shared error response. A missing
 * Idempotency-Key stays the controller's own IDEMPOTENCY_KEY_REQUIRED check;
 * this mapper answers for a key that reached the Quest Command module.
 */
export const mapQuestCommandOutcome = (
  set: AuthedContext['set'],
  outcome: QuestCommandOutcomeCode,
  inProgressMessage = 'The Idempotency-Key is still processing'
): ApiError => {
  if (outcome === 'idempotency-key-reused') {
    set.status = 409;
    return apiError(
      'IDEMPOTENCY_KEY_REUSED',
      'The Idempotency-Key was used for a different request'
    );
  }
  if (outcome === 'idempotency-in-progress') {
    set.status = 409;
    return apiError('IDEMPOTENCY_IN_PROGRESS', inProgressMessage);
  }
  if (outcome === 'idempotency-unavailable') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'The Idempotency-Key result is unavailable');
  }
  set.status = 400;
  return apiError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must not be empty');
};
