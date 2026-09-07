import { db } from '@/database/client';

import type { WorkChatMembershipWriter } from './quest-work-chat.contract';

/** The transaction boundary shared by Quest persistence and the Work Chat port. */
export type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QuestWorkChatWriter = WorkChatMembershipWriter<QuestTransaction>;

let configuredWorkChatWriter: QuestWorkChatWriter | undefined;

/**
 * Configure the Chat adapter used by Quest membership transitions.
 *
 * The Chat module owns the production writer. Until application composition
 * provides it, Assignment creation and Candidate selection fail closed with
 * WORK_CHAT_UNAVAILABLE rather than committing Quest-only participation.
 */
export const configureQuestWorkChatMembershipWriter = (
  writer: QuestWorkChatWriter | undefined,
): void => {
  configuredWorkChatWriter = writer;
};

export const getQuestWorkChatMembershipWriter = (): QuestWorkChatWriter | undefined =>
  configuredWorkChatWriter;

export const requireQuestWorkChatMembershipWriter = (): QuestWorkChatWriter => {
  if (!configuredWorkChatWriter) {
    throw new WorkChatTransitionError(new Error('Work Chat membership writer is not configured'));
  }
  return configuredWorkChatWriter;
};

export class WorkChatTransitionError extends Error {
  constructor(cause: unknown) {
    super('Work Chat membership transition failed', { cause });
    this.name = 'WorkChatTransitionError';
  }
}
