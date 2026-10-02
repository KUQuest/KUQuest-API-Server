import { questV2Mode, questV2Participation } from '../core/quest-v2.contract';

export type CandidateRosterQuestAccessState = {
  v2Mode: string | null;
  v2Participation: string | null;
  questState: string;
};

export const isReadableCandidateApplicationRoster = (current: CandidateRosterQuestAccessState) =>
  current.v2Mode === questV2Mode.candidate &&
  current.v2Participation === questV2Participation.single &&
  (current.questState === 'QUEST_OPEN' || current.questState === 'QUEST_ASSIGNED');

export const isReadableCandidateTeamRoster = (current: CandidateRosterQuestAccessState) =>
  current.v2Mode === questV2Mode.candidate &&
  current.v2Participation === questV2Participation.group &&
  current.questState === 'QUEST_OPEN';
