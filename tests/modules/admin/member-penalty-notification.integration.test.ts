import { db } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { memberNotification } from '@/database/schema/notification.schema';
import { pushDelivery } from '@/database/schema/push.schema';
import { quest, review } from '@/database/schema/quest.schema';
import {
  addAdminMemberPenalty,
  processExpiredMemberBanWalletFreezes,
  recordMemberConfirmedViolationInTransaction,
  recordReviewAveragePenaltyInTransaction,
  removeAdminMemberPenalty,
  reverseReportCaseViolationInTransaction,
} from '@/modules/admin/member-penalty';

import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'bun:test';

const rollback = new Error('ROLLBACK_MEMBER_PENALTY_NOTIFICATION_FIXTURE');
const dayMilliseconds = 24 * 60 * 60 * 1000;
const memberCreatedAt = new Date('2020-01-01T00:00:00.000Z');
const now = new Date('2026-09-24T00:00:00.000Z');

type Executor = Pick<typeof db, 'insert' | 'select'>;

const createMember = async (executor: Executor) => {
  const id = randomUUID();
  await executor.insert(authUser).values({
    id,
    email: `${id}@ku.th`,
    firstName: 'Penalty',
    lastName: 'Member',
    createdAt: memberCreatedAt,
  });
  return id;
};

const createAdmin = async (executor: Executor) => {
  const id = randomUUID();
  await executor.insert(authAdmin).values({
    id,
    email: `${id}@example.com`,
    firstName: 'Penalty',
    lastName: 'Admin',
  });
  return id;
};

const readNotifications = (executor: Executor, memberId: string) =>
  executor
    .select()
    .from(memberNotification)
    .where(eq(memberNotification.memberId, memberId))
    .orderBy(asc(memberNotification.createdAt), asc(memberNotification.id));

const strike = (
  transaction: Parameters<typeof recordMemberConfirmedViolationInTransaction>[0],
  input: {
    memberId: string;
    adminId: string;
    source: 'REPORT_CASE' | 'CONDUCT_REPORT';
    sourceId?: string;
    at: Date;
  }
) =>
  recordMemberConfirmedViolationInTransaction(transaction, {
    memberId: input.memberId,
    source: input.source,
    sourceId: input.sourceId ?? randomUUID(),
    actorAdminId: input.adminId,
    reasonCode: 'POLICY_REVIEW',
    now: input.at,
  });

describe('Member Penalty Notifications', () => {
  it('emits one applied notification per Red Flag, temporary Ban, and permanent Ban', async () => {
    await expect(
      db.transaction(async (transaction) => {
        const memberId = await createMember(transaction);
        const adminId = await createAdmin(transaction);

        const redFlag = await strike(transaction, {
          memberId,
          adminId,
          source: 'CONDUCT_REPORT',
          at: now,
        });
        const tempBan = await strike(transaction, {
          memberId,
          adminId,
          source: 'CONDUCT_REPORT',
          at: new Date(now.getTime() + 1_000),
        });
        const permBan = await strike(transaction, {
          memberId,
          adminId,
          source: 'CONDUCT_REPORT',
          at: new Date(now.getTime() + 2_000),
        });

        const rows = await readNotifications(transaction, memberId);
        expect(rows.map((row) => row.type)).toEqual([
          'PENALTY_RED_FLAG_APPLIED',
          'PENALTY_BAN_APPLIED',
          'PENALTY_BAN_APPLIED',
        ]);
        expect(rows[0]).toMatchObject({
          result: 'RED_FLAG',
          ladder: 'MISCONDUCT',
          source: 'CONDUCT_REPORT',
          transitionId: redFlag.id,
          expiresAt: new Date(now.getTime() + 7 * dayMilliseconds),
        });
        expect(rows[1]).toMatchObject({
          result: 'TEMPORARY_BAN',
          transitionId: tempBan.id,
          expiresAt: new Date(now.getTime() + 1_000 + 7 * dayMilliseconds),
        });
        expect(rows[2]).toMatchObject({
          result: 'PERMANENT_BAN',
          transitionId: permBan.id,
          expiresAt: null,
        });

        const pushes = await transaction
          .select({ data: pushDelivery.data })
          .from(pushDelivery)
          .where(eq(pushDelivery.recipientMemberId, memberId));
        expect(pushes).toHaveLength(3);
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('does not duplicate a notification when the same source is recorded again', async () => {
    await expect(
      db.transaction(async (transaction) => {
        const memberId = await createMember(transaction);
        const adminId = await createAdmin(transaction);
        const sourceId = randomUUID();
        const input = { memberId, adminId, source: 'CONDUCT_REPORT' as const, sourceId, at: now };

        await strike(transaction, input);
        await strike(transaction, input);

        expect(await readNotifications(transaction, memberId)).toHaveLength(1);
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('emits no notification for an exempt Report Case and keeps the payload free of reporter data', async () => {
    await expect(
      db.transaction(async (transaction) => {
        const memberId = await createMember(transaction);
        const adminId = await createAdmin(transaction);

        await strike(transaction, { memberId, adminId, source: 'REPORT_CASE', at: now });
        expect(await readNotifications(transaction, memberId)).toHaveLength(0);

        await strike(transaction, {
          memberId,
          adminId,
          source: 'REPORT_CASE',
          at: new Date(now.getTime() + 1_000),
        });
        const rows = await readNotifications(transaction, memberId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ source: 'REPORT_CASE', ladder: 'MISCONDUCT' });
        expect(Object.keys(rows[0]!).sort()).toEqual(
          [
            'actorRole',
            'assignmentId',
            'cancellationReason',
            'createdAt',
            'dismissedAt',
            'disputeCaseId',
            'disputeStatus',
            'eventKey',
            'expiresAt',
            'failureReason',
            'id',
            'ladder',
            'memberId',
            'questId',
            'questTitle',
            'readAt',
            'result',
            'source',
            'transitionId',
            'type',
            'viewerWon',
          ].sort()
        );
        const [push] = await transaction
          .select({ data: pushDelivery.data, body: pushDelivery.body })
          .from(pushDelivery)
          .where(eq(pushDelivery.recipientMemberId, memberId));
        expect(Object.keys(push!.data as object).sort()).toEqual(
          [
            'category',
            'expiresAt',
            'ladder',
            'notificationId',
            'result',
            'route',
            'source',
            'transitionId',
            'type',
          ].sort()
        );
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('emits a Review ladder Ban notification with the REVIEW_AVERAGE source', async () => {
    await expect(
      db.transaction(async (transaction) => {
        const memberId = await createMember(transaction);
        const reviewerIds = await Promise.all(
          Array.from({ length: 10 }, () => createMember(transaction))
        );
        const questId = randomUUID();
        await transaction.insert(quest).values({
          id: questId,
          hirerId: reviewerIds[0]!,
          apiVersion: 'v2',
          title: 'Penalty notification fixture',
          condition: 'Review ladder notification fixture',
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
        await transaction.insert(review).values(
          reviewerIds.map((reviewerId, index) => ({
            id: randomUUID(),
            questId,
            reviewerId,
            revieweeId: memberId,
            rating: index === 9 ? 1 : 3,
            createdAt: now,
            updatedAt: now,
          }))
        );
        const penalty = await recordReviewAveragePenaltyInTransaction(transaction, {
          memberId,
          reviewId: randomUUID(),
          rating: 1,
          now,
        });

        const rows = await readNotifications(transaction, memberId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          type: 'PENALTY_BAN_APPLIED',
          result: 'TEMPORARY_BAN',
          ladder: 'REVIEW',
          source: 'REVIEW_AVERAGE',
          transitionId: penalty!.id,
        });
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('leaves a direct Admin Add without a source and replays without a second notification', async () => {
    const memberId = await createMember(db);
    const adminId = await createAdmin(db);
    const command = {
      memberId,
      adminId,
      requestKey: `notify-add-${randomUUID()}`,
      expectedVersionToken: 0,
      result: 'PENALTY_PERMANENT_BAN' as const,
      reasonCode: 'MEMBER_PENALTY_SAFETY_RISK_CONFIRMED' as const,
      now,
    };

    const first = await addAdminMemberPenalty(command);
    const replay = await addAdminMemberPenalty(command);

    expect(replay.command.commandRecordId).toBe(first.command.commandRecordId);
    const rows = await readNotifications(db, memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'PENALTY_BAN_APPLIED',
      result: 'PERMANENT_BAN',
      ladder: 'MISCONDUCT',
      source: null,
      expiresAt: null,
    });
  });

  it('emits Red Flag expired once when the sweep finds an expired Red Flag, and again never', async () => {
    const memberId = await createMember(db);
    const adminId = await createAdmin(db);
    const appliedAt = new Date(now.getTime() - 8 * dayMilliseconds);
    await db.transaction((transaction) =>
      strike(transaction, { memberId, adminId, source: 'CONDUCT_REPORT', at: appliedAt })
    );
    const expiry = new Date(appliedAt.getTime() + 7 * dayMilliseconds);

    expect(await processExpiredMemberBanWalletFreezes(now)).toBeGreaterThanOrEqual(1);
    expect(await processExpiredMemberBanWalletFreezes(now)).toBeGreaterThanOrEqual(0);

    const rows = await readNotifications(db, memberId);
    expect(rows.map((row) => row.type).sort()).toEqual([
      'PENALTY_RED_FLAG_APPLIED',
      'PENALTY_RED_FLAG_EXPIRED',
    ]);
    const expired = rows.find((row) => row.type === 'PENALTY_RED_FLAG_EXPIRED');
    expect(expired).toMatchObject({ result: 'RED_FLAG', expiresAt: expiry });
  });

  it('emits Ban ended once when the sweep finds an expired temporary Ban', async () => {
    const memberId = await createMember(db);
    const adminId = await createAdmin(db);
    const appliedAt = new Date(now.getTime() - 8 * dayMilliseconds);
    await db.transaction(async (transaction) => {
      await strike(transaction, { memberId, adminId, source: 'CONDUCT_REPORT', at: appliedAt });
      await strike(transaction, {
        memberId,
        adminId,
        source: 'CONDUCT_REPORT',
        at: new Date(appliedAt.getTime() + 1_000),
      });
    });

    await processExpiredMemberBanWalletFreezes(now);
    await processExpiredMemberBanWalletFreezes(now);

    const rows = await readNotifications(db, memberId);
    expect(rows.filter((row) => row.type === 'PENALTY_BAN_ENDED')).toHaveLength(1);
    expect(rows.filter((row) => row.type === 'PENALTY_BAN_APPLIED')).toHaveLength(1);
    expect(rows.filter((row) => row.type === 'PENALTY_RED_FLAG_EXPIRED')).toHaveLength(1);
  });

  it('emits Red Flag expired when a Report Case Restore reverses the Red Flag', async () => {
    await expect(
      db.transaction(async (transaction) => {
        const memberId = await createMember(transaction);
        const adminId = await createAdmin(transaction);
        const reportCaseIds = [randomUUID(), randomUUID()];
        for (const sourceId of reportCaseIds) {
          await strike(transaction, {
            memberId,
            adminId,
            source: 'REPORT_CASE',
            sourceId,
            at: now,
          });
        }
        const restoreAt = new Date(now.getTime() + 1_000);
        const reverseInput = {
          memberId,
          reportCaseId: reportCaseIds[1]!,
          actorAdminId: adminId,
          reasonCode: 'POLICY_REVIEW',
          now: restoreAt,
        };
        await reverseReportCaseViolationInTransaction(transaction, reverseInput);
        await reverseReportCaseViolationInTransaction(transaction, reverseInput);

        const types = (await readNotifications(transaction, memberId)).map((row) => row.type);
        expect(types.sort()).toEqual(['PENALTY_RED_FLAG_APPLIED', 'PENALTY_RED_FLAG_EXPIRED']);
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('emits Ban ended when Remove reverses the only temporary Ban', async () => {
    const memberId = await createMember(db);
    const adminId = await createAdmin(db);
    const added = await addAdminMemberPenalty({
      memberId,
      adminId,
      requestKey: `notify-ban-${randomUUID()}`,
      expectedVersionToken: 0,
      result: 'PENALTY_TEMPORARY_BAN_7_DAYS',
      reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
    });

    const removal = {
      memberId,
      adminId,
      requestKey: `notify-remove-${randomUUID()}`,
      expectedVersionToken: added.command.versionToken,
      recordId: added.command.recordId,
      reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR' as const,
    };
    await removeAdminMemberPenalty(removal);
    await removeAdminMemberPenalty(removal);

    const types = (await readNotifications(db, memberId)).map((row) => row.type).sort();
    expect(types).toEqual(['PENALTY_BAN_APPLIED', 'PENALTY_BAN_ENDED']);
  });

  it('leaves no notification or Push when the penalty transaction rolls back', async () => {
    const memberId = await createMember(db);
    const adminId = await createAdmin(db);

    await expect(
      db.transaction(async (transaction) => {
        await strike(transaction, { memberId, adminId, source: 'CONDUCT_REPORT', at: now });
        expect(await readNotifications(transaction, memberId)).toHaveLength(1);
        throw rollback;
      })
    ).rejects.toBe(rollback);

    expect(await readNotifications(db, memberId)).toHaveLength(0);
    expect(
      await db
        .select({ id: pushDelivery.id })
        .from(pushDelivery)
        .where(eq(pushDelivery.recipientMemberId, memberId))
    ).toHaveLength(0);
  });
});
