import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';

import {
  mapQuestCommandOutcome,
  requireQuestCommandId,
} from '../shared/command/quest-command.controller';
import type { QuestDisputeTeamSplitBody } from './quest-dispute-team-split.schema';
import {
  readTeamDisputeSplit,
  serializeTeamDisputeSplit,
  submitTeamDisputeSplit,
} from './quest-dispute-team-split.service';

const mapSplitError = (set: AuthedContext['set'], outcome: string) => {
  if (outcome === 'not-found' || outcome === 'not-authorized') {
    set.status = 404;
    return apiError('DISPUTE_TEAM_SPLIT_NOT_FOUND', 'Team Dispute split not found');
  }
  if (outcome === 'not-leader') {
    set.status = 403;
    return apiError(
      'DISPUTE_TEAM_SPLIT_NOT_AUTHORIZED',
      'Only the Team Leader can confirm the split'
    );
  }
  if (outcome === 'deadline-passed') {
    set.status = 409;
    return apiError('DISPUTE_TEAM_SPLIT_EXPIRED', 'The split deadline has passed');
  }
  if (outcome === 'invalid-split') {
    set.status = 400;
    return apiError(
      'DISPUTE_TEAM_SPLIT_INVALID',
      'The split must list every Team member once and total 10000 basis points'
    );
  }
  set.status = 409;
  return apiError('DISPUTE_TEAM_SPLIT_NOT_READY', 'The Team is not waiting for a split');
};

export const getQuestDisputeTeamSplitController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: { questId: string } }) => {
  const view = await readTeamDisputeSplit(session.user.id, params.questId);
  if ('outcome' in view) return mapSplitError(set, view.outcome);
  return apiSuccess(serializeTeamDisputeSplit(view));
};

export const submitQuestDisputeTeamSplitController = async ({
  params,
  request,
  session,
  body,
  set,
}: AuthedContext & { params: { questId: string }; body: QuestDisputeTeamSplitBody }) => {
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await submitTeamDisputeSplit(
    session.user.id,
    params.questId,
    body.shares,
    commandId
  );
  if ('kind' in result) {
    if (result.kind === 'rejected') return mapSplitError(set, result.rejection);
    const view = await readTeamDisputeSplit(session.user.id, params.questId);
    if ('outcome' in view) return mapSplitError(set, view.outcome);
    return apiSuccess(serializeTeamDisputeSplit(view));
  }
  if (result.outcome === 'not-found') return mapSplitError(set, result.outcome);
  return mapQuestCommandOutcome(set, result.outcome);
};
