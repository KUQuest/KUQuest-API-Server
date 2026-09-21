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

/**
 * Reads and validates the Idempotency-Key header for a Quest Command.
 * Sets status 400 and returns an ApiError when the header is missing or blank;
 * returns the non-empty trimmed key string on success.
 */
export const requireQuestCommandId = (
  request: Request | undefined,
  set: AuthedContext['set']
): string | ApiError => {
  const commandId = request?.headers.get('idempotency-key');
  if (commandId?.trim()) return commandId;
  set.status = 400;
  return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
};
