import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';

import type { QuestV2RewardAllocationRequest } from './quest-v2-reward-allocation.schema';
import {
  getQuestV2RewardAllocation,
  submitQuestV2RewardAllocation,
  type QuestV2RewardAllocationOutcome,
} from './quest-v2-reward-allocation.service';
import {
  mapQuestCommandOutcome,
  requireQuestCommandId,
} from '../../shared/command/quest-command.controller';

const mapAllocationError = (set: AuthedContext['set'], outcome: string) => {
  if (outcome === 'not-found' || outcome === 'not-authorized') {
    set.status = 404;
    return apiError('TEAM_REWARD_ALLOCATION_NOT_FOUND', 'Team Reward Allocation not found');
  }
  if (outcome === 'not-leader') {
    set.status = 403;
    return apiError(
      'TEAM_REWARD_ALLOCATION_NOT_AUTHORIZED',
      'Only the Team Leader can submit an allocation'
    );
  }
  if (outcome === 'deadline-passed') {
    set.status = 409;
    return apiError('TEAM_REWARD_ALLOCATION_EXPIRED', 'The allocation deadline has passed');
  }
  if (outcome === 'invalid-allocation') {
    set.status = 400;
    return apiError(
      'TEAM_REWARD_ALLOCATION_INVALID',
      'Team percentages must cover each teammate and total no more than 100 percent'
    );
  }
  set.status = 409;
  return apiError(
    'TEAM_REWARD_ALLOCATION_NOT_READY',
    'The completed Candidate Team is not waiting for a Reward Allocation'
  );
};

export const getQuestV2RewardAllocationController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: { questId: string } }) => {
  const result = await getQuestV2RewardAllocation(session.user.id, params.questId);
  if ('outcome' in result) return mapAllocationError(set, result.outcome);
  return apiSuccess({
    ...result,
    deadlineAt: result.deadlineAt.toISOString(),
    settledAt: result.settledAt?.toISOString() ?? null,
  });
};

export const submitQuestV2RewardAllocationController = async ({
  params,
  request,
  session,
  body,
  set,
}: AuthedContext & { params: { questId: string }; body: QuestV2RewardAllocationRequest }) => {
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await submitQuestV2RewardAllocation(
    session.user.id,
    params.questId,
    body,
    commandId
  );
  if ('outcome' in result) {
    if (
      result.outcome === 'idempotency-key-reused' ||
      result.outcome === 'idempotency-in-progress' ||
      result.outcome === 'idempotency-unavailable' ||
      result.outcome === 'invalid-idempotency-key'
    ) {
      return mapQuestCommandOutcome(set, result.outcome);
    }
    return mapAllocationError(set, result.outcome);
  }
  if ('kind' in result) {
    if (result.kind === 'rejected') return mapAllocationError(set, result.rejection);
    const allocation = await getQuestV2RewardAllocation(session.user.id, params.questId);
    if ('outcome' in allocation) return mapAllocationError(set, allocation.outcome);
    return apiSuccess({
      ...allocation,
      deadlineAt: allocation.deadlineAt.toISOString(),
      settledAt: allocation.settledAt?.toISOString() ?? null,
    });
  }
  return apiSuccess(result);
};

export type QuestV2RewardAllocationControllerOutcome = QuestV2RewardAllocationOutcome;
