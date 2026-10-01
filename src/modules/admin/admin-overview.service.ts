import { db } from '@/database/client';
import {
  adminConductReport,
  adminDisputeCase,
  adminReportCase,
  conductReportStatus,
  disputeCaseStatus,
  memberPenaltyRecord,
  reportCaseStatus,
} from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { chatConversation, chatMessage } from '@/database/schema/work-chat.schema';
import {
  paymentPayouts,
  payoutAdminApprovalStatuses,
  payoutProviderInFlightStatuses,
  payoutStatus,
} from '@/database/schema/payment.schema';
import { quest } from '@/database/schema/quest.schema';
import { walletStatus, walletStatuses, walletWallet } from '@/database/schema/wallet.schema';

import { and, asc, count, eq, exists, inArray, isNotNull, not, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { adminOverviewQuestStates } from './admin-overview.contract';
import {
  formatConductReportDisplayId,
  formatDisputeDisplayId,
  formatPayoutDisplayId,
  formatReportCaseDisplayId,
} from './admin-display-id';
import type { AdminOverviewData } from './admin-overview.schema';

const payoutQueueStatuses = [
  ...payoutAdminApprovalStatuses,
  ...payoutProviderInFlightStatuses,
] as const;

const reportQueueStatuses = [reportCaseStatus.pending, reportCaseStatus.hidden] as const;

type MemberOverviewStatus = keyof AdminOverviewData['members']['byStatus'];

const memberPenaltyReversal = alias(memberPenaltyRecord, 'admin_overview_member_penalty_reversal');

const emptyMemberStatusCounts = (): AdminOverviewData['members']['byStatus'] => ({
  NORMAL: 0,
  FLAG: 0,
  TEMP_BAN: 0,
  PERM_BAN: 0,
});

const emptyWalletStatusCounts = (): AdminOverviewData['wallets']['byStatus'] =>
  Object.fromEntries(
    walletStatuses.map((status) => [status, 0])
  ) as AdminOverviewData['wallets']['byStatus'];

const queueSummary = (
  queueCount: number,
  oldest: AdminOverviewData['queues']['payouts']['oldest']
) => ({
  count: queueCount,
  state: queueCount === 0 ? ('CLEAR' as const) : ('OPEN' as const),
  oldest,
});

const emptyQuestStateCounts = (): AdminOverviewData['quests']['byState'] =>
  Object.fromEntries(
    adminOverviewQuestStates.map((status) => [status, 0])
  ) as AdminOverviewData['quests']['byState'];

export const getAdminOverview = async (): Promise<AdminOverviewData> =>
  db.transaction(
    async (transaction) => {
      const questStatusRows = await transaction
        .select({ questStatus: quest.questStatus, total: count() })
        .from(quest)
        .where(inArray(quest.questStatus, adminOverviewQuestStates))
        .groupBy(quest.questStatus);
      const hiddenQuestRows = await transaction
        .select({ total: count() })
        .from(quest)
        .where(
          and(isNotNull(quest.hiddenAt), inArray(quest.questStatus, adminOverviewQuestStates))
        );
      const disputeStatusRows = await transaction
        .select({ status: adminDisputeCase.status, total: count() })
        .from(adminDisputeCase)
        .groupBy(adminDisputeCase.status);
      const payoutStatusRows = await transaction
        .select({ status: paymentPayouts.payoutStatus, total: count() })
        .from(paymentPayouts)
        .where(inArray(paymentPayouts.payoutStatus, payoutQueueStatuses))
        .groupBy(paymentPayouts.payoutStatus);
      const reportStatusRows = await transaction
        .select({ status: adminReportCase.status, total: count() })
        .from(adminReportCase)
        .groupBy(adminReportCase.status);
      const conductReportStatusRows = await transaction
        .select({ status: adminConductReport.status, total: count() })
        .from(adminConductReport)
        .groupBy(adminConductReport.status);

      const permanentBanWithoutReversal = exists(
        transaction
          .select({ id: memberPenaltyRecord.id })
          .from(memberPenaltyRecord)
          .where(
            and(
              eq(memberPenaltyRecord.memberId, authUser.id),
              eq(memberPenaltyRecord.result, 'PENALTY_PERMANENT_BAN'),
              not(
                exists(
                  transaction
                    .select({ id: memberPenaltyReversal.id })
                    .from(memberPenaltyReversal)
                    .where(eq(memberPenaltyReversal.reversalOfRecordId, memberPenaltyRecord.id))
                )
              )
            )
          )
      );
      const memberStatus = sql<MemberOverviewStatus>`case
        when ${permanentBanWithoutReversal} then 'PERM_BAN'
        when ${authUser.bannedUntil} > now() then 'TEMP_BAN'
        when ${authUser.redFlagExpiresAt} > now() then 'FLAG'
        else 'NORMAL'
      end`;
      const memberStatusRows = await transaction
        .select({ status: memberStatus, total: count() })
        .from(authUser)
        .groupBy(memberStatus);
      const walletStatusRows = await transaction
        .select({ status: walletWallet.walletStatus, total: count() })
        .from(walletWallet)
        .where(inArray(walletWallet.walletStatus, walletStatuses))
        .groupBy(walletWallet.walletStatus);

      const oldestPayoutRows = await transaction
        .select({
          id: paymentPayouts.id,
          publicSequence: paymentPayouts.publicSequence,
          createdAt: paymentPayouts.createdAt,
        })
        .from(paymentPayouts)
        .where(eq(paymentPayouts.payoutStatus, payoutStatus.pendingAdminApproval))
        .orderBy(asc(paymentPayouts.createdAt), asc(paymentPayouts.id))
        .limit(1);
      const oldestDisputeRows = await transaction
        .select({
          id: adminDisputeCase.id,
          publicSequence: adminDisputeCase.publicSequence,
          title: quest.title,
          createdAt: adminDisputeCase.createdAt,
        })
        .from(adminDisputeCase)
        .innerJoin(quest, eq(quest.id, adminDisputeCase.questId))
        .where(eq(adminDisputeCase.status, disputeCaseStatus.pending))
        .orderBy(asc(adminDisputeCase.createdAt), asc(adminDisputeCase.id))
        .limit(1);
      const oldestReportRows = await transaction
        .select({
          id: adminReportCase.id,
          publicSequence: adminReportCase.publicSequence,
          title: chatConversation.questTitle,
          createdAt: adminReportCase.createdAt,
        })
        .from(adminReportCase)
        .innerJoin(chatMessage, eq(chatMessage.id, adminReportCase.messageId))
        .innerJoin(chatConversation, eq(chatConversation.id, chatMessage.conversationId))
        .where(inArray(adminReportCase.status, reportQueueStatuses))
        .orderBy(asc(adminReportCase.createdAt), asc(adminReportCase.id))
        .limit(1);
      const oldestConductReportRows = await transaction
        .select({
          id: adminConductReport.id,
          publicSequence: adminConductReport.publicSequence,
          title: quest.title,
          createdAt: adminConductReport.createdAt,
        })
        .from(adminConductReport)
        .innerJoin(quest, eq(quest.id, adminConductReport.questId))
        .where(eq(adminConductReport.status, conductReportStatus.pending))
        .orderBy(asc(adminConductReport.createdAt), asc(adminConductReport.id))
        .limit(1);

      const byState = emptyQuestStateCounts();
      for (const row of questStatusRows) {
        if (
          adminOverviewQuestStates.includes(
            row.questStatus as (typeof adminOverviewQuestStates)[number]
          )
        ) {
          byState[row.questStatus as (typeof adminOverviewQuestStates)[number]] = row.total;
        }
      }

      const walletsByStatus = emptyWalletStatusCounts();
      for (const row of walletStatusRows) {
        walletsByStatus[row.status] = row.total;
      }

      const membersByStatus = emptyMemberStatusCounts();
      for (const row of memberStatusRows) {
        membersByStatus[row.status] = row.total;
      }

      const countFor = <T extends string>(rows: Array<{ status: T; total: number }>, status: T) =>
        rows.find((row) => row.status === status)?.total ?? 0;
      const reportsOpen =
        countFor(reportStatusRows, reportCaseStatus.pending) +
        countFor(reportStatusRows, reportCaseStatus.hidden);
      const conductReportsOpen = countFor(conductReportStatusRows, conductReportStatus.pending);
      const payoutQueueCount = countFor(payoutStatusRows, payoutStatus.pendingAdminApproval);
      const disputeQueueCount = countFor(disputeStatusRows, disputeCaseStatus.pending);

      return {
        quests: {
          total: questStatusRows.reduce((total, row) => total + row.total, 0),
          hidden: hiddenQuestRows[0]?.total ?? 0,
          byState,
        },
        disputes: {
          total: disputeStatusRows.reduce((total, row) => total + row.total, 0),
          awaitingResolution: disputeQueueCount,
        },
        payouts: {
          pendingAdminApproval: countFor(payoutStatusRows, payoutStatus.pendingAdminApproval),
          inFlight:
            countFor(payoutStatusRows, payoutStatus.submittedToProvider) +
            countFor(payoutStatusRows, payoutStatus.providerPending),
        },
        reports: { open: reportsOpen },
        conductReports: { open: conductReportsOpen },
        members: {
          byStatus: membersByStatus,
          frozenWallets: countFor(walletStatusRows, walletStatus.frozen),
          suspendedWallets: countFor(walletStatusRows, walletStatus.suspended),
        },
        wallets: { byStatus: walletsByStatus },
        queues: {
          payouts: queueSummary(
            payoutQueueCount,
            oldestPayoutRows[0]
              ? {
                  id: oldestPayoutRows[0].id,
                  displayId: formatPayoutDisplayId(oldestPayoutRows[0].publicSequence),
                  title: 'Payout review',
                  createdAt: oldestPayoutRows[0].createdAt.toISOString(),
                }
              : null
          ),
          disputes: queueSummary(
            disputeQueueCount,
            oldestDisputeRows[0]
              ? {
                  id: oldestDisputeRows[0].id,
                  displayId: formatDisputeDisplayId(oldestDisputeRows[0].publicSequence),
                  title: oldestDisputeRows[0].title,
                  createdAt: oldestDisputeRows[0].createdAt.toISOString(),
                }
              : null
          ),
          reports: queueSummary(
            reportsOpen,
            oldestReportRows[0]
              ? {
                  id: oldestReportRows[0].id,
                  displayId: formatReportCaseDisplayId(oldestReportRows[0].publicSequence),
                  title: oldestReportRows[0].title,
                  createdAt: oldestReportRows[0].createdAt.toISOString(),
                }
              : null
          ),
          conductReports: queueSummary(
            conductReportsOpen,
            oldestConductReportRows[0]
              ? {
                  id: oldestConductReportRows[0].id,
                  displayId: formatConductReportDisplayId(
                    oldestConductReportRows[0].publicSequence
                  ),
                  title: oldestConductReportRows[0].title,
                  createdAt: oldestConductReportRows[0].createdAt.toISOString(),
                }
              : null
          ),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
