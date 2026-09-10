import { db } from '@/database/client';
import { adminDisputeCase } from '@/database/schema/admin.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { quest } from '@/database/schema/quest.schema';
import { walletWallet } from '@/database/schema/wallet.schema';

import { and, count, inArray, isNotNull } from 'drizzle-orm';

import { adminOverviewQuestStates } from './admin-overview.contract';

export type AdminOverviewCounters = {
  quests: {
    total: number;
    hidden: number;
    byStatus: Record<(typeof adminOverviewQuestStates)[number], number>;
  };
  disputes: {
    total: number;
    awaitingResolution: number;
  };
  payouts: {
    pendingAdminApproval: number;
    inFlight: number;
  };
  members: {
    frozenWallets: number;
    suspendedWallets: number;
  };
};

const payoutQueueStatuses = [
  'PENDING_ADMIN_APPROVAL',
  'SUBMITTED_TO_PROVIDER',
  'PROVIDER_PENDING',
] as const;
const walletQueueStatuses = ['FROZEN', 'SUSPENDED'] as const;

const emptyQuestStatusCounts = (): Record<(typeof adminOverviewQuestStates)[number], number> =>
  Object.fromEntries(adminOverviewQuestStates.map((status) => [status, 0])) as Record<
    (typeof adminOverviewQuestStates)[number],
    number
  >;

export const getAdminOverview = async (): Promise<AdminOverviewCounters> =>
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
      .where(inArray(walletWallet.walletStatus, walletQueueStatuses))
      .groupBy(walletWallet.walletStatus);

    const byStatus = emptyQuestStatusCounts();
    for (const row of questStatusRows) {
      if (adminOverviewQuestStates.includes(row.questStatus as (typeof adminOverviewQuestStates)[number])) {
        byStatus[row.questStatus as (typeof adminOverviewQuestStates)[number]] = row.total;
      }
    }

    const countFor = <T extends string>(rows: Array<{ status: T; total: number }>, status: T) =>
      rows.find((row) => row.status === status)?.total ?? 0;

    return {
      quests: {
        total: questStatusRows.reduce((total, row) => total + row.total, 0),
        hidden: hiddenQuestRows[0]?.total ?? 0,
        byStatus,
      },
      disputes: {
        total: disputeStatusRows.reduce((total, row) => total + row.total, 0),
        awaitingResolution: countFor(disputeStatusRows, 'DISPUTE_CASE_PENDING'),
      },
      payouts: {
        pendingAdminApproval: countFor(payoutStatusRows, 'PENDING_ADMIN_APPROVAL'),
        inFlight: countFor(payoutStatusRows, 'SUBMITTED_TO_PROVIDER')
          + countFor(payoutStatusRows, 'PROVIDER_PENDING'),
      },
      members: {
        frozenWallets: countFor(walletStatusRows, 'FROZEN'),
        suspendedWallets: countFor(walletStatusRows, 'SUSPENDED'),
      },
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
