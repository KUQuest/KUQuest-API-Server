import { authUser } from '@/database/schema/auth.schema';
import {
  chatConversation,
  chatMembership,
  chatMessage,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import type {
  AcceptedWorker,
  ApplyQuestWorkChatMembershipResult,
  QuestTransaction,
  QuestWorkChatMembershipTransition,
  WorkChatMembershipWriter,
} from '@/modules/quest';

import { and, eq, inArray, sql } from 'drizzle-orm';

const systemTypes = {
  acceptedParticipantJoined: 'ACCEPTED_PARTICIPANT_JOINED',
  workerDeparted: 'WORKER_DEPARTED',
  conversationReadOnly: 'CONVERSATION_READ_ONLY',
} as const;

type StoredTransitionCommand = {
  id: string;
  questId: string;
  commandId: string;
  conversationId: string | null;
  transitionType: string;
  requestIdentity: string;
  processingStatus: string;
};

const producer = 'QUEST' as const;

const parseTime = (value: string): Date => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid Work Chat transition timestamp');
  return parsed;
};

const transitionType = (transition: QuestWorkChatMembershipTransition): string => transition.type;

const hashIdentity = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
};

const requestIdentity = (transition: QuestWorkChatMembershipTransition): Promise<string> =>
  hashIdentity(transition);

const eventIdentity = (
  transition: QuestWorkChatMembershipTransition,
  component: string,
): Promise<string> => hashIdentity({
  producer,
  transitionProducer: transition.producer,
  transitionType: transition.type,
  eventId: transition.eventId,
  component,
});

const commandScope = (transition: QuestWorkChatMembershipTransition) => and(
  eq(chatTransitionCommand.producer, transition.producer),
  eq(chatTransitionCommand.transitionType, transition.type),
  eq(chatTransitionCommand.commandId, transition.commandId),
);

const transitionCommandFields = {
  id: chatTransitionCommand.id,
  questId: chatTransitionCommand.questId,
  commandId: chatTransitionCommand.commandId,
  conversationId: chatTransitionCommand.conversationId,
  transitionType: chatTransitionCommand.transitionType,
  requestIdentity: chatTransitionCommand.requestIdentity,
  processingStatus: chatTransitionCommand.processingStatus,
};

const validateReplay = (
  command: StoredTransitionCommand,
  transition: QuestWorkChatMembershipTransition,
  identity: string,
): void => {
  if (
    command.questId !== transition.questId ||
    command.transitionType !== transition.type ||
    command.requestIdentity !== identity
  ) {
    throw new Error('Work Chat transition command has a different request identity');
  }
};

const claimTransition = async (
  transaction: QuestTransaction,
  transition: QuestWorkChatMembershipTransition,
): Promise<{ command: StoredTransitionCommand; alreadyApplied: boolean }> => {
  const identity = await requestIdentity(transition);
  const [existing] = await transaction
    .select(transitionCommandFields)
    .from(chatTransitionCommand)
    .where(commandScope(transition))
    .limit(1)
    .for('update');

  if (existing) {
    validateReplay(existing, transition, identity);
    if (existing.processingStatus !== 'COMPLETED') {
      throw new Error('Work Chat transition command is already processing');
    }
    return { command: existing, alreadyApplied: true };
  }

  const [created] = await transaction
    .insert(chatTransitionCommand)
    .values({
      producer: transition.producer,
      commandId: transition.commandId,
      questId: transition.questId,
      transitionType: transitionType(transition),
      requestIdentity: identity,
      createdAt: parseTime(transition.occurredAt),
    })
    .onConflictDoNothing({
      target: [
        chatTransitionCommand.producer,
        chatTransitionCommand.transitionType,
        chatTransitionCommand.commandId,
      ],
    })
    .returning(transitionCommandFields);

  if (created) return { command: created, alreadyApplied: false };

  const [concurrent] = await transaction
    .select(transitionCommandFields)
    .from(chatTransitionCommand)
    .where(commandScope(transition))
    .limit(1)
    .for('update');

  if (!concurrent) throw new Error('Work Chat transition command could not be claimed');
  validateReplay(concurrent, transition, identity);
  if (concurrent.processingStatus !== 'COMPLETED') {
    throw new Error('Work Chat transition command is already processing');
  }
  return { command: concurrent, alreadyApplied: true };
};

const completeTransition = async (
  transaction: QuestTransaction,
  transition: QuestWorkChatMembershipTransition,
  conversationId: string | null,
  completedAt: Date,
): Promise<void> => {
  await transaction
    .update(chatTransitionCommand)
    .set({
      conversationId,
      processingStatus: 'COMPLETED',
      completedAt,
    })
    .where(commandScope(transition));
};

const findConversation = async (transaction: QuestTransaction, questId: string) => {
  const [conversation] = await transaction
    .select({
      id: chatConversation.id,
      questId: chatConversation.questId,
      questTitle: chatConversation.questTitle,
      questStatus: chatConversation.questStatus,
      nextSequence: chatConversation.nextSequence,
      readOnlyAt: chatConversation.readOnlyAt,
    })
    .from(chatConversation)
    .where(eq(chatConversation.questId, questId))
    .limit(1)
    .for('update');

  return conversation;
};

const ensureConversation = async (transaction: QuestTransaction, questId: string) => {
  const current = await findConversation(transaction, questId);
  if (current) return current;

  const [questRow] = await transaction
    .select({
      id: quest.id,
      title: quest.title,
      questStatus: quest.questStatus,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1)
    .for('update');

  if (!questRow) throw new Error('Quest not found for Work Conversation transition');

  await transaction
    .insert(chatConversation)
    .values({
      questId: questRow.id,
      type: 'CONVERSATION_WORK',
      questTitle: questRow.title,
      questStatus: questRow.questStatus,
    })
    .onConflictDoNothing({ target: chatConversation.questId });

  const created = await findConversation(transaction, questId);
  if (!created) throw new Error('Work Conversation could not be created');
  return created;
};

const reserveSequence = async (transaction: QuestTransaction, conversationId: string): Promise<number> => {
  const [conversation] = await transaction
    .select({ nextSequence: chatConversation.nextSequence })
    .from(chatConversation)
    .where(eq(chatConversation.id, conversationId))
    .limit(1)
    .for('update');

  if (!conversation) throw new Error('Work Conversation not found while creating System Message');

  await transaction
    .update(chatConversation)
    .set({
      nextSequence: sql`${chatConversation.nextSequence} + 1`,
    })
    .where(eq(chatConversation.id, conversationId));

  return conversation.nextSequence;
};

const appendSystemMessage = async (
  transaction: QuestTransaction,
  conversationId: string,
  eventId: string,
  systemType: string,
  contentText: string,
  systemPayload: Record<string, unknown>,
  createdAt: Date,
): Promise<boolean> => {
  const [existing] = await transaction
    .select({ id: chatMessage.id, conversationId: chatMessage.conversationId })
    .from(chatMessage)
    .where(eq(chatMessage.eventId, eventId))
    .limit(1);

  if (existing) {
    if (existing.conversationId !== conversationId) {
      throw new Error('Work Chat event ID is already used by another Conversation');
    }
    return false;
  }

  const sequence = await reserveSequence(transaction, conversationId);
  const memberId = typeof systemPayload.memberId === 'string' ? systemPayload.memberId : undefined;
  const [affectedMember] = memberId
    ? await transaction
      .select({ firstName: authUser.firstName, lastName: authUser.lastName })
      .from(authUser)
      .where(eq(authUser.id, memberId))
      .limit(1)
    : [];
  const memberDisplayName = affectedMember
    ? `${affectedMember.firstName ?? ''} ${affectedMember.lastName ?? ''}`.trim() || 'Former member'
    : undefined;
  const safeSystemPayload = {
    ...systemPayload,
    ...(memberDisplayName ? { memberDisplayName } : {}),
    action: { type: 'OPEN_WORK_CONVERSATION', conversationId },
  };
  const [message] = await transaction
    .insert(chatMessage)
    .values({
      conversationId,
      sequence,
      kind: 'SYSTEM',
      contentText,
      systemType,
      systemPayload: safeSystemPayload,
      eventId,
      createdAt,
    })
    .onConflictDoNothing()
    .returning({ id: chatMessage.id });

  if (message) return true;

  const [conflictingEvent] = await transaction
    .select({ conversationId: chatMessage.conversationId })
    .from(chatMessage)
    .where(eq(chatMessage.eventId, eventId))
    .limit(1);
  if (!conflictingEvent || conflictingEvent.conversationId !== conversationId) {
    throw new Error('Work Chat System Message could not be stored');
  }
  return false;
};

const eventForWorker = (
  transition: QuestWorkChatMembershipTransition,
  worker: AcceptedWorker,
): Promise<string> => eventIdentity(transition, `worker:${worker.assignmentId}`);

const ensureHirerMembership = async (
  transaction: QuestTransaction,
  conversationId: string,
  hirerId: string,
  occurredAt: Date,
): Promise<boolean> => {
  const [existing] = await transaction
    .select({
      id: chatMembership.id,
      memberId: chatMembership.memberId,
      leftAt: chatMembership.leftAt,
    })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.conversationId, conversationId),
        eq(chatMembership.role, 'HIRER'),
      ),
    )
    .limit(1)
    .for('update');

  if (existing) {
    if (existing.memberId !== hirerId) throw new Error('Work Conversation has a different Hirer');
    if (existing.leftAt) throw new Error('Hirer Chat Membership is already closed');
    return false;
  }

  await transaction.insert(chatMembership).values({
    conversationId,
    memberId: hirerId,
    role: 'HIRER',
    joinedAt: occurredAt,
    createdAt: occurredAt,
  });
  return true;
};

const validateAcceptedAssignments = async (
  transaction: QuestTransaction,
  transition: Extract<QuestWorkChatMembershipTransition, { type: 'workersAccepted' }>,
): Promise<void> => {
  const assignmentIds = [...new Set(transition.workers.map(({ assignmentId }) => assignmentId))];
  const assignments = await transaction
    .select({
      id: questAssignment.id,
      questId: questAssignment.questId,
      workerId: questAssignment.workerId,
      assignmentStatus: questAssignment.assignmentStatus,
    })
    .from(questAssignment)
    .where(inArray(questAssignment.id, assignmentIds));
  const assignmentsById = new Map(assignments.map((assignment) => [assignment.id, assignment]));

  for (const worker of transition.workers) {
    const assignment = assignmentsById.get(worker.assignmentId);
    if (
      !assignment ||
      assignment.questId !== transition.questId ||
      assignment.workerId !== worker.workerId ||
      assignment.assignmentStatus !== 'ASSIGNMENT_ACTIVE'
    ) {
      throw new Error('Active Assignment does not belong to the transition Quest and Worker');
    }
  }
};

const applyWorkersAccepted = async (
  transaction: QuestTransaction,
  transition: Extract<QuestWorkChatMembershipTransition, { type: 'workersAccepted' }>,
): Promise<ApplyQuestWorkChatMembershipResult> => {
  const occurredAt = parseTime(transition.occurredAt);
  await validateAcceptedAssignments(transaction, transition);
  const conversation = await ensureConversation(transaction, transition.questId);
  if (conversation.readOnlyAt) throw new Error('Terminal Work Conversation cannot accept Workers');

  if (await ensureHirerMembership(transaction, conversation.id, transition.hirerId, occurredAt)) {
    await appendSystemMessage(
      transaction,
      conversation.id,
      await eventIdentity(transition, 'hirer'),
      systemTypes.acceptedParticipantJoined,
      'The Hirer joined the Work Conversation.',
      { role: 'HIRER', memberId: transition.hirerId, joinedAt: occurredAt.toISOString() },
      occurredAt,
    );
  }

  for (const worker of transition.workers) {
    const [existing] = await transaction
      .select({
        id: chatMembership.id,
        memberId: chatMembership.memberId,
        role: chatMembership.role,
      })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.conversationId, conversation.id),
          eq(chatMembership.assignmentId, worker.assignmentId),
        ),
      )
      .limit(1)
      .for('update');

    if (existing) {
      if (existing.memberId !== worker.workerId || existing.role !== 'WORKER') {
        throw new Error('Assignment already belongs to another Chat Membership');
      }
      continue;
    }

    const joinedAt = parseTime(worker.joinedAt);
    await transaction.insert(chatMembership).values({
      conversationId: conversation.id,
      assignmentId: worker.assignmentId,
      memberId: worker.workerId,
      role: 'WORKER',
      joinedAt,
      createdAt: joinedAt,
    });
    await appendSystemMessage(
      transaction,
      conversation.id,
      await eventForWorker(transition, worker),
      systemTypes.acceptedParticipantJoined,
      'A Worker joined the Work Conversation.',
      {
        role: 'WORKER',
        memberId: worker.workerId,
        assignmentId: worker.assignmentId,
        joinedAt: joinedAt.toISOString(),
      },
      joinedAt,
    );
  }

  await transaction
    .update(chatConversation)
    .set({ updatedAt: occurredAt })
    .where(eq(chatConversation.id, conversation.id));

  return { conversationId: conversation.id, outcome: 'APPLIED' };
};

const applyWorkerBecameInactive = async (
  transaction: QuestTransaction,
  transition: Extract<QuestWorkChatMembershipTransition, { type: 'workerBecameInactive' }>,
): Promise<ApplyQuestWorkChatMembershipResult> => {
  const leftAt = parseTime(transition.leftAt);
  const conversation = await findConversation(transaction, transition.questId);
  if (!conversation) throw new Error('Work Conversation is missing for an inactive Worker');
  if (conversation.readOnlyAt) throw new Error('Work Conversation is read-only');

  const [assignment] = await transaction
    .select({
      questId: questAssignment.questId,
      workerId: questAssignment.workerId,
      assignmentStatus: questAssignment.assignmentStatus,
    })
    .from(questAssignment)
    .where(eq(questAssignment.id, transition.assignmentId))
    .limit(1);
  if (
    !assignment ||
    assignment.questId !== transition.questId ||
    assignment.workerId !== transition.workerId ||
    assignment.assignmentStatus !== transition.assignmentStatus
  ) {
    throw new Error('Inactive Assignment does not belong to the transition Quest and Worker');
  }

  const [membership] = await transaction
    .select({
      id: chatMembership.id,
      memberId: chatMembership.memberId,
      leftAt: chatMembership.leftAt,
    })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.conversationId, conversation.id),
        eq(chatMembership.assignmentId, transition.assignmentId),
      ),
    )
    .limit(1)
    .for('update');

  if (!membership || membership.memberId !== transition.workerId) {
    throw new Error('Worker Chat Membership is missing for the Assignment');
  }
  if (membership.leftAt) {
    return { conversationId: conversation.id, outcome: 'ALREADY_APPLIED' };
  }

  await transaction
    .update(chatMembership)
    .set({ leftAt })
    .where(eq(chatMembership.id, membership.id));
  await appendSystemMessage(
    transaction,
    conversation.id,
    await eventIdentity(transition, 'worker-inactive'),
    systemTypes.workerDeparted,
    'A Worker left the Work Conversation.',
    {
      role: 'WORKER',
      memberId: transition.workerId,
      assignmentId: transition.assignmentId,
      assignmentStatus: transition.assignmentStatus,
      leftAt: leftAt.toISOString(),
    },
    leftAt,
  );
  await transaction
    .update(chatConversation)
    .set({ updatedAt: leftAt })
    .where(eq(chatConversation.id, conversation.id));

  return { conversationId: conversation.id, outcome: 'APPLIED' };
};

const applyQuestBecameReadOnly = async (
  transaction: QuestTransaction,
  transition: Extract<QuestWorkChatMembershipTransition, { type: 'questBecameReadOnly' }>,
): Promise<ApplyQuestWorkChatMembershipResult> => {
  const readOnlyAt = parseTime(transition.readOnlyAt);
  const conversation = await findConversation(transaction, transition.questId);
  if (!conversation) {
    return { conversationId: '', outcome: 'APPLIED' };
  }
  if (conversation.readOnlyAt) {
    return { conversationId: conversation.id, outcome: 'ALREADY_APPLIED' };
  }

  await transaction
    .update(chatConversation)
    .set({
      questStatus: transition.questStatus,
      readOnlyAt,
      archivedAt: readOnlyAt,
      latestTerminalAt: readOnlyAt,
      updatedAt: readOnlyAt,
    })
    .where(eq(chatConversation.id, conversation.id));
  await appendSystemMessage(
    transaction,
    conversation.id,
    await eventIdentity(transition, 'conversation-read-only'),
    systemTypes.conversationReadOnly,
    'The Work Conversation is now read-only.',
    { questStatus: transition.questStatus, readOnlyAt: readOnlyAt.toISOString() },
    readOnlyAt,
  );

  return { conversationId: conversation.id, outcome: 'APPLIED' };
};

const applyTransition = async (
  transaction: QuestTransaction,
  transition: QuestWorkChatMembershipTransition,
): Promise<ApplyQuestWorkChatMembershipResult> => {
  const claimed = await claimTransition(transaction, transition);
  if (claimed.alreadyApplied) {
    return {
      conversationId: claimed.command.conversationId ?? '',
      outcome: 'ALREADY_APPLIED',
    };
  }

  let result: ApplyQuestWorkChatMembershipResult;
  if (transition.type === 'workersAccepted') {
    result = await applyWorkersAccepted(transaction, transition);
  } else if (transition.type === 'workerBecameInactive') {
    result = await applyWorkerBecameInactive(transaction, transition);
  } else {
    result = await applyQuestBecameReadOnly(transaction, transition);
  }

  if (result.conversationId) {
    await completeTransition(
      transaction,
      transition,
      result.conversationId,
      parseTime(transition.occurredAt),
    );
  } else {
    await transaction
      .delete(chatTransitionCommand)
      .where(commandScope(transition));
  }
  return result;
};

export const createWorkChatMembershipWriter = (): WorkChatMembershipWriter<QuestTransaction> => ({
  applyQuestTransition: applyTransition,
});

export const workChatMembershipWriter = createWorkChatMembershipWriter();
