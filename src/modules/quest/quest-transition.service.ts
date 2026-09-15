/**
 * BE-348 Quest State transition module.
 *
 * One module owns a Quest State transition: the `quest.questStatus` write, the
 * version bump, the Terminal State stamp, and the Work Conversation entries the
 * transition implies. A caller names the transition it wants; it cannot write
 * half of one.
 */

import { and, eq, sql } from 'drizzle-orm';

import { quest } from '@/database/schema/quest.schema';

import { questStatus, type QuestStatus } from './quest.contract';
import type {
  QuestWorkChatMembershipTransition,
  WorkChatMembershipWriter,
} from './quest-work-chat.contract';
import {
  defaultQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
  type QuestTransaction,
} from './quest-work-chat.port';

/**
 * Every legal Quest State transition, keyed by the State being entered. A pair
 * absent from this table cannot be written, whatever the caller asks for.
 */
const allowedPredecessors = {
  [questStatus.draft]: [],
  [questStatus.open]: [questStatus.draft],
  [questStatus.awaitingConsent]: [
    questStatus.assigned,
    questStatus.inProgress,
    questStatus.submitted,
    questStatus.approved,
    questStatus.rework,
  ],
  [questStatus.assigned]: [questStatus.open, questStatus.awaitingConsent],
  [questStatus.inProgress]: [questStatus.assigned, questStatus.awaitingConsent],
  [questStatus.submitted]: [
    questStatus.inProgress,
    questStatus.rework,
    questStatus.awaitingConsent,
  ],
  [questStatus.approved]: [
    questStatus.inProgress,
    questStatus.submitted,
    questStatus.rework,
    questStatus.awaitingConsent,
  ],
  /** A second rework of a legacy Quest re-enters the State the Quest already holds. */
  [questStatus.rework]: [questStatus.submitted, questStatus.rework, questStatus.awaitingConsent],
  [questStatus.completed]: [questStatus.inProgress, questStatus.approved],
  [questStatus.cancelled]: [
    questStatus.draft,
    questStatus.open,
    questStatus.assigned,
    questStatus.inProgress,
  ],
  [questStatus.failed]: [
    questStatus.assigned,
    questStatus.inProgress,
    questStatus.submitted,
    questStatus.approved,
    questStatus.rework,
  ],
} as const satisfies Record<QuestStatus, readonly QuestStatus[]>;

/** Raised when a caller names a Quest State pair the lifecycle does not allow. */
export class QuestTransitionNotAllowedError extends Error {
  constructor(
    readonly from: QuestStatus,
    readonly to: QuestStatus
  ) {
    super(`Quest cannot move from ${from} to ${to}.`);
    this.name = 'QuestTransitionNotAllowedError';
  }
}

/** Columns the entered State owns beyond the State itself, its version and its stamps. */
export type QuestTransitionColumns = Omit<
  Partial<typeof quest.$inferInsert>,
  'id' | 'questStatus' | 'version' | 'updatedAt'
>;

export type QuestStateTransition = {
  questId: string;
  /** The State of the locked Quest row. The write is guarded on it. */
  from: QuestStatus;
  to: QuestStatus;
  now: Date;
  /** Quest row version the caller locked. When present, the write is guarded on it too. */
  version?: number;
  columns?: QuestTransitionColumns;
  /**
   * The Work Conversation entries this transition implies. An empty list states
   * that the Quest has no Work Conversation step, so a forgotten entry is a
   * visible decision instead of a silent omission.
   */
  workChat: readonly QuestWorkChatMembershipTransition[];
  /** Adapter for this call. Defaults to the configured Work Chat writer. */
  writer?: WorkChatMembershipWriter<QuestTransaction>;
};

const terminalStamp = (to: QuestStatus, now: Date): QuestTransitionColumns =>
  to === questStatus.failed
    ? { failedAt: now }
    : to === questStatus.cancelled
      ? { cancelledAt: now }
      : {};

const applyWorkChat = async (
  tx: QuestTransaction,
  input: QuestStateTransition,
  transitions: readonly QuestWorkChatMembershipTransition[]
) => {
  if (transitions.length === 0) return;
  const writer = input.writer ?? defaultQuestWorkChatMembershipWriter;
  try {
    for (const transition of transitions) {
      await writer.applyQuestTransition(tx, transition);
    }
  } catch (cause) {
    throw new WorkChatTransitionError(cause);
  }
};

/**
 * Applies one Quest State transition inside the caller's transaction.
 *
 * Membership closures land before the State write, so a Worker's Work
 * Conversation window closes while the Quest is still writable. Every other
 * entry lands after it, so Chat never sees a State the Quest does not hold.
 *
 * Answers false when the guarded write matches no row, which means another
 * transaction moved the Quest first.
 */
export const applyQuestStateTransition = async (
  tx: QuestTransaction,
  input: QuestStateTransition
): Promise<boolean> => {
  if (!(allowedPredecessors[input.to] as readonly QuestStatus[]).includes(input.from)) {
    throw new QuestTransitionNotAllowedError(input.from, input.to);
  }
  const closures = input.workChat.filter(({ type }) => type === 'workerBecameInactive');
  const entries = input.workChat.filter(({ type }) => type !== 'workerBecameInactive');

  await applyWorkChat(tx, input, closures);
  const [updated] = await tx
    .update(quest)
    .set({
      ...terminalStamp(input.to, input.now),
      ...input.columns,
      questStatus: input.to,
      version: sql`${quest.version} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(quest.id, input.questId),
        eq(quest.questStatus, input.from),
        ...(input.version === undefined ? [] : [eq(quest.version, input.version)])
      )
    )
    .returning({ id: quest.id });
  if (!updated) return false;
  await applyWorkChat(tx, input, entries);
  return true;
};
