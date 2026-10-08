import { db } from '@/database/client';
import {
  adminConductReport,
  adminModerationDecision,
  adminReportCase,
  conductReportStatus,
  memberPenaltyRecord,
} from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { chatMembership, chatMessage } from '@/database/schema/work-chat.schema';

import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import { adminMemberStatusSql } from './admin-member-status';
import type {
  AdminMemberModerationAction,
  AdminMemberModerationContextFields,
  AdminMemberStatus,
} from './admin-member.schema';

const previousModerationActionLimit = 5;

type ModerationActionEvent = {
  action: AdminMemberModerationAction;
  id: string;
  occurredAt: string;
};

const reportCaseActionFor = (status: string): AdminMemberModerationAction | null => {
  switch (status) {
    case 'REPORT_CASE_DISMISSED':
      return 'REPORT_CASE_DISMISS';
    case 'REPORT_CASE_HIDDEN':
      return 'REPORT_CASE_HIDE';
    case 'REPORT_CASE_RESTORED':
      return 'REPORT_CASE_RESTORE';
    default:
      return null;
  }
};

const conductReportActionFor = (status: string): AdminMemberModerationAction | null => {
  switch (status) {
    case conductReportStatus.dismissed:
      return 'CONDUCT_REPORT_DISMISS';
    case conductReportStatus.upheld:
      return 'CONDUCT_REPORT_UPHOLD';
    default:
      return null;
  }
};

const emptyMemberModerationContext = (): AdminMemberModerationContextFields => ({
  memberStatus: null,
  previousReportCount: null,
  confirmedViolationCount: null,
  previousModerationActions: [],
});

/** Read bounded moderation context for a Member before the related Admin Case was filed. */
export const getAdminMemberModerationContext = async (
  memberId: string | null,
  caseCreatedAt: string
): Promise<AdminMemberModerationContextFields> => {
  if (!memberId) return emptyMemberModerationContext();
  const caseCreatedAtSql = sql`${caseCreatedAt}::timestamptz`;

  const [memberRows, reportCountRows, violationCountRows, reportDecisionRows, conductDecisionRows] =
    await Promise.all([
      db
        .select({ memberStatus: adminMemberStatusSql() })
        .from(authUser)
        .where(eq(authUser.id, memberId))
        .limit(1),
      db
        .select({ total: count() })
        .from(adminReportCase)
        .innerJoin(chatMessage, eq(chatMessage.id, adminReportCase.messageId))
        .innerJoin(chatMembership, eq(chatMembership.id, chatMessage.senderMembershipId))
        .where(
          and(
            eq(chatMembership.memberId, memberId),
            lt(adminReportCase.createdAt, caseCreatedAtSql)
          )
        ),
      db
        .select({ total: count() })
        .from(memberPenaltyRecord)
        .where(
          and(
            eq(memberPenaltyRecord.memberId, memberId),
            eq(memberPenaltyRecord.ladder, 'MISCONDUCT'),
            inArray(memberPenaltyRecord.source, ['REPORT_CASE', 'CONDUCT_REPORT']),
            sql`${memberPenaltyRecord.result} <> 'PENALTY_REVERSAL'`,
            lt(memberPenaltyRecord.createdAt, caseCreatedAtSql)
          )
        ),
      db
        .select({
          id: adminModerationDecision.id,
          newStatus: adminModerationDecision.newStatus,
          occurredAt: sql<string>`to_char(${adminModerationDecision.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(adminModerationDecision)
        .innerJoin(adminReportCase, eq(adminReportCase.id, adminModerationDecision.reportCaseId))
        .innerJoin(chatMessage, eq(chatMessage.id, adminReportCase.messageId))
        .innerJoin(chatMembership, eq(chatMembership.id, chatMessage.senderMembershipId))
        .where(
          and(
            eq(chatMembership.memberId, memberId),
            lt(adminModerationDecision.createdAt, caseCreatedAtSql)
          )
        )
        .orderBy(desc(adminModerationDecision.createdAt), desc(adminModerationDecision.id))
        .limit(previousModerationActionLimit),
      db
        .select({
          id: adminConductReport.id,
          status: adminConductReport.status,
          occurredAt: sql<string>`to_char(${adminConductReport.resolvedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(adminConductReport)
        .where(
          and(
            eq(adminConductReport.reportedMemberId, memberId),
            inArray(adminConductReport.status, [
              conductReportStatus.upheld,
              conductReportStatus.dismissed,
            ]),
            lt(adminConductReport.resolvedAt, caseCreatedAtSql)
          )
        )
        .orderBy(desc(adminConductReport.resolvedAt), desc(adminConductReport.id))
        .limit(previousModerationActionLimit),
    ]);

  const memberStatus = memberRows[0]?.memberStatus ?? null;
  if (memberStatus === null) return emptyMemberModerationContext();

  const actionEvents: ModerationActionEvent[] = [
    ...reportDecisionRows.flatMap((row) => {
      const action = reportCaseActionFor(row.newStatus);
      return action ? [{ action, id: row.id, occurredAt: row.occurredAt }] : [];
    }),
    ...conductDecisionRows.flatMap((row) => {
      const action = conductReportActionFor(row.status);
      return action ? [{ action, id: row.id, occurredAt: row.occurredAt }] : [];
    }),
  ];
  actionEvents.sort(
    (left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
  );

  return {
    memberStatus: memberStatus as AdminMemberStatus,
    previousReportCount: reportCountRows[0]?.total ?? 0,
    confirmedViolationCount: violationCountRows[0]?.total ?? 0,
    previousModerationActions: actionEvents
      .slice(0, previousModerationActionLimit)
      .map((event) => event.action),
  };
};
