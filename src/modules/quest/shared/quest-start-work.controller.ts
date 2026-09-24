import type { AuthedContext } from '@/modules/auth';
import { apiError } from '@/shared/api-response';

import { mapQuestCommandOutcome } from './command/quest-command.controller';
import type { QuestStartWorkOutcome } from './quest-start-work.service';

type QuestStartWorkError = Exclude<QuestStartWorkOutcome, { questId: string }>;

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

export const mapQuestStartWorkOutcome = (
  set: AuthedContext['set'],
  outcome: QuestStartWorkError
) => {
  if (outcome.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome.outcome === 'not-authorized') {
    return conflict(
      set,
      'ASSIGNMENT_NOT_FOUND',
      'The Worker has no active Assignment on this Quest'
    );
  }
  if (outcome.outcome === 'not-required-starter') {
    return conflict(
      set,
      'START_WORK_NOT_REQUIRED',
      'Only the required starter can start this Quest'
    );
  }
  if (outcome.outcome === 'start-window-not-open') {
    return conflict(set, 'START_WORK_NOT_AVAILABLE', 'Start Work is available from startTime');
  }
  if (outcome.outcome === 'start-window-closed') {
    return conflict(set, 'START_WORK_DEADLINE_PASSED', 'The Start Work deadline has passed');
  }
  if (outcome.outcome === 'already-started') {
    return conflict(set, 'START_WORK_ALREADY_RECORDED', 'Start Work was already recorded');
  }
  if (outcome.outcome === 'not-assigned') {
    return conflict(set, 'QUEST_NOT_ASSIGNED', 'Start Work requires an assigned Quest');
  }
  if (outcome.outcome === 'not-contract') {
    return conflict(
      set,
      'QUEST_NOT_SUPPORTED',
      'The Quest does not have a valid Start Work roster'
    );
  }
  return mapQuestCommandOutcome(set, outcome.outcome);
};
