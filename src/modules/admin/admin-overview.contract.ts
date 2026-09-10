import { questStatus } from '@/modules/quest/quest.contract';

/**
 * The accepted Quest State projection for the Admin Overview.
 *
 * PR #438 established `quests.byStatus` as the response key. Its values are
 * canonical Quest State values; Legacy Quest Status values must not be added.
 */
export const adminOverviewQuestStates = [
  questStatus.draft,
  questStatus.open,
  questStatus.assigned,
  questStatus.inProgress,
  questStatus.completed,
  questStatus.cancelled,
  questStatus.failed,
] as const;

export type AdminOverviewQuestState = (typeof adminOverviewQuestStates)[number];
