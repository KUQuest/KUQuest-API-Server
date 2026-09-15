import { db } from '@/database/client';
import { workChatMembershipWriter } from '@/modules/work-chat/work-chat.membership-writer';

import type { WorkChatMembershipWriter } from './quest-work-chat.contract';

/** The transaction boundary shared by Quest persistence and the Work Chat port. */
export type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type QuestWorkChatWriter = WorkChatMembershipWriter<QuestTransaction>;

/**
 * The Chat adapter Quest membership transitions use when a caller names no other.
 *
 * The Chat module owns the production writer. The binding is immutable, so no
 * composition step can forget it and no test can leak one into the next file.
 * A caller that needs another adapter passes it at the call: the `workChatWriter`
 * option of a Quest command, or the `writer` field of a Quest State transition.
 */
export const defaultQuestWorkChatMembershipWriter: QuestWorkChatWriter = workChatMembershipWriter;

export class WorkChatTransitionError extends Error {
  constructor(cause: unknown) {
    super('Work Chat membership transition failed', { cause });
    this.name = 'WorkChatTransitionError';
  }
}
