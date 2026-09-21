import { db } from '@/database/client';
import {
  adminEvidenceReference,
  adminReportCase,
  adminReporterEntry,
  reportCaseStatus,
  type ReportCaseStatus,
  type ReporterEntryReason,
} from '@/database/schema/admin.schema';
import { quest } from '@/database/schema/quest.schema';
import { chatConversation, chatMembership, chatMessage } from '@/database/schema/work-chat.schema';
import { CursorInputError, type CursorPayload } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, desc, eq, exists, inArray, isNull, lte, or, sql } from 'drizzle-orm';

type MessageReportDatabase = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class MessageReportServiceError extends Error {
  constructor(
    readonly code: 'MESSAGE_NOT_FOUND' | 'REPORTER_ENTRY_NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'MessageReportServiceError';
  }
}

export type MessageReportEntry = {
  id: string;
  messageId: string;
  reason: ReporterEntryReason;
  detail: string | null;
  caseStatus: ReportCaseStatus;
  createdAt: Date;
  updatedAt: Date;
};

const reporterEntrySelection = {
  id: adminReporterEntry.id,
  messageId: adminReporterEntry.messageId,
  reason: adminReporterEntry.reason,
  detail: adminReporterEntry.detail,
  caseStatus: adminReportCase.status,
  createdAt: adminReporterEntry.createdAt,
  updatedAt: adminReportCase.updatedAt,
};

const visibleMessage = async (
  database: MessageReportDatabase,
  memberId: string,
  messageId: string
) => {
  const [message] = await database
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .innerJoin(chatConversation, eq(chatConversation.id, chatMessage.conversationId))
    .innerJoin(quest, eq(quest.id, chatConversation.questId))
    .where(
      and(
        eq(chatMessage.id, messageId),
        isNull(chatMessage.deletedAt),
        isNull(chatConversation.deletedAt),
        or(
          and(
            eq(chatConversation.type, 'CONVERSATION_WORK'),
            exists(
              database
                .select({ id: chatMembership.id })
                .from(chatMembership)
                .where(
                  and(
                    eq(chatMembership.conversationId, chatMessage.conversationId),
                    eq(chatMembership.memberId, memberId),
                    inArray(chatMembership.role, ['HIRER', 'WORKER']),
                    or(
                      isNull(chatMembership.leftAt),
                      lte(chatMessage.createdAt, chatMembership.leftAt)
                    )
                  )
                )
            )
          ),
          and(
            eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
            eq(chatConversation.state, 'INQUIRY_OPEN'),
            eq(quest.questStatus, 'QUEST_OPEN'),
            isNull(quest.hiddenAt),
            exists(
              database
                .select({ id: chatMembership.id })
                .from(chatMembership)
                .where(
                  and(
                    eq(chatMembership.conversationId, chatMessage.conversationId),
                    eq(chatMembership.memberId, memberId),
                    isNull(chatMembership.leftAt),
                    or(
                      and(
                        eq(chatMembership.role, 'HIRER'),
                        eq(chatMembership.memberId, quest.hirerId)
                      ),
                      and(
                        eq(chatMembership.role, 'PROSPECTIVE_WORKER'),
                        eq(chatMembership.memberId, chatConversation.candidateWorkerId)
                      )
                    )
                  )
                )
            )
          )
        )
      )
    )
    .limit(1);

  return message;
};

const selectOwnReport = async (
  database: MessageReportDatabase,
  where: ReturnType<typeof and>
): Promise<MessageReportEntry | undefined> => {
  const [entry] = await database
    .select(reporterEntrySelection)
    .from(adminReporterEntry)
    .innerJoin(adminReportCase, eq(adminReportCase.id, adminReporterEntry.reportCaseId))
    .where(where)
    .limit(1);
  return entry;
};

const findOpenCase = async (database: MessageReportDatabase, messageId: string) => {
  const [openCase] = await database
    .select({ id: adminReportCase.id, status: adminReportCase.status })
    .from(adminReportCase)
    .where(
      and(
        eq(adminReportCase.messageId, messageId),
        inArray(adminReportCase.status, [reportCaseStatus.pending, reportCaseStatus.hidden])
      )
    )
    .orderBy(desc(adminReportCase.createdAt), desc(adminReportCase.id))
    .limit(1);
  return openCase;
};

export const submitMessageReport = async (
  memberId: string,
  input: { messageId: string; reason: ReporterEntryReason; detail?: string }
): Promise<MessageReportEntry> =>
  db.transaction(async (transaction) => {
    const message = await visibleMessage(transaction, memberId, input.messageId);
    if (!message) {
      throw new MessageReportServiceError('MESSAGE_NOT_FOUND', 'Message not found');
    }

    const existing = await selectOwnReport(
      transaction,
      and(
        eq(adminReporterEntry.messageId, input.messageId),
        eq(adminReporterEntry.reporterMemberId, memberId)
      )
    );
    if (existing) return existing;

    let reportCase = await findOpenCase(transaction, input.messageId);
    if (!reportCase) {
      const [created] = await transaction
        .insert(adminReportCase)
        .values({ messageId: input.messageId })
        .onConflictDoNothing()
        .returning({ id: adminReportCase.id, status: adminReportCase.status });
      reportCase = created ?? (await findOpenCase(transaction, input.messageId));
    }
    if (!reportCase) throw new Error('Report Case was not created');

    await transaction
      .insert(adminEvidenceReference)
      .values({ reportCaseId: reportCase.id, messageId: input.messageId })
      .onConflictDoNothing();
    await transaction
      .insert(adminReporterEntry)
      .values({
        reportCaseId: reportCase.id,
        messageId: input.messageId,
        reporterMemberId: memberId,
        reason: input.reason,
        detail: input.detail,
      })
      .onConflictDoNothing();

    const entry = await selectOwnReport(
      transaction,
      and(
        eq(adminReporterEntry.messageId, input.messageId),
        eq(adminReporterEntry.reporterMemberId, memberId)
      )
    );
    if (!entry) throw new Error('Reporter Entry was not created');
    return entry;
  });

const assertOwnCursor = async (memberId: string, cursor: CursorPayload | undefined) => {
  if (!cursor) return;

  const [anchor] = await db
    .select({ id: adminReporterEntry.id })
    .from(adminReporterEntry)
    .where(
      and(
        eq(adminReporterEntry.id, cursor.id),
        eq(adminReporterEntry.reporterMemberId, memberId),
        sql`date_trunc('milliseconds', ${adminReporterEntry.createdAt}) = ${cursor.startTime}::timestamptz`
      )
    )
    .limit(1);
  if (!anchor) throw new CursorInputError('INVALID_CURSOR', 'cursor does not match a Report Entry');
};

export const listOwnMessageReports = async (
  memberId: string,
  options: { limit: number; cursor?: CursorPayload }
) => {
  await assertOwnCursor(memberId, options.cursor);
  const page = await readKeysetPage({
    anchor: { time: adminReporterEntry.createdAt, id: adminReporterEntry.id },
    cursor: options.cursor,
    limit: options.limit,
    where: eq(adminReporterEntry.reporterMemberId, memberId),
    read: ({ where, orderBy, limit }) =>
      db
        .select(reporterEntrySelection)
        .from(adminReporterEntry)
        .innerJoin(adminReportCase, eq(adminReportCase.id, adminReporterEntry.reportCaseId))
        .where(where)
        .orderBy(...orderBy)
        .limit(limit),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () =>
      new CursorInputError('INVALID_CURSOR', 'cursor does not match a Report Entry'),
  });

  return { items: page.rows, nextCursor: page.nextCursor };
};

export const getOwnMessageReport = async (
  memberId: string,
  reporterEntryId: string
): Promise<MessageReportEntry> => {
  const entry = await selectOwnReport(
    db,
    and(
      eq(adminReporterEntry.id, reporterEntryId),
      eq(adminReporterEntry.reporterMemberId, memberId)
    )
  );
  if (!entry) {
    throw new MessageReportServiceError('REPORTER_ENTRY_NOT_FOUND', 'Reporter Entry not found');
  }
  return entry;
};
