/**
 * BE-119 Work Chat planning contract.
 *
 * Quest is the source of truth for accepted participation and lifecycle.
 * The caller invokes WorkChatMembershipWriter inside the Quest database transaction.
 * Identifiers are opaque: the API implementation chooses their physical type.
 * This contract deliberately does not cover private Inquiry Conversations.
 * It also has no ownership-transfer transition because MVP ownership is immutable.
 */

/** A retained Work Conversation referencing this ID prevents hard deletion of the Quest. */
export type QuestId = string;
export type StudentId = string;
export type AssignmentId = string;
export type CommandId = string;
export type EventId = string;
export type IsoTimestamp = string;

export type TerminalQuestStatus = 'COMPLETED' | 'CANCELLED';
export type InactiveAssignmentStatus = 'INCOMPLETE' | 'CANCELLED';

export type AcceptedWorker = {
  workerId: StudentId;
  assignmentId: AssignmentId;
  joinedAt: IsoTimestamp;
};

type TransitionBase = {
  /** The caller's idempotency key. Retries must return the prior result. */
  commandId: CommandId;
  /** Stable event identity used to deduplicate Chat-side system messages. */
  eventId: EventId;
  questId: QuestId;
  actorId: StudentId;
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
       * A GROUP direct-join Quest can still be OPEN at this point.
       */
      type: 'workersAccepted';
      hirerId: StudentId;
      workers: readonly [
        firstWorker: AcceptedWorker,
        ...otherWorkers: AcceptedWorker[],
      ];
    })
  | (TransitionBase & {
      /** Chat closes this Worker's membership window at leftAt. */
      type: 'workerBecameInactive';
      assignmentId: AssignmentId;
      workerId: StudentId;
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
