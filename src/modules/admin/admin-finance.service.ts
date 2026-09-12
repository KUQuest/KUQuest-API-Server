import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { paymentPayouts, paymentTopUps } from '@/database/schema/payment.schema';
import { quest } from '@/database/schema/quest.schema';
import {
  paymentMoneyPolicyRevision,
  walletActivity,
  walletDisputeSettlement,
  walletEarningsConversion,
  walletFundingReservation,
  walletFundingReservationOperation,
  walletFundingReservationSettlement,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { decodeCursor, encodeCursor } from '@/shared/cursor';

import { and, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

import type {
  AdminFinanceOverviewData,
  AdminLedgerTransactionsData,
  AdminLedgerTransactionsQuery,
  AdminMemberFinanceData,
  AdminMoneyPolicyItem,
  AdminQuestFinanceData,
} from './admin-finance.schema';

export const getAdminQuestFinance = async (
  questId: string,
): Promise<AdminQuestFinanceData | null> => {
  const [questRow] = await db
    .select({
      id: quest.id,
      title: quest.title,
      questStatus: quest.questStatus,
      headcount: quest.headcount,
      rewardSatang: quest.rewardSatang,
      platformFeePerWorkerSatang: quest.platformFeePerWorkerSatang,
      questFundingTotalSatang: quest.questFundingTotalSatang,
      fundingReservationId: quest.fundingReservationId,
      hirerId: quest.hirerId,
      hirerFirstName: authUser.firstName,
      hirerLastName: authUser.lastName,
      hirerStudentId: authUser.studentId,
    })
    .from(quest)
    .innerJoin(authUser, eq(quest.hirerId, authUser.id))
    .where(eq(quest.id, questId));

  if (!questRow) {
    return null;
  }

  let reservationData: AdminQuestFinanceData['reservation'] = null;
  const transfers: AdminQuestFinanceData['transfers'] = [];
  const ledgerTransactionIds = new Set<string>();

  if (questRow.fundingReservationId) {
    const [reservation] = await db
      .select()
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.id, questRow.fundingReservationId));

    if (reservation) {
      reservationData = {
        id: reservation.id,
        status: reservation.status,
        totalReservedSatang: reservation.totalReservedSatang,
        remainingSatang: reservation.remainingSatang,
        createdAt: reservation.createdAt.toISOString(),
      };
      ledgerTransactionIds.add(reservation.createdLedgerTransactionId);

      // 1. Initial reservation step
      transfers.push({
        id: `reserve-${reservation.id}`,
        occurredAt: reservation.createdAt.toISOString(),
        type: 'RESERVE',
        from: {
          type: 'HIRER',
          id: questRow.hirerId,
          displayName: `${questRow.hirerFirstName} ${questRow.hirerLastName}`,
        },
        to: {
          type: 'QUEST_ESCROW',
          id: reservation.id,
          displayName: `Quest Escrow (${questRow.title})`,
        },
        amountSatang: reservation.totalReservedSatang,
        platformFeeSatang: 0,
        description: 'Initial Quest Escrow funding reservation from Hirer Spending Balance',
        ledgerTransactionId: reservation.createdLedgerTransactionId,
        businessReference: `funding-reserve:${reservation.id}`,
      });

      // 2. Fetch settlements (escrow -> worker earnings + platform revenue)
      const settlements = await db
        .select({
          id: walletFundingReservationSettlement.id,
          settlementReference: walletFundingReservationSettlement.settlementReference,
          recipientUserId: walletFundingReservationSettlement.recipientUserId,
          recipientAmountSatang: walletFundingReservationSettlement.recipientAmountSatang,
          platformFeeSatang: walletFundingReservationSettlement.platformFeeSatang,
          totalAmountSatang: walletFundingReservationSettlement.totalAmountSatang,
          ledgerTransactionId: walletFundingReservationSettlement.ledgerTransactionId,
          createdAt: walletFundingReservationSettlement.createdAt,
          workerFirstName: authUser.firstName,
          workerLastName: authUser.lastName,
        })
        .from(walletFundingReservationSettlement)
        .innerJoin(authUser, eq(walletFundingReservationSettlement.recipientUserId, authUser.id))
        .where(eq(walletFundingReservationSettlement.reservationId, reservation.id));

      for (const settlement of settlements) {
        ledgerTransactionIds.add(settlement.ledgerTransactionId);
        transfers.push({
          id: `settlement-${settlement.id}`,
          occurredAt: settlement.createdAt.toISOString(),
          type: 'SETTLEMENT',
          from: {
            type: 'QUEST_ESCROW',
            id: reservation.id,
            displayName: `Quest Escrow (${questRow.title})`,
          },
          to: {
            type: 'WORKER',
            id: settlement.recipientUserId,
            displayName: `${settlement.workerFirstName} ${settlement.workerLastName}`,
          },
          amountSatang: settlement.recipientAmountSatang,
          platformFeeSatang: settlement.platformFeeSatang,
          description: `Reward settlement of ${settlement.recipientAmountSatang} Satang to Worker with ${settlement.platformFeeSatang} Satang Platform Fee`,
          ledgerTransactionId: settlement.ledgerTransactionId,
          businessReference: settlement.settlementReference,
        });
      }

      // 3. Fetch operations (specifically RELEASE operations)
      const operations = await db
        .select()
        .from(walletFundingReservationOperation)
        .where(eq(walletFundingReservationOperation.reservationId, reservation.id));

      for (const operation of operations) {
        ledgerTransactionIds.add(operation.ledgerTransactionId);
        if (operation.operationType === 'RELEASE') {
          transfers.push({
            id: `release-${operation.id}`,
            occurredAt: operation.createdAt.toISOString(),
            type: 'RELEASE',
            from: {
              type: 'QUEST_ESCROW',
              id: reservation.id,
              displayName: `Quest Escrow (${questRow.title})`,
            },
            to: {
              type: 'HIRER',
              id: questRow.hirerId,
              displayName: `${questRow.hirerFirstName} ${questRow.hirerLastName}`,
            },
            amountSatang: operation.amountSatang,
            platformFeeSatang: 0,
            description: `Release of ${operation.amountSatang} Satang unspent Escrow back to Hirer Spending Balance`,
            ledgerTransactionId: operation.ledgerTransactionId,
            businessReference: operation.operationReference,
          });
        }
      }

      // 4. Fetch dispute settlements
      const disputeSettlements = await db
        .select({
          id: walletDisputeSettlement.id,
          settlementReference: walletDisputeSettlement.settlementReference,
          recipientUserId: walletDisputeSettlement.recipientUserId,
          amountSatang: walletDisputeSettlement.amountSatang,
          ledgerTransactionId: walletDisputeSettlement.ledgerTransactionId,
          createdAt: walletDisputeSettlement.createdAt,
          workerFirstName: authUser.firstName,
          workerLastName: authUser.lastName,
        })
        .from(walletDisputeSettlement)
        .innerJoin(authUser, eq(walletDisputeSettlement.recipientUserId, authUser.id))
        .where(eq(walletDisputeSettlement.reservationId, reservation.id));

      for (const dispute of disputeSettlements) {
        ledgerTransactionIds.add(dispute.ledgerTransactionId);
        transfers.push({
          id: `dispute-${dispute.id}`,
          occurredAt: dispute.createdAt.toISOString(),
          type: 'DISPUTE_SETTLEMENT',
          from: {
            type: 'QUEST_ESCROW',
            id: reservation.id,
            displayName: `Quest Escrow (${questRow.title})`,
          },
          to: {
            type: 'WORKER',
            id: dispute.recipientUserId,
            displayName: `${dispute.workerFirstName} ${dispute.workerLastName}`,
          },
          amountSatang: dispute.amountSatang,
          platformFeeSatang: 0,
          description: `Dispute resolution payment of ${dispute.amountSatang} Satang to Worker`,
          ledgerTransactionId: dispute.ledgerTransactionId,
          businessReference: dispute.settlementReference,
        });
      }
    }
  }

  // Sort transfers chronologically
  transfers.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

  // Fetch full ledger transactions and postings
  const ledgerTransactions: AdminQuestFinanceData['ledgerTransactions'] = [];
  if (ledgerTransactionIds.size > 0) {
    const txRows = await db
      .select({
        id: walletLedgerTransaction.id,
        businessReference: walletLedgerTransaction.businessReference,
        eventType: walletLedgerTransaction.eventType,
        description: walletLedgerTransaction.description,
        createdAt: walletLedgerTransaction.createdAt,
        sealedAt: walletLedgerTransaction.sealedAt,
      })
      .from(walletLedgerTransaction)
      .where(inArray(walletLedgerTransaction.id, Array.from(ledgerTransactionIds)))
      .orderBy(walletLedgerTransaction.createdAt);

    const postingRows = await db
      .select({
        id: walletLedgerPosting.id,
        transactionId: walletLedgerPosting.transactionId,
        accountId: walletLedgerPosting.accountId,
        amountSatang: walletLedgerPosting.amountSatang,
        accountType: walletLedgerAccount.type,
        walletId: walletLedgerAccount.walletId,
        ownerUserId: walletWallet.userId,
      })
      .from(walletLedgerPosting)
      .innerJoin(walletLedgerAccount, eq(walletLedgerPosting.accountId, walletLedgerAccount.id))
      .leftJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
      .where(inArray(walletLedgerPosting.transactionId, Array.from(ledgerTransactionIds)));

    const postingsByTx = new Map<string, typeof postingRows>();
    for (const p of postingRows) {
      const list = postingsByTx.get(p.transactionId) ?? [];
      list.push(p);
      postingsByTx.set(p.transactionId, list);
    }

    for (const tx of txRows) {
      const txPostings = postingsByTx.get(tx.id) ?? [];
      ledgerTransactions.push({
        id: tx.id,
        businessReference: tx.businessReference,
        eventType: tx.eventType,
        description: tx.description,
        createdAt: tx.createdAt.toISOString(),
        sealedAt: tx.sealedAt ? tx.sealedAt.toISOString() : null,
        postings: txPostings.map((p) => ({
          id: p.id,
          accountId: p.accountId,
          accountType: p.accountType,
          walletId: p.walletId,
          ownerUserId: p.ownerUserId,
          amountSatang: p.amountSatang,
        })),
      });
    }
  }

  return {
    quest: {
      id: questRow.id,
      title: questRow.title,
      questStatus: questRow.questStatus,
      headcount: questRow.headcount,
      rewardSatang: questRow.rewardSatang,
      platformFeePerWorkerSatang: questRow.platformFeePerWorkerSatang,
      questFundingTotalSatang: questRow.questFundingTotalSatang,
      hirer: {
        id: questRow.hirerId,
        firstName: questRow.hirerFirstName,
        lastName: questRow.hirerLastName,
        studentId: questRow.hirerStudentId,
      },
    },
    reservation: reservationData,
    transfers,
    ledgerTransactions,
  };
};

export const listAdminLedgerTransactions = async (
  query: AdminLedgerTransactionsQuery,
): Promise<AdminLedgerTransactionsData> => {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const conditions = [];

  if (query.eventType) {
    conditions.push(eq(walletLedgerTransaction.eventType, query.eventType));
  }
  if (query.businessReference) {
    conditions.push(ilike(walletLedgerTransaction.businessReference, `%${query.businessReference}%`));
  }
  if (query.from) {
    conditions.push(gte(walletLedgerTransaction.createdAt, new Date(query.from)));
  }
  if (query.to) {
    conditions.push(lte(walletLedgerTransaction.createdAt, new Date(query.to)));
  }

  // Filter by userId or walletId if provided
  if (query.userId) {
    const userTxIds = db
      .select({ transactionId: walletLedgerPosting.transactionId })
      .from(walletLedgerPosting)
      .innerJoin(walletLedgerAccount, eq(walletLedgerPosting.accountId, walletLedgerAccount.id))
      .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
      .where(eq(walletWallet.userId, query.userId));

    conditions.push(inArray(walletLedgerTransaction.id, userTxIds));
  } else if (query.walletId) {
    const walletTxIds = db
      .select({ transactionId: walletLedgerPosting.transactionId })
      .from(walletLedgerPosting)
      .innerJoin(walletLedgerAccount, eq(walletLedgerPosting.accountId, walletLedgerAccount.id))
      .where(eq(walletLedgerAccount.walletId, query.walletId));

    conditions.push(inArray(walletLedgerTransaction.id, walletTxIds));
  }

  // Cursor handling
  if (query.cursor) {
    const parsed = decodeCursor(query.cursor);
    if (parsed) {
      const cursorDate = new Date(parsed.startTime);
      conditions.push(
        or(
          lt(walletLedgerTransaction.createdAt, cursorDate),
          and(
            eq(walletLedgerTransaction.createdAt, cursorDate),
            lt(walletLedgerTransaction.id, parsed.id),
          ),
        ),
      );
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const txRows = await db
    .select({
      id: walletLedgerTransaction.id,
      businessReference: walletLedgerTransaction.businessReference,
      eventType: walletLedgerTransaction.eventType,
      description: walletLedgerTransaction.description,
      createdByUserId: walletLedgerTransaction.createdByUserId,
      correctionOfTransactionId: walletLedgerTransaction.correctionOfTransactionId,
      createdAt: walletLedgerTransaction.createdAt,
      sealedAt: walletLedgerTransaction.sealedAt,
    })
    .from(walletLedgerTransaction)
    .where(whereClause)
    .orderBy(desc(walletLedgerTransaction.createdAt), desc(walletLedgerTransaction.id))
    .limit(limit + 1);

  const hasNextPage = txRows.length > limit;
  const pageRows = hasNextPage ? txRows.slice(0, limit) : txRows;

  let nextCursor: string | null = null;
  if (hasNextPage && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      id: last.id,
      startTime: last.createdAt.toISOString(),
    });
  }

  const txIds = pageRows.map((r) => r.id);
  const items: AdminLedgerTransactionsData['items'] = [];

  if (txIds.length > 0) {
    const postingRows = await db
      .select({
        id: walletLedgerPosting.id,
        transactionId: walletLedgerPosting.transactionId,
        accountId: walletLedgerPosting.accountId,
        accountType: walletLedgerAccount.type,
        walletId: walletLedgerAccount.walletId,
        amountSatang: walletLedgerPosting.amountSatang,
        userId: authUser.id,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
        studentId: authUser.studentId,
      })
      .from(walletLedgerPosting)
      .innerJoin(walletLedgerAccount, eq(walletLedgerPosting.accountId, walletLedgerAccount.id))
      .leftJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
      .leftJoin(authUser, eq(walletWallet.userId, authUser.id))
      .where(inArray(walletLedgerPosting.transactionId, txIds));

    const postingsByTx = new Map<string, typeof postingRows>();
    for (const p of postingRows) {
      const list = postingsByTx.get(p.transactionId) ?? [];
      list.push(p);
      postingsByTx.set(p.transactionId, list);
    }

    for (const tx of pageRows) {
      const txPostings = postingsByTx.get(tx.id) ?? [];
      const sum = txPostings.reduce((total, p) => total + p.amountSatang, 0);

      items.push({
        id: tx.id,
        businessReference: tx.businessReference,
        eventType: tx.eventType,
        description: tx.description,
        createdByUserId: tx.createdByUserId,
        correctionOfTransactionId: tx.correctionOfTransactionId,
        createdAt: tx.createdAt.toISOString(),
        sealedAt: tx.sealedAt ? tx.sealedAt.toISOString() : null,
        isBalanced: sum === 0,
        postings: txPostings.map((p) => ({
          id: p.id,
          accountId: p.accountId,
          accountType: p.accountType,
          walletId: p.walletId,
          amountSatang: p.amountSatang,
          member: p.userId
            ? {
                userId: p.userId,
                firstName: p.firstName ?? '',
                lastName: p.lastName ?? '',
                studentId: p.studentId,
              }
            : null,
        })),
      });
    }
  }

  return {
    items,
    nextCursor,
  };
};

export const getAdminFinanceOverview = async (): Promise<AdminFinanceOverviewData> => {
  // Aggregate account balances from ledger postings
  const accountBalances = await db
    .select({
      type: walletLedgerAccount.type,
      totalSatang: sql<string>`coalesce(sum(${walletLedgerPosting.amountSatang}), 0)::text`,
    })
    .from(walletLedgerPosting)
    .innerJoin(walletLedgerAccount, eq(walletLedgerPosting.accountId, walletLedgerAccount.id))
    .groupBy(walletLedgerAccount.type);

  const balancesMap = new Map<string, number>();
  for (const b of accountBalances) {
    balancesMap.set(b.type, Number(b.totalSatang));
  }

  const revenueSatang = balancesMap.get('PLATFORM_REVENUE') ?? 0;
  const suspenseSatang = balancesMap.get('PLATFORM_SUSPENSE') ?? 0;
  const spendingSatang = balancesMap.get('SPENDING') ?? 0;
  const earningsSatang = balancesMap.get('EARNINGS') ?? 0;
  const fundingReservedSatang = balancesMap.get('FUNDING_RESERVED') ?? 0;
  const payoutReservedSatang = balancesMap.get('RESERVED_FOR_PAYOUTS') ?? 0;

  // Aggregate top-up deposited volume
  const [topUpRow] = await db
    .select({
      totalSatang: sql<string>`coalesce(sum(${paymentTopUps.creditSatang}), 0)::text`,
    })
    .from(paymentTopUps)
    .where(eq(paymentTopUps.topUpStatus, 'PAID'));

  // Aggregate payout completed volume
  const [payoutRow] = await db
    .select({
      totalSatang: sql<string>`coalesce(sum(${paymentPayouts.principalSatang}), 0)::text`,
    })
    .from(paymentPayouts)
    .where(eq(paymentPayouts.payoutStatus, 'SUCCEEDED'));

  // Double-entry balancing invariant check: sum of all postings must be 0
  const [discrepancyRow] = await db
    .select({
      discrepancySatang: sql<string>`coalesce(sum(${walletLedgerPosting.amountSatang}), 0)::text`,
    })
    .from(walletLedgerPosting);

  const discrepancy = Number(discrepancyRow?.discrepancySatang ?? 0);

  return {
    platformBalances: {
      revenueSatang,
      suspenseSatang,
    },
    memberBalancesSummary: {
      totalSpendingSatang: spendingSatang,
      totalEarningsSatang: earningsSatang,
      totalFundingReservedSatang: fundingReservedSatang,
      totalPayoutReservedSatang: payoutReservedSatang,
      totalCirculatingSatang: spendingSatang + earningsSatang + fundingReservedSatang + payoutReservedSatang,
    },
    volumeLifetime: {
      totalTopUpDepositedSatang: Number(topUpRow?.totalSatang ?? 0),
      totalPayoutCompletedSatang: Number(payoutRow?.totalSatang ?? 0),
      totalPlatformFeesEarnedSatang: revenueSatang,
    },
    integrity: {
      subledgerBalanced: discrepancy === 0,
      totalPostingsDiscrepancySatang: discrepancy,
      lastAuditedAt: new Date().toISOString(),
    },
  };
};

export const getAdminMemberFinanceProfile = async (
  userId: string,
): Promise<AdminMemberFinanceData | null> => {
  const [member] = await db
    .select({
      userId: authUser.id,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      studentId: authUser.studentId,
      email: authUser.email,
    })
    .from(authUser)
    .where(eq(authUser.id, userId));

  if (!member) {
    return null;
  }

  const [wallet] = await db
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));

  let walletData: AdminMemberFinanceData['wallet'] = null;

  if (wallet) {
    // Check projection against ledger
    const accountRows = await db
      .select({
        type: walletLedgerAccount.type,
        balanceSatang: sql<string>`coalesce(sum(${walletLedgerPosting.amountSatang}), 0)::text`,
      })
      .from(walletLedgerAccount)
      .leftJoin(walletLedgerPosting, eq(walletLedgerAccount.id, walletLedgerPosting.accountId))
      .where(eq(walletLedgerAccount.walletId, wallet.id))
      .groupBy(walletLedgerAccount.type);

    const ledgerBalances = new Map<string, number>();
    for (const a of accountRows) {
      ledgerBalances.set(a.type, Number(a.balanceSatang));
    }

    const matches =
      wallet.spendingBalanceSatang === (ledgerBalances.get('SPENDING') ?? 0) &&
      wallet.earningsBalanceSatang === (ledgerBalances.get('EARNINGS') ?? 0) &&
      wallet.fundingReservedSatang === (ledgerBalances.get('FUNDING_RESERVED') ?? 0) &&
      wallet.reservedForPayoutsSatang === (ledgerBalances.get('RESERVED_FOR_PAYOUTS') ?? 0);

    walletData = {
      id: wallet.id,
      walletStatus: wallet.walletStatus,
      spendingBalanceSatang: wallet.spendingBalanceSatang,
      earningsBalanceSatang: wallet.earningsBalanceSatang,
      fundingReservedSatang: wallet.fundingReservedSatang,
      reservedForPayoutsSatang: wallet.reservedForPayoutsSatang,
      projectionMatchesLedger: matches,
    };
  }

  // Lifetime activity stats
  const [topUpStats] = await db
    .select({
      total: sql<string>`coalesce(sum(${walletActivity.spendingDeltaSatang}), 0)::text`,
    })
    .from(walletActivity)
    .where(and(eq(walletActivity.userId, userId), eq(walletActivity.type, 'TOP_UP')));

  const [earningsStats] = await db
    .select({
      total: sql<string>`coalesce(sum(${walletActivity.earningsDeltaSatang}), 0)::text`,
    })
    .from(walletActivity)
    .where(and(eq(walletActivity.userId, userId), eq(walletActivity.type, 'EARN')));

  const [payoutStats] = await db
    .select({
      total: sql<string>`coalesce(sum(${paymentPayouts.principalSatang}), 0)::text`,
    })
    .from(paymentPayouts)
    .where(and(eq(paymentPayouts.userId, userId), eq(paymentPayouts.payoutStatus, 'SUCCEEDED')));

  const [convertedStats] = await db
    .select({
      total: sql<string>`coalesce(sum(${walletEarningsConversion.amountSatang}), 0)::text`,
    })
    .from(walletEarningsConversion)
    .where(eq(walletEarningsConversion.principalUserId, userId));

  // Hirer spending on quests: settlements where reservation owner was this user
  const [hirerSpending] = await db
    .select({
      total: sql<string>`coalesce(sum(${walletFundingReservationSettlement.totalAmountSatang}), 0)::text`,
    })
    .from(walletFundingReservationSettlement)
    .innerJoin(
      walletFundingReservation,
      eq(walletFundingReservationSettlement.reservationId, walletFundingReservation.id),
    )
    .where(eq(walletFundingReservation.ownerUserId, userId));

  // Active funding reservations
  const activeReservations = await db
    .select({
      id: walletFundingReservation.id,
      callerReference: walletFundingReservation.callerReference,
      totalReservedSatang: walletFundingReservation.totalReservedSatang,
      remainingSatang: walletFundingReservation.remainingSatang,
      createdAt: walletFundingReservation.createdAt,
    })
    .from(walletFundingReservation)
    .where(
      and(
        eq(walletFundingReservation.ownerUserId, userId),
        eq(walletFundingReservation.status, 'ACTIVE'),
      ),
    );

  return {
    member: {
      userId: member.userId,
      firstName: member.firstName,
      lastName: member.lastName,
      studentId: member.studentId,
      email: member.email,
    },
    wallet: walletData,
    lifetimeStats: {
      totalToppedUpSatang: Number(topUpStats?.total ?? 0),
      totalEarnedFromQuestsSatang: Number(earningsStats?.total ?? 0),
      totalSpentOnQuestsSatang: Number(hirerSpending?.total ?? 0),
      totalPaidOutSatang: Number(payoutStats?.total ?? 0),
      totalEarningsConvertedSatang: Number(convertedStats?.total ?? 0),
    },
    activeFundingReservations: activeReservations.map((r) => ({
      id: r.id,
      callerReference: r.callerReference,
      totalReservedSatang: r.totalReservedSatang,
      remainingSatang: r.remainingSatang,
      createdAt: r.createdAt.toISOString(),
    })),
  };
};

export const getCurrentMoneyPolicy = async (): Promise<AdminMoneyPolicyItem | null> => {
  const now = new Date();
  const [policy] = await db
    .select()
    .from(paymentMoneyPolicyRevision)
    .where(
      and(
        lte(paymentMoneyPolicyRevision.effectiveFrom, now),
        or(
          isNull(paymentMoneyPolicyRevision.effectiveUntil),
          gte(paymentMoneyPolicyRevision.effectiveUntil, now),
        ),
      ),
    )
    .orderBy(desc(paymentMoneyPolicyRevision.revision))
    .limit(1);

  if (!policy) return null;

  return {
    id: policy.id,
    revision: policy.revision,
    minimumTopUpSatang: policy.minimumTopUpSatang,
    maximumTopUpSatang: policy.maximumTopUpSatang,
    minimumFundingReservationSatang: policy.minimumFundingReservationSatang,
    maximumFundingReservationSatang: policy.maximumFundingReservationSatang,
    minimumEarningsConversionSatang: policy.minimumEarningsConversionSatang,
    maximumEarningsConversionSatang: policy.maximumEarningsConversionSatang,
    minimumPayoutSatang: policy.minimumPayoutSatang,
    maximumPayoutSatang: policy.maximumPayoutSatang,
    platformFeeBps: policy.platformFeeBps,
    feeRoundingMode: policy.feeRoundingMode,
    topUpProviderFeeSatang: policy.topUpProviderFeeSatang,
    topUpProviderTaxBps: policy.topUpProviderTaxBps,
    payoutProviderFeeSatang: policy.payoutProviderFeeSatang,
    payoutProviderTaxBps: policy.payoutProviderTaxBps,
    quoteLifetimeSeconds: policy.quoteLifetimeSeconds,
    reason: policy.reason,
    effectiveFrom: policy.effectiveFrom.toISOString(),
    effectiveUntil: policy.effectiveUntil ? policy.effectiveUntil.toISOString() : null,
    authoredByAdminId: policy.authoredByAdminId,
    createdAt: policy.createdAt.toISOString(),
  };
};

export const listMoneyPolicyRevisions = async (): Promise<AdminMoneyPolicyItem[]> => {
  const policies = await db
    .select()
    .from(paymentMoneyPolicyRevision)
    .orderBy(desc(paymentMoneyPolicyRevision.revision));

  return policies.map((policy) => ({
    id: policy.id,
    revision: policy.revision,
    minimumTopUpSatang: policy.minimumTopUpSatang,
    maximumTopUpSatang: policy.maximumTopUpSatang,
    minimumFundingReservationSatang: policy.minimumFundingReservationSatang,
    maximumFundingReservationSatang: policy.maximumFundingReservationSatang,
    minimumEarningsConversionSatang: policy.minimumEarningsConversionSatang,
    maximumEarningsConversionSatang: policy.maximumEarningsConversionSatang,
    minimumPayoutSatang: policy.minimumPayoutSatang,
    maximumPayoutSatang: policy.maximumPayoutSatang,
    platformFeeBps: policy.platformFeeBps,
    feeRoundingMode: policy.feeRoundingMode,
    topUpProviderFeeSatang: policy.topUpProviderFeeSatang,
    topUpProviderTaxBps: policy.topUpProviderTaxBps,
    payoutProviderFeeSatang: policy.payoutProviderFeeSatang,
    payoutProviderTaxBps: policy.payoutProviderTaxBps,
    quoteLifetimeSeconds: policy.quoteLifetimeSeconds,
    reason: policy.reason,
    effectiveFrom: policy.effectiveFrom.toISOString(),
    effectiveUntil: policy.effectiveUntil ? policy.effectiveUntil.toISOString() : null,
    authoredByAdminId: policy.authoredByAdminId,
    createdAt: policy.createdAt.toISOString(),
  }));
};
