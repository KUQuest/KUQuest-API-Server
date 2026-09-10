import { questStatus } from '@/modules/quest/quest.contract';

/**
 * The accepted Quest State projection for the Admin Overview.
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
