import { db } from '@/database/client';
import {
  adminDisputeCase,
  disputeCaseStatus,
} from '@/database/schema/admin.schema';
import {
  paymentPayouts,
  payoutAdminApprovalStatuses,
  payoutProviderInFlightStatuses,
  payoutStatus,
} from '@/database/schema/payment.schema';
import { quest } from '@/database/schema/quest.schema';
import {
  walletAdminHoldStatuses,
  walletStatus,
  walletWallet,
} from '@/database/schema/wallet.schema';

import { and, count, inArray, isNotNull } from 'drizzle-orm';

import { adminOverviewQuestStates } from './admin-overview.contract';
import type { AdminOverviewData } from './admin-overview.schema';

const payoutQueueStatuses = [
  ...payoutAdminApprovalStatuses,
  ...payoutProviderInFlightStatuses,
] as const;

const emptyQuestStateCounts = (): AdminOverviewData['quests']['byState'] =>
  Object.fromEntries(
    adminOverviewQuestStates.map((status) => [status, 0]),
  ) as AdminOverviewData['quests']['byState'];

export const getAdminOverview = async (): Promise<AdminOverviewData> =>
  db.transaction(async (transaction) => {
    const questStatusRows = await transaction
      .select({ questStatus: quest.questStatus, total: count() })
      .from(quest)
      .where(inArray(quest.questStatus, adminOverviewQuestStates))
      .groupBy(quest.questStatus);
    const hiddenQuestRows = await transaction
      .select({ total: count() })
      .from(quest)
      .where(and(
        isNotNull(quest.hiddenAt),
        inArray(quest.questStatus, adminOverviewQuestStates),
      ));
    const disputeStatusRows = await transaction
      .select({ status: adminDisputeCase.status, total: count() })
      .from(adminDisputeCase)
      .groupBy(adminDisputeCase.status);
    const payoutStatusRows = await transaction
      .select({ status: paymentPayouts.payoutStatus, total: count() })
      .from(paymentPayouts)
      .where(inArray(paymentPayouts.payoutStatus, payoutQueueStatuses))
      .groupBy(paymentPayouts.payoutStatus);
    const walletStatusRows = await transaction
      .select({ status: walletWallet.walletStatus, total: count() })
      .from(walletWallet)
      .where(inArray(walletWallet.walletStatus, walletAdminHoldStatuses))
      .groupBy(walletWallet.walletStatus);

    const byState = emptyQuestStateCounts();
    for (const row of questStatusRows) {
      if (adminOverviewQuestStates.includes(row.questStatus as (typeof adminOverviewQuestStates)[number])) {
        byState[row.questStatus as (typeof adminOverviewQuestStates)[number]] = row.total;
      }
    }

    const countFor = <T extends string>(rows: Array<{ status: T; total: number }>, status: T) =>
      rows.find((row) => row.status === status)?.total ?? 0;

    return {
      quests: {
        total: questStatusRows.reduce((total, row) => total + row.total, 0),
        hidden: hiddenQuestRows[0]?.total ?? 0,
        byState,
      },
      disputes: {
        total: disputeStatusRows.reduce((total, row) => total + row.total, 0),
        awaitingResolution: countFor(disputeStatusRows, disputeCaseStatus.pending),
      },
      payouts: {
        pendingAdminApproval: countFor(payoutStatusRows, payoutStatus.pendingAdminApproval),
        inFlight: countFor(payoutStatusRows, payoutStatus.submittedToProvider)
          + countFor(payoutStatusRows, payoutStatus.providerPending),
      },
      members: {
        frozenWallets: countFor(walletStatusRows, walletStatus.frozen),
        suspendedWallets: countFor(walletStatusRows, walletStatus.suspended),
      },
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
