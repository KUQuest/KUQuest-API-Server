/**
 * BE-119 Work Chat planning contract, revised by BE-170 to the canonical
 * Quest domain vocabulary (see ./quest.contract.ts and
 * docs/db/edr/05-quest.sql). Behavior implementation is BE-174.
 *
 * Quest is the source of truth for accepted participation and lifecycle.
 * The caller invokes WorkChatMembershipWriter inside the Quest database transaction.
 * Identities are native UUIDs (BE-170): a Member is auth_user.id, an Admin is
 * auth_admin.id.
 * This port covers Work Conversation membership only. Candidate Inquiry
 * Conversations have a separate lifecycle and do not enter this membership
 * transition. It also has no ownership-transfer transition because MVP
 * ownership is immutable.
 */

import type {
  InactiveAssignmentStatus as QuestInactiveAssignmentStatus,
  TerminalQuestStatus as QuestTerminalQuestStatus,
} from './quest.contract';

/** A retained Work Conversation referencing this ID prevents hard deletion of the Quest. */
export type QuestId = string;
export type MemberId = string;
export type AssignmentId = string;
export type CommandId = string;
export type EventId = string;
export type IsoTimestamp = string;
export type QuestWorkChatTransitionProducer =
  | 'QUEST_DIRECT_JOIN'
  | 'QUEST_ASSIGNMENT_V2'
  | 'QUEST_CANDIDATE_SELECTION'
  | 'QUEST_SETTLEMENT';

export type TerminalQuestStatus = QuestTerminalQuestStatus;
export type InactiveAssignmentStatus = QuestInactiveAssignmentStatus;

export type AcceptedWorker = {
  workerId: MemberId;
  assignmentId: AssignmentId;
  joinedAt: IsoTimestamp;
};

type TransitionBase = {
  /** The Quest command boundary that produced this transition. */
  producer: QuestWorkChatTransitionProducer;
  /** The caller's idempotency key. Retries must return the prior result. */
  commandId: CommandId;
  /** Stable event identity used to deduplicate Chat-side system messages. */
  eventId: EventId;
  questId: QuestId;
  /** Null for a system lifecycle transition with no Member or Admin actor. */
  actorId: MemberId | null;
  occurredAt: IsoTimestamp;
};

/** The complete input Chat may receive from Quest for membership/write-access changes. */
export type QuestWorkChatMembershipTransition =
  | (TransitionBase & {
      /**
       * Sent when one or more Workers become accepted. The first call creates
       * the Work Conversation, where Chat writes the Hirer's joinedAt as
       * occurredAt and each Worker's joinedAt from this payload. Later calls
       * add Workers only.
       * A GROUP direct-join Quest can still be QUEST_OPEN at this point.
       */
      type: 'workersAccepted';
      hirerId: MemberId;
      workers: readonly [
        firstWorker: AcceptedWorker,
        ...otherWorkers: AcceptedWorker[],
      ];
    })
  | (TransitionBase & {
      /** Chat closes this Worker's membership window at leftAt. */
      type: 'workerBecameInactive';
      assignmentId: AssignmentId;
      workerId: MemberId;
      assignmentStatus: InactiveAssignmentStatus;
      leftAt: IsoTimestamp;
    })
  | (TransitionBase & {
      type: 'questBecameReadOnly';
      questStatus: TerminalQuestStatus;
      readOnlyAt: IsoTimestamp;
    });

export type ApplyQuestWorkChatMembershipResult = {
  conversationId: string;
  outcome: 'APPLIED' | 'ALREADY_APPLIED';
};

/**
 * Implemented by Chat and called only by Quest within Quest's write transaction.
 * This port deliberately exposes no HTTP or read-membership operation.
 */
export interface WorkChatMembershipWriter<Transaction> {
  applyQuestTransition(
    transaction: Transaction,
    transition: QuestWorkChatMembershipTransition,
  ): Promise<ApplyQuestWorkChatMembershipResult>;
}
