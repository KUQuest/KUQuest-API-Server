import { questMode, questParticipation } from './quest.contract';
import type { QuestV2Mode, QuestV2Participation } from './quest-v2.contract';

/**
 * Projects v2 values into the unchanged non-null legacy storage columns.
 * The projection stays outside the v2 HTTP and application contract.
 */
export const questV2StorageCompatibility = (input: {
  mode: QuestV2Mode;
  participation: QuestV2Participation;
}) => ({
  mode:
    input.mode === 'FIRST_COME_FIRST_SERVED'
      ? questMode.noCandidate
      : questMode.candidate,
  participation:
    input.participation === 'SINGLE'
      ? questParticipation.solo
      : questParticipation.group,
});
