import {
  questMode,
  questParticipation,
  type QuestMode,
  type QuestParticipation,
} from './quest.contract';
import {
  questV2Mode,
  questV2Participation,
  type QuestV2Mode,
  type QuestV2Participation,
} from '../../v2/core/quest-v2.contract';

export const questV2ModeFromStorage = (input: {
  apiVersion: 'v1' | 'v2';
  mode: QuestMode;
  v2Mode: QuestV2Mode | null;
}): QuestV2Mode =>
  input.apiVersion === 'v2' && input.v2Mode !== null
    ? input.v2Mode
    : input.mode === questMode.noCandidate
      ? questV2Mode.firstComeFirstServed
      : questV2Mode.candidate;

export const questV2ParticipationFromStorage = (input: {
  apiVersion: 'v1' | 'v2';
  participation: QuestParticipation;
  v2Participation: QuestV2Participation | null;
}): QuestV2Participation =>
  input.apiVersion === 'v2' && input.v2Participation !== null
    ? input.v2Participation
    : input.participation === questParticipation.solo
      ? questV2Participation.single
      : questV2Participation.group;

/**
 * Projects v2 values into the unchanged non-null legacy storage columns.
 * The projection stays outside the v2 HTTP and application contract.
 */
export const questV2StorageCompatibility = (input: {
  mode: QuestV2Mode;
  participation: QuestV2Participation;
}) => ({
  mode:
    input.mode === questV2Mode.firstComeFirstServed ? questMode.noCandidate : questMode.candidate,
  participation:
    input.participation === questV2Participation.single
      ? questParticipation.solo
      : questParticipation.group,
});
