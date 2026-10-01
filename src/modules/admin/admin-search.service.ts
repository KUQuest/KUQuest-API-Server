import { db } from '@/database/client';
import {
  adminAction,
  adminConductReport,
  adminDisputeCase,
  adminReportCase,
  adminReporterEntry,
} from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { chatMembership, chatMessage } from '@/database/schema/work-chat.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { walletWallet } from '@/database/schema/wallet.schema';

import { and, eq, exists, or, sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { formatDisplayIdSql } from './admin-display-id';
import { adminMemberStatusSql } from './admin-member-status';
import type { AdminMemberStatus } from './admin-member.schema';
import { adminSearchResultLimit } from './admin-search.schema';
import type { AdminSearchItem, AdminSearchKind } from './admin-search.schema';

type SearchRow = {
  id: string;
  resourceId: string;
  displayId?: string;
  studentId?: string | null;
  title: string;
  status: string | null;
  newestAt: Date | null;
};

type MemberSearchRow = Omit<SearchRow, 'status'> & { status: AdminMemberStatus };
type NonMemberAdminSearchKind = Exclude<AdminSearchKind, 'member'>;

const maxResults = adminSearchResultLimit;

const reportReportedMember = alias(authUser, 'admin_search_report_member');
const disputeFiler = alias(authUser, 'admin_search_dispute_filer');
const disputeHirer = alias(authUser, 'admin_search_dispute_hirer');
const disputeResolvedWorker = alias(authUser, 'admin_search_dispute_resolved_worker');
const disputeReportedWorker = alias(authUser, 'admin_search_dispute_reported_worker');
const conductReportedMember = alias(authUser, 'admin_search_conduct_reported_member');

const memberStatusLabels: Record<AdminMemberStatus, string> = {
  NORMAL: 'Normal',
  RED_FLAG: 'Red Flag',
  TEMPORARY_BAN: 'Temporary Ban',
  PERMANENT_BAN: 'Permanent Ban',
};

const questStatusLabels: Record<string, string> = {
  QUEST_DRAFT: 'Draft',
  QUEST_OPEN: 'Open',
  QUEST_AWAITING_CONSENT: 'Awaiting Consent',
  QUEST_ASSIGNED: 'Assigned',
  QUEST_IN_PROGRESS: 'In Progress',
  QUEST_SUBMITTED: 'Submitted',
  QUEST_APPROVED: 'Approved',
  QUEST_REWORK: 'Rework',
  QUEST_COMPLETED: 'Completed',
  QUEST_CANCELLED: 'Cancelled',
  QUEST_DISPUTED: 'Disputed',
  QUEST_FAILED: 'Failed',
};

const payoutStatusLabels: Record<string, string> = {
  PENDING_ADMIN_APPROVAL: 'Pending Admin Approval',
  SUBMITTED_TO_PROVIDER: 'Submitted to Provider',
  PROVIDER_PENDING: 'Provider Pending',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const disputeStatusLabels: Record<string, string> = {
  DISPUTE_CASE_PENDING: 'Pending',
  DISPUTE_CASE_DISMISSED: 'Dismissed',
  DISPUTE_CASE_RESOLVED: 'Resolved',
};

const reportStatusLabels: Record<string, string> = {
  REPORT_CASE_PENDING: 'Pending',
  REPORT_CASE_DISMISSED: 'Dismissed',
  REPORT_CASE_HIDDEN: 'Hidden',
  REPORT_CASE_RESTORED: 'Restored',
};

const conductStatusLabels: Record<string, string> = {
  CONDUCT_REPORT_PENDING: 'Pending',
  CONDUCT_REPORT_UPHELD: 'Upheld',
  CONDUCT_REPORT_DISMISSED: 'Dismissed',
};

const conductReasonLabels: Record<string, string> = {
  CONDUCT_ABANDONED: 'Abandonment',
  CONDUCT_OUT_OF_SCOPE: 'Work outside the agreed scope',
  CONDUCT_NO_SHOW: 'Not attending the Quest',
};

const reportReasonLabels: Record<string, string> = {
  REPORT_ABUSIVE_OR_HARASSMENT: 'Abusive or harassment',
  REPORT_SPAM: 'Spam',
  REPORT_INAPPROPRIATE_CONTENT: 'Inappropriate content',
  REPORT_DANGER_OR_THREAT: 'Danger or threat',
  REPORT_OTHER: 'Other',
};

const walletStatusLabels: Record<string, string> = {
  ACTIVE: 'Active',
  FROZEN: 'Frozen',
  SUSPENDED: 'Suspended',
  CLOSED: 'Closed',
};

const textContains = (query: string, field: SQLWrapper) =>
  sql`strpos(lower(cast(${field} as text)), lower(${query})) > 0`;

const textMatches = (query: string, fields: SQLWrapper[]) =>
  or(...fields.map((field) => textContains(query, field))) ?? sql`false`;

const typeMatches = (query: string, label: string, kind: string) => {
  const normalizedQuery = query.toLowerCase();
  return normalizedQuery === label.toLowerCase() || normalizedQuery === kind
    ? sql`true`
    : undefined;
};

const statusMatches = (query: string, status: SQLWrapper, labels: Record<string, string>) => {
  const normalizedQuery = query.toLowerCase();
  const matchingLabels = Object.entries(labels)
    .filter(([, label]) => label.toLowerCase().includes(normalizedQuery))
    .map(([value]) => sql`cast(${status} as text) = ${value}`);

  return or(textContains(query, status), ...matchingLabels) ?? sql`false`;
};

const fullName = (firstName: SQLWrapper, lastName: SQLWrapper) =>
  sql<string>`concat_ws(' ', ${firstName}, ${lastName})`;

const searchPredicate = (
  query: string,
  label: string,
  kind: AdminSearchKind,
  fields: SQLWrapper[],
  extraMatches: (SQLWrapper | undefined)[]
) => or(typeMatches(query, label, kind), textMatches(query, fields), ...extraMatches) ?? sql`false`;

const newestFirstOrder = (createdAt: SQLWrapper, id: SQLWrapper) =>
  sql`case when ${createdAt} is null then 1 else 0 end, ${createdAt} desc, ${id} desc`;

const searchMembers = async (query: string): Promise<MemberSearchRow[]> => {
  const status = adminMemberStatusSql();
  return db
    .select({
      id: authUser.id,
      resourceId: authUser.id,
      studentId: authUser.studentId,
      title: fullName(authUser.firstName, authUser.lastName),
      status,
      newestAt: authUser.createdAt,
    })
    .from(authUser)
    .where(
      searchPredicate(
        query,
        'Member',
        'member',
        [authUser.id, fullName(authUser.firstName, authUser.lastName), authUser.studentId],
        [statusMatches(query, status, memberStatusLabels)]
      )
    )
    .orderBy(newestFirstOrder(authUser.createdAt, authUser.id))
    .limit(maxResults);
};

const searchQuests = async (query: string): Promise<SearchRow[]> => {
  const displayId = formatDisplayIdSql('quest', quest.publicSequence);
  return db
    .select({
      id: quest.id,
      resourceId: quest.id,
      displayId,
      title: quest.title,
      status: quest.questStatus,
      newestAt: quest.createdAt,
    })
    .from(quest)
    .where(
      searchPredicate(
        query,
        'Quest',
        'quest',
        [quest.id, displayId, quest.title],
        [statusMatches(query, quest.questStatus, questStatusLabels)]
      )
    )
    .orderBy(newestFirstOrder(quest.createdAt, quest.id))
    .limit(maxResults);
};

const searchPayouts = async (query: string): Promise<SearchRow[]> => {
  const displayId = formatDisplayIdSql('payout', paymentPayouts.publicSequence);
  return db
    .select({
      id: paymentPayouts.id,
      resourceId: paymentPayouts.id,
      displayId,
      title: sql<string>`'Payout for ' || ${fullName(authUser.firstName, authUser.lastName)}`,
      status: paymentPayouts.payoutStatus,
      newestAt: paymentPayouts.createdAt,
    })
    .from(paymentPayouts)
    .innerJoin(authUser, eq(authUser.id, paymentPayouts.userId))
    .where(
      searchPredicate(
        query,
        'Payout',
        'payout',
        [
          paymentPayouts.id,
          displayId,
          paymentPayouts.userId,
          fullName(authUser.firstName, authUser.lastName),
        ],
        [statusMatches(query, paymentPayouts.payoutStatus, payoutStatusLabels)]
      )
    )
    .orderBy(newestFirstOrder(paymentPayouts.createdAt, paymentPayouts.id))
    .limit(maxResults);
};

const searchDisputes = async (query: string): Promise<SearchRow[]> => {
  const displayId = formatDisplayIdSql('dispute', adminDisputeCase.publicSequence);
  const filerName = fullName(disputeFiler.firstName, disputeFiler.lastName);
  const hirerName = fullName(disputeHirer.firstName, disputeHirer.lastName);
  const resolvedWorkerName = fullName(
    disputeResolvedWorker.firstName,
    disputeResolvedWorker.lastName
  );
  const reportedWorkerName = fullName(
    disputeReportedWorker.firstName,
    disputeReportedWorker.lastName
  );
  // A Hirer-filed case has no target Worker until resolution. Its Quest Assignments are the
  // possible reported Members in that case.
  const reportedMemberMatch = or(
    and(
      eq(adminDisputeCase.filerUserId, quest.hirerId),
      exists(
        db
          .select({ id: questAssignment.id })
          .from(questAssignment)
          .innerJoin(disputeReportedWorker, eq(disputeReportedWorker.id, questAssignment.workerId))
          .where(
            and(
              eq(questAssignment.questId, adminDisputeCase.questId),
              textMatches(query, [disputeReportedWorker.id, reportedWorkerName])
            )
          )
      )
    ),
    and(
      sql`${adminDisputeCase.filerUserId} <> ${quest.hirerId}`,
      textMatches(query, [disputeHirer.id, hirerName])
    ),
    textMatches(query, [disputeResolvedWorker.id, resolvedWorkerName])
  );

  return db
    .select({
      id: adminDisputeCase.id,
      resourceId: adminDisputeCase.id,
      displayId,
      title: sql<string>`'Dispute Case for ' || ${quest.title}`,
      status: adminDisputeCase.status,
      newestAt: adminDisputeCase.createdAt,
    })
    .from(adminDisputeCase)
    .innerJoin(quest, eq(quest.id, adminDisputeCase.questId))
    .innerJoin(disputeFiler, eq(disputeFiler.id, adminDisputeCase.filerUserId))
    .innerJoin(disputeHirer, eq(disputeHirer.id, quest.hirerId))
    .leftJoin(
      disputeResolvedWorker,
      eq(disputeResolvedWorker.id, adminDisputeCase.resolvedWorkerId)
    )
    .where(
      searchPredicate(
        query,
        'Dispute Case',
        'dispute',
        [adminDisputeCase.id, displayId, quest.id, quest.title, disputeFiler.id, filerName],
        [statusMatches(query, adminDisputeCase.status, disputeStatusLabels), reportedMemberMatch]
      )
    )
    .orderBy(newestFirstOrder(adminDisputeCase.createdAt, adminDisputeCase.id))
    .limit(maxResults);
};

const searchReports = async (query: string): Promise<SearchRow[]> => {
  const displayId = formatDisplayIdSql('reportCase', adminReportCase.publicSequence);
  const reportedName = fullName(reportReportedMember.firstName, reportReportedMember.lastName);
  const matchingCategory = exists(
    db
      .select({ id: adminReporterEntry.id })
      .from(adminReporterEntry)
      .where(
        and(
          eq(adminReporterEntry.reportCaseId, adminReportCase.id),
          statusMatches(query, adminReporterEntry.reason, reportReasonLabels)
        )
      )
  );

  return db
    .select({
      id: adminReportCase.id,
      resourceId: adminReportCase.id,
      displayId,
      title: sql<string>`'Report Case ' || ${displayId}`,
      status: adminReportCase.status,
      newestAt: adminReportCase.createdAt,
    })
    .from(adminReportCase)
    .innerJoin(chatMessage, eq(chatMessage.id, adminReportCase.messageId))
    .leftJoin(chatMembership, eq(chatMembership.id, chatMessage.senderMembershipId))
    .leftJoin(reportReportedMember, eq(reportReportedMember.id, chatMembership.memberId))
    .where(
      searchPredicate(
        query,
        'Report Case',
        'report',
        [adminReportCase.id, displayId, reportReportedMember.id, reportedName],
        [statusMatches(query, adminReportCase.status, reportStatusLabels), matchingCategory]
      )
    )
    .orderBy(newestFirstOrder(adminReportCase.createdAt, adminReportCase.id))
    .limit(maxResults);
};

const searchConductReports = async (query: string): Promise<SearchRow[]> => {
  const displayId = formatDisplayIdSql('conductReport', adminConductReport.publicSequence);
  const reportedName = fullName(conductReportedMember.firstName, conductReportedMember.lastName);

  return db
    .select({
      id: adminConductReport.id,
      resourceId: adminConductReport.id,
      displayId,
      title: sql<string>`'Conduct Report for ' || ${reportedName}`,
      status: adminConductReport.status,
      newestAt: adminConductReport.createdAt,
    })
    .from(adminConductReport)
    .innerJoin(quest, eq(quest.id, adminConductReport.questId))
    .innerJoin(
      conductReportedMember,
      eq(conductReportedMember.id, adminConductReport.reportedMemberId)
    )
    .where(
      searchPredicate(
        query,
        'Conduct Report',
        'conduct-report',
        [
          adminConductReport.id,
          displayId,
          quest.id,
          quest.title,
          conductReportedMember.id,
          reportedName,
        ],
        [
          statusMatches(query, adminConductReport.reason, conductReasonLabels),
          statusMatches(query, adminConductReport.status, conductStatusLabels),
        ]
      )
    )
    .orderBy(newestFirstOrder(adminConductReport.createdAt, adminConductReport.id))
    .limit(maxResults);
};

const searchWallets = async (query: string): Promise<SearchRow[]> => {
  const displayId = formatDisplayIdSql('wallet', walletWallet.publicSequence);
  return db
    .select({
      id: walletWallet.id,
      resourceId: walletWallet.id,
      displayId,
      title: sql<string>`'Wallet for ' || ${fullName(authUser.firstName, authUser.lastName)}`,
      status: walletWallet.walletStatus,
      newestAt: walletWallet.createdAt,
    })
    .from(walletWallet)
    .innerJoin(authUser, eq(authUser.id, walletWallet.userId))
    .where(
      searchPredicate(
        query,
        'Wallet',
        'wallet',
        [
          walletWallet.id,
          displayId,
          walletWallet.userId,
          fullName(authUser.firstName, authUser.lastName),
        ],
        [statusMatches(query, walletWallet.walletStatus, walletStatusLabels)]
      )
    )
    .orderBy(newestFirstOrder(walletWallet.createdAt, walletWallet.id))
    .limit(maxResults);
};

const searchActivity = async (query: string): Promise<SearchRow[]> =>
  db
    .select({
      id: adminAction.id,
      // The Activity result is the Admin Action; its target remains searchable below.
      resourceId: adminAction.id,
      title: adminAction.action,
      status: sql<string | null>`null`,
      newestAt: adminAction.createdAt,
    })
    .from(adminAction)
    .innerJoin(authAdmin, eq(authAdmin.id, adminAction.adminId))
    .where(
      searchPredicate(
        query,
        'Admin Activity Log',
        'activity',
        [
          adminAction.id,
          adminAction.adminId,
          fullName(authAdmin.firstName, authAdmin.lastName),
          adminAction.action,
          adminAction.resourceType,
          adminAction.resourceId,
          adminAction.reasonCode,
        ],
        []
      )
    )
    .orderBy(newestFirstOrder(adminAction.createdAt, adminAction.id))
    .limit(maxResults);

type NonMemberSearchItem = Exclude<AdminSearchItem, { kind: 'member' }>;

const searches: Record<NonMemberAdminSearchKind, (query: string) => Promise<SearchRow[]>> = {
  quest: searchQuests,
  payout: searchPayouts,
  dispute: searchDisputes,
  report: searchReports,
  'conduct-report': searchConductReports,
  wallet: searchWallets,
  activity: searchActivity,
};

const toMemberItem = (row: MemberSearchRow): Extract<AdminSearchItem, { kind: 'member' }> => ({
  kind: 'member',
  id: row.id,
  resourceId: row.resourceId,
  ...(row.studentId === undefined ? {} : { studentId: row.studentId }),
  title: row.title,
  status: row.status,
  newestAt: row.newestAt?.toISOString() ?? null,
});

const toItems = (kind: NonMemberAdminSearchKind, rows: SearchRow[]): NonMemberSearchItem[] =>
  rows.map((row) => ({
    kind,
    id: row.id,
    resourceId: row.resourceId,
    ...(row.displayId === undefined ? {} : { displayId: row.displayId }),
    ...(row.studentId === undefined ? {} : { studentId: row.studentId }),
    title: kind === 'activity' ? row.title.replaceAll('_', ' ') : row.title,
    status: row.status,
    newestAt: row.newestAt?.toISOString() ?? null,
  }));

export const searchAdminRecords = async (
  query: string,
  kind: AdminSearchKind
): Promise<AdminSearchItem[]> => {
  if (kind === 'member') {
    return (await searchMembers(query)).map(toMemberItem).slice(0, maxResults);
  }

  const rows = await searches[kind](query);
  return toItems(kind, rows).slice(0, maxResults);
};
