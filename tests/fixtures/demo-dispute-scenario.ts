import { db } from '@/database/client';
import { adminDisputeCase, disputeCaseStatus } from '@/database/schema/admin.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { walletLedgerAccount, walletLedgerTransaction } from '@/database/schema/wallet.schema';
import {
  assignmentStatus,
  questMode,
  questParticipation,
  questStatus,
} from '@/modules/quest/shared';
import {
  createSealedLedgerTransactionInTransaction,
  ensureInitialMoneyPolicy,
  ensureWalletInTransaction,
  positiveSatang,
  reserveSpending,
  signedSatang,
  type WalletTransaction,
} from '@/modules/wallet';

import { and, eq, isNull } from 'drizzle-orm';

export const frontendDemoDisputeQuestTitle = '[Demo] Failed Dispute Quest';
export const frontendDemoDisputeAmountSatang = 50_000;
export const frontendDemoDisputeReservationReference = 'frontend-demo-dispute-quest-v1';
const ensureAdminDisputeCaseInTransaction = async (
  transaction: WalletTransaction,
  questId: string,
  filerUserId: string
): Promise<{ id: string }> => {
  const [existingCase] = await transaction
    .select({
      id: adminDisputeCase.id,
    })
    .from(adminDisputeCase)
    .where(
      and(eq(adminDisputeCase.questId, questId), eq(adminDisputeCase.filerUserId, filerUserId))
    )
    .for('update');

  if (existingCase) {
    return { id: existingCase.id };
  }

  const [targetQuest] = await transaction
    .select({
      id: quest.id,
      questStatus: quest.questStatus,
      fundingReservationId: quest.fundingReservationId,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .for('update');

  if (!targetQuest) {
    throw new Error('The Quest for the Dispute Case does not exist.');
  }
  if (targetQuest.questStatus !== questStatus.failed) {
    throw new Error('The frontend demo Dispute Quest is not failed.');
  }
  if (!targetQuest.fundingReservationId) {
    throw new Error('The frontend demo Dispute Quest has no Funding Reservation.');
  }

  const [created] = await transaction
    .insert(adminDisputeCase)
    .values({
      questId,
      filerUserId,
      status: disputeCaseStatus.pending,
    })
    .onConflictDoNothing({
      target: [adminDisputeCase.questId, adminDisputeCase.filerUserId],
    })
    .returning({ id: adminDisputeCase.id });

  if (created) {
    return { id: created.id };
  }

  const [reloaded] = await transaction
    .select({ id: adminDisputeCase.id })
    .from(adminDisputeCase)
    .where(
      and(eq(adminDisputeCase.questId, questId), eq(adminDisputeCase.filerUserId, filerUserId))
    )
    .limit(1);

  if (!reloaded) {
    throw new Error('The frontend demo Dispute Case could not be created.');
  }

  return { id: reloaded.id };
};

const getSpendingWalletAccountIdInTransaction = async (
  transaction: WalletTransaction,
  userId: string
): Promise<string> => {
  const wallet = await ensureWalletInTransaction(transaction, userId);
  const [account] = await transaction
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(
      and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, 'SPENDING'))
    )
    .limit(1);
  if (!account) throw new Error('The demo SPENDING Ledger Account is missing.');
  return account.id;
};

const getPlatformSuspenseAccountIdInTransaction = async (
  transaction: WalletTransaction
): Promise<string> => {
  const [account] = await transaction
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(
      and(eq(walletLedgerAccount.type, 'PLATFORM_SUSPENSE'), isNull(walletLedgerAccount.walletId))
    )
    .limit(1);
  if (!account) throw new Error('The platform suspense Ledger Account is missing.');
  return account.id;
};

const seedDemoHirerSpendingInTransaction = async (
  transaction: WalletTransaction,
  userId: string
): Promise<void> => {
  const businessReference = `seed:frontend-demo:${userId}:spending:v1`;
  const [existing] = await transaction
    .select({ id: walletLedgerTransaction.id })
    .from(walletLedgerTransaction)
    .where(eq(walletLedgerTransaction.businessReference, businessReference))
    .limit(1);
  if (existing) return;

  const walletAccountId = await getSpendingWalletAccountIdInTransaction(transaction, userId);
  const suspenseAccountId = await getPlatformSuspenseAccountIdInTransaction(transaction);
  await createSealedLedgerTransactionInTransaction(transaction, {
    businessReference,
    eventType: 'ADJUSTMENT',
    createdByUserId: userId,
    description: 'Non-production frontend demo seed',
    postings: [
      {
        accountId: walletAccountId,
        amountSatang: signedSatang(frontendDemoDisputeAmountSatang),
      },
      {
        accountId: suspenseAccountId,
        amountSatang: signedSatang(-frontendDemoDisputeAmountSatang),
      },
    ],
  });
};

export const ensureFrontendDemoDisputeQuest = async (
  hirerId: string,
  workerId: string,
  tagId: string
): Promise<{ questId: string; disputeCaseId: string }> => {
  await ensureInitialMoneyPolicy();
  return db.transaction(async (transaction) => {
    await ensureWalletInTransaction(transaction, hirerId);
    await seedDemoHirerSpendingInTransaction(transaction, hirerId);

    const [existing] = await transaction
      .select({
        id: quest.id,
        fundingReservationId: quest.fundingReservationId,
        questStatus: quest.questStatus,
      })
      .from(quest)
      .where(and(eq(quest.hirerId, hirerId), eq(quest.title, frontendDemoDisputeQuestTitle)))
      .for('update');

    if (existing) {
      if (existing.questStatus !== questStatus.failed) {
        throw new Error('The frontend demo Dispute Quest is not failed.');
      }
      if (!existing.fundingReservationId) {
        throw new Error('The frontend demo Dispute Quest has no Funding Reservation.');
      }
      const [assignment] = await transaction
        .select({ id: questAssignment.id })
        .from(questAssignment)
        .where(
          and(eq(questAssignment.questId, existing.id), eq(questAssignment.workerId, workerId))
        )
        .limit(1);
      if (!assignment) {
        await transaction.insert(questAssignment).values({
          questId: existing.id,
          workerId,
          assignmentStatus: assignmentStatus.incomplete,
        });
      }
      const disputeCase = await ensureAdminDisputeCaseInTransaction(
        transaction,
        existing.id,
        workerId
      );
      return { questId: existing.id, disputeCaseId: disputeCase.id };
    }

    const reservation = await reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: frontendDemoDisputeReservationReference,
      amountSatang: positiveSatang(frontendDemoDisputeAmountSatang),
    });

    const failedAt = new Date(Date.now() - 60 * 60 * 1000);
    const [created] = await transaction
      .insert(quest)
      .values({
        hirerId,
        title: frontendDemoDisputeQuestTitle,
        description: 'A failed Quest for Admin Dispute review.',
        condition: 'Review the seeded Dispute Case evidence.',
        mode: questMode.noCandidate,
        participation: questParticipation.solo,
        questStatus: questStatus.failed,
        version: 1,
        rewardSatang: positiveSatang(frontendDemoDisputeAmountSatang),
        questFundingTotalSatang: positiveSatang(frontendDemoDisputeAmountSatang),
        fundingReservationId: reservation.id,
        policyRevisionId: reservation.policyRevisionId,
        platformFeeBps: 0,
        platformFeePerWorkerSatang: 0,
        questEscrowSatang: positiveSatang(frontendDemoDisputeAmountSatang),
        tagId,
        headcount: 1,
        startTime: new Date(failedAt.getTime() - 2 * 60 * 60 * 1000),
        dueAt: new Date(failedAt.getTime() - 60 * 60 * 1000),
        failedAt,
        proofRequired: true,
        createdAt: new Date(failedAt.getTime() - 3 * 60 * 60 * 1000),
        updatedAt: failedAt,
      })
      .returning({ id: quest.id });
    if (!created) throw new Error('The frontend demo Dispute Quest could not be created.');

    const [assignment] = await transaction
      .insert(questAssignment)
      .values({
        questId: created.id,
        workerId,
        assignmentStatus: assignmentStatus.incomplete,
      })
      .returning({ id: questAssignment.id });
    if (!assignment)
      throw new Error('The frontend demo Dispute Quest Assignment could not be created.');

    const disputeCase = await ensureAdminDisputeCaseInTransaction(
      transaction,
      created.id,
      workerId
    );
    return { questId: created.id, disputeCaseId: disputeCase.id };
  });
};
