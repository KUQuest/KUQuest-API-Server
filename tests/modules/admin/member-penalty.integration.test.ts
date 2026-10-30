import { db } from '@/database/client';
import { memberPenaltyRecord } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, review } from '@/database/schema/quest.schema';
import { walletStatusHistory, walletWallet } from '@/database/schema/wallet.schema';
import {
  recordMemberConfirmedViolationInTransaction,
  recordReviewAveragePenaltyInTransaction,
  reverseReportCaseViolationInTransaction,
} from '@/modules/admin/member-penalty';
import { ensureWalletInTransaction } from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'bun:test';

const rollback = new Error('ROLLBACK_MEMBER_PENALTY_FIXTURE');

describe('Member Penalty persistence', () => {
  it('exempts only the first confirmed Report Case and never exempts a Conduct Report', async () => {
    const memberId = randomUUID();
    const adminId = randomUUID();
    const createdAt = new Date('2020-01-01T00:00:00.000Z');
    const now = new Date('2026-09-24T00:00:00.000Z');

    await expect(
      db.transaction(async (transaction) => {
        await transaction.insert(authUser).values({
          id: memberId,
          email: `${memberId}@ku.th`,
          firstName: 'Penalty',
          lastName: 'Member',
          createdAt,
        });
        await transaction.insert(authAdmin).values({
          id: adminId,
          email: `${adminId}@example.com`,
          firstName: 'Penalty',
          lastName: 'Admin',
        });

        const conductReport = await recordMemberConfirmedViolationInTransaction(transaction, {
          memberId,
          source: 'CONDUCT_REPORT',
          sourceId: randomUUID(),
          actorAdminId: adminId,
          reasonCode: 'SAFETY_REVIEW',
          now,
        });
        const firstReportCase = await recordMemberConfirmedViolationInTransaction(transaction, {
          memberId,
          source: 'REPORT_CASE',
          sourceId: randomUUID(),
          actorAdminId: adminId,
          reasonCode: 'SAFETY_REVIEW',
          now: new Date(now.getTime() + 1_000),
        });
        const secondReportCase = await recordMemberConfirmedViolationInTransaction(transaction, {
          memberId,
          source: 'REPORT_CASE',
          sourceId: randomUUID(),
          actorAdminId: adminId,
          reasonCode: 'SAFETY_REVIEW',
          now: new Date(now.getTime() + 2_000),
        });

        expect(conductReport.result).toBe('PENALTY_RED_FLAG');
        expect(firstReportCase.result).toBe('PENALTY_EXEMPT');
        expect(secondReportCase.result).toBe('PENALTY_TEMPORARY_BAN_7_DAYS');

        const persisted = await transaction
          .select({
            sequenceNumber: memberPenaltyRecord.sequenceNumber,
            result: memberPenaltyRecord.result,
          })
          .from(memberPenaltyRecord)
          .where(eq(memberPenaltyRecord.memberId, memberId))
          .orderBy(asc(memberPenaltyRecord.sequenceNumber));
        expect(persisted).toEqual([
          { sequenceNumber: 1, result: 'PENALTY_RED_FLAG' },
          { sequenceNumber: 2, result: 'PENALTY_EXEMPT' },
          { sequenceNumber: 3, result: 'PENALTY_TEMPORARY_BAN_7_DAYS' },
        ]);

        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('does not return the Report Case exemption after a Restore', async () => {
    const memberId = randomUUID();
    const adminId = randomUUID();
    const createdAt = new Date('2020-01-01T00:00:00.000Z');
    const now = new Date('2026-09-24T00:00:00.000Z');
    const restoredReportCaseId = randomUUID();

    await expect(
      db.transaction(async (transaction) => {
        await transaction.insert(authUser).values({
          id: memberId,
          email: `${memberId}@ku.th`,
          firstName: 'Penalty',
          lastName: 'Member',
          createdAt,
        });
        await transaction.insert(authAdmin).values({
          id: adminId,
          email: `${adminId}@example.com`,
          firstName: 'Penalty',
          lastName: 'Admin',
        });

        const restoredViolation = await recordMemberConfirmedViolationInTransaction(transaction, {
          memberId,
          source: 'REPORT_CASE',
          sourceId: restoredReportCaseId,
          actorAdminId: adminId,
          reasonCode: 'POLICY_REVIEW',
          now,
        });
        expect(restoredViolation.result).toBe('PENALTY_EXEMPT');
        await reverseReportCaseViolationInTransaction(transaction, {
          memberId,
          reportCaseId: restoredReportCaseId,
          actorAdminId: adminId,
          reasonCode: 'POLICY_REVIEW',
          now: new Date(now.getTime() + 1_000),
        });
        const repeatedHide = await recordMemberConfirmedViolationInTransaction(transaction, {
          memberId,
          source: 'REPORT_CASE',
          sourceId: restoredReportCaseId,
          actorAdminId: adminId,
          reasonCode: 'SAFETY_REVIEW',
          now: new Date(now.getTime() + 2_000),
        });
        expect(repeatedHide.id).toBe(restoredViolation.id);

        const secondReportCase = await recordMemberConfirmedViolationInTransaction(transaction, {
          memberId,
          source: 'REPORT_CASE',
          sourceId: randomUUID(),
          actorAdminId: adminId,
          reasonCode: 'SAFETY_REVIEW',
          now: new Date(now.getTime() + 3_000),
        });
        const thirdReportCase = await recordMemberConfirmedViolationInTransaction(transaction, {
          memberId,
          source: 'REPORT_CASE',
          sourceId: randomUUID(),
          actorAdminId: adminId,
          reasonCode: 'SAFETY_REVIEW',
          now: new Date(now.getTime() + 4_000),
        });

        expect(secondReportCase.result).toBe('PENALTY_RED_FLAG');
        expect(thirdReportCase.result).toBe('PENALTY_TEMPORARY_BAN_7_DAYS');
        const persisted = await transaction
          .select({ result: memberPenaltyRecord.result })
          .from(memberPenaltyRecord)
          .where(eq(memberPenaltyRecord.memberId, memberId))
          .orderBy(asc(memberPenaltyRecord.createdAt), asc(memberPenaltyRecord.id));
        expect(persisted.map(({ result }) => result)).toEqual([
          'PENALTY_EXEMPT',
          'PENALTY_REVERSAL',
          'PENALTY_RED_FLAG',
          'PENALTY_TEMPORARY_BAN_7_DAYS',
        ]);

        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('advances the Conduct Report Misconduct ladder after a Ban expires', async () => {
    const memberId = randomUUID();
    const adminId = randomUUID();
    const createdAt = new Date('2020-01-01T00:00:00.000Z');
    const firstViolationAt = new Date('2026-09-24T00:00:00.000Z');

    await expect(
      db.transaction(async (transaction) => {
        await transaction.insert(authUser).values({
          id: memberId,
          email: `${memberId}@ku.th`,
          firstName: 'Penalty',
          lastName: 'Member',
          createdAt,
        });
        await transaction.insert(authAdmin).values({
          id: adminId,
          email: `${adminId}@example.com`,
          firstName: 'Penalty',
          lastName: 'Admin',
        });
        const wallet = await ensureWalletInTransaction(transaction, memberId);

        const results = [];
        for (let index = 0; index < 2; index += 1) {
          const record = await recordMemberConfirmedViolationInTransaction(transaction, {
            memberId,
            source: 'CONDUCT_REPORT',
            sourceId: randomUUID(),
            actorAdminId: adminId,
            reasonCode: 'SAFETY_REVIEW',
            now: new Date(firstViolationAt.getTime() + index * 1_000),
          });
          results.push(record.result);
        }

        expect(results).toEqual(['PENALTY_RED_FLAG', 'PENALTY_TEMPORARY_BAN_7_DAYS']);
        const [frozenWallet] = await transaction
          .select({ walletStatus: walletWallet.walletStatus })
          .from(walletWallet)
          .where(eq(walletWallet.id, wallet.id));
        expect(frozenWallet?.walletStatus).toBe('FROZEN');
        const freezeHistory = await transaction
          .select({
            fromStatus: walletStatusHistory.fromStatus,
            toStatus: walletStatusHistory.toStatus,
          })
          .from(walletStatusHistory)
          .where(eq(walletStatusHistory.walletId, wallet.id))
          .orderBy(asc(walletStatusHistory.occurredAt), asc(walletStatusHistory.id));
        expect(freezeHistory.map(({ toStatus }) => toStatus)).toEqual(['ACTIVE', 'FROZEN']);
        expect(freezeHistory[1]?.fromStatus).toBe('ACTIVE');
        const initialRestriction = await transaction
          .select({
            bannedUntil: authUser.bannedUntil,
            redFlagExpiresAt: authUser.redFlagExpiresAt,
          })
          .from(authUser)
          .where(eq(authUser.id, memberId));
        expect(initialRestriction[0]?.bannedUntil).toEqual(
          new Date(firstViolationAt.getTime() + 7 * 24 * 60 * 60 * 1000 + 1_000)
        );

        const afterBanExpiry = new Date(
          firstViolationAt.getTime() + 7 * 24 * 60 * 60 * 1000 + 1_000
        );
        const afterExpiryConduct = await recordMemberConfirmedViolationInTransaction(transaction, {
          memberId,
          source: 'CONDUCT_REPORT',
          sourceId: randomUUID(),
          actorAdminId: adminId,
          reasonCode: 'SAFETY_REVIEW',
          now: afterBanExpiry,
        });
        expect(afterExpiryConduct.result).toBe('PENALTY_PERMANENT_BAN');
        const [permanentlyFrozenWallet] = await transaction
          .select({ walletStatus: walletWallet.walletStatus })
          .from(walletWallet)
          .where(eq(walletWallet.id, wallet.id));
        expect(permanentlyFrozenWallet?.walletStatus).toBe('FROZEN');

        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('reverses a Report Case penalty and clears its Red Flag projection', async () => {
    const memberId = randomUUID();
    const adminId = randomUUID();
    const createdAt = new Date('2020-01-01T00:00:00.000Z');
    const now = new Date('2026-09-24T00:00:00.000Z');
    const reportCaseIds = Array.from({ length: 2 }, () => randomUUID());

    await expect(
      db.transaction(async (transaction) => {
        await transaction.insert(authUser).values({
          id: memberId,
          email: `${memberId}@ku.th`,
          firstName: 'Penalty',
          lastName: 'Member',
          createdAt,
        });
        await transaction.insert(authAdmin).values({
          id: adminId,
          email: `${adminId}@example.com`,
          firstName: 'Penalty',
          lastName: 'Admin',
        });

        for (const reportCaseId of reportCaseIds) {
          const record = await recordMemberConfirmedViolationInTransaction(transaction, {
            memberId,
            source: 'REPORT_CASE',
            sourceId: reportCaseId,
            actorAdminId: adminId,
            reasonCode: 'POLICY_REVIEW',
            now,
          });
          if (reportCaseId === reportCaseIds[1]) {
            expect(record.result).toBe('PENALTY_RED_FLAG');
          }
        }

        const reversal = await reverseReportCaseViolationInTransaction(transaction, {
          memberId,
          reportCaseId: reportCaseIds[1]!,
          actorAdminId: adminId,
          reasonCode: 'POLICY_REVIEW',
          now: new Date(now.getTime() + 1000),
        });
        expect(reversal).toMatchObject({ result: 'PENALTY_REVERSAL' });
        expect(reversal?.reversalOfRecordId).toBeTruthy();

        const [restriction] = await transaction
          .select({
            bannedUntil: authUser.bannedUntil,
            redFlagExpiresAt: authUser.redFlagExpiresAt,
          })
          .from(authUser)
          .where(eq(authUser.id, memberId));
        expect(restriction).toEqual({ bannedUntil: null, redFlagExpiresAt: null });

        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('records Review penalties only when a new Review crosses the average below 3.0', async () => {
    const memberId = randomUUID();
    const reviewerIds = Array.from({ length: 12 }, () => randomUUID());
    const questId = randomUUID();
    const now = new Date('2026-09-24T00:00:00.000Z');
    const existingReviewIds = Array.from({ length: 9 }, () => randomUUID());
    const crossingReviewId = randomUUID();
    const lowAverageReviewId = randomUUID();
    const secondCrossingReviewId = randomUUID();

    await expect(
      db.transaction(async (transaction) => {
        await transaction.insert(authUser).values([
          {
            id: memberId,
            email: `${memberId}@ku.th`,
            firstName: 'Penalty',
            lastName: 'Reviewee',
          },
          ...reviewerIds.map((id) => ({
            id,
            email: `${id}@ku.th`,
            firstName: 'Penalty',
            lastName: 'Reviewer',
          })),
        ]);
        await transaction.insert(quest).values({
          id: questId,
          hirerId: reviewerIds[0]!,
          apiVersion: 'v2',
          title: 'Penalty ladder fixture',
          condition: 'Review ladder test fixture',
          mode: 'CANDIDATE',
          participation: 'SOLO',
          v2Mode: 'CANDIDATE',
          v2Participation: 'SINGLE',
          questStatus: 'QUEST_DRAFT',
          headcount: 1,
          startTime: new Date(now.getTime() + 60 * 60 * 1000),
          rewardSatang: null,
          createdAt: now,
        });
        const wallet = await ensureWalletInTransaction(transaction, memberId);
        await transaction.insert(review).values(
          existingReviewIds.map((id, index) => ({
            id,
            questId,
            reviewerId: reviewerIds[index]!,
            revieweeId: memberId,
            rating: 3,
            createdAt: now,
            updatedAt: now,
          }))
        );

        await transaction.insert(review).values({
          id: crossingReviewId,
          questId,
          reviewerId: reviewerIds[9]!,
          revieweeId: memberId,
          rating: 1,
          createdAt: now,
          updatedAt: now,
        });
        const firstPenalty = await recordReviewAveragePenaltyInTransaction(transaction, {
          memberId,
          reviewId: crossingReviewId,
          rating: 1,
          now,
        });
        expect(firstPenalty?.result).toBe('PENALTY_TEMPORARY_BAN_7_DAYS');
        const [frozenWallet] = await transaction
          .select({ walletStatus: walletWallet.walletStatus })
          .from(walletWallet)
          .where(eq(walletWallet.id, wallet.id));
        expect(frozenWallet?.walletStatus).toBe('FROZEN');

        await transaction.insert(review).values({
          id: lowAverageReviewId,
          questId,
          reviewerId: reviewerIds[10]!,
          revieweeId: memberId,
          rating: 1,
          createdAt: now,
          updatedAt: now,
        });
        expect(
          await recordReviewAveragePenaltyInTransaction(transaction, {
            memberId,
            reviewId: lowAverageReviewId,
            rating: 1,
            now,
          })
        ).toBeNull();

        await transaction
          .update(review)
          .set({ rating: 5, updatedAt: now })
          .where(inArray(review.id, [existingReviewIds[0]!, existingReviewIds[1]!]));
        await transaction.insert(review).values({
          id: secondCrossingReviewId,
          questId,
          reviewerId: reviewerIds[11]!,
          revieweeId: memberId,
          rating: 1,
          createdAt: now,
          updatedAt: now,
        });
        const secondPenalty = await recordReviewAveragePenaltyInTransaction(transaction, {
          memberId,
          reviewId: secondCrossingReviewId,
          rating: 1,
          now,
        });
        expect(secondPenalty?.result).toBe('PENALTY_TEMPORARY_BAN_1_MONTH');

        throw rollback;
      })
    ).rejects.toBe(rollback);
  });
});
