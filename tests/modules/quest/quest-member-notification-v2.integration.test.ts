import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { memberNotification } from '@/database/schema/notification.schema';
import { pushDelivery } from '@/database/schema/push.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import type { QuestTransaction } from '@/modules/quest';
import {
  enqueueProofNotApprovedPush,
  enqueueQuestCompletedDisputeWindowPush,
  enqueueQuestFailedPush,
} from '@/modules/quest/v2/lifecycle/quest-failed-v2.push';
import { enqueueUnderfilledPush } from '@/modules/quest/v2/lifecycle/quest-underfilled-v2.push';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const hirerId = randomUUID();
const workerId = randomUUID();
const tagId = randomUUID();
const questId = randomUUID();
const assignmentId = randomUUID();
const questTitle = 'Quest Push inbox test';
const now = new Date('2030-01-01T00:00:00.000Z');
const expiresAt = new Date('2030-01-01T00:10:00.000Z');
let postgresAvailable = false;

const rowsFor = (memberId: string) =>
  db.select().from(memberNotification).where(eq(memberNotification.memberId, memberId));
const deliveriesFor = (memberId: string) =>
  db.select().from(pushDelivery).where(eq(pushDelivery.recipientMemberId, memberId));

const cleanMember = async (memberId: string) => {
  await db.delete(memberNotification).where(eq(memberNotification.memberId, memberId));
  await db.delete(pushDelivery).where(eq(pushDelivery.recipientMemberId, memberId));
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }
  await db.insert(authUser).values(
    [hirerId, workerId].map((id) => ({
      id,
      email: `${id}@quest-notification.test`,
      firstName: 'Quest',
      lastName: 'Notification',
    }))
  );
  await db.insert(tag).values({ id: tagId, name: 'Quest notification test tag' });
  await db.insert(quest).values({
    id: questId,
    hirerId,
    apiVersion: 'v2',
    title: questTitle,
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: 'GROUP',
    v2Mode: 'FIRST_COME_FIRST_SERVED',
    v2Participation: 'GROUP',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1_000,
    questFundingTotalSatang: 4_000,
    questEscrowSatang: 16_000,
    tagId,
    headcount: 4,
    startTime: now,
    dueAt: new Date(now.getTime() + 3_600_000),
  });
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await cleanMember(hirerId);
  await cleanMember(workerId);
  await db.delete(quest).where(eq(quest.id, questId));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, workerId]));
});

type Case = {
  type: string;
  recipient: () => string;
  role: 'HIRER' | 'WORKER';
  eventKey: string;
  fields: Record<string, unknown>;
  deepLink: string;
  run: (transaction: QuestTransaction) => Promise<void>;
};

const scopeId = randomUUID();
const underfilled =
  (input: Parameters<typeof enqueueUnderfilledPush>[2]) => (transaction: QuestTransaction) =>
    enqueueUnderfilledPush(transaction, scopeId, input);

const cases: Case[] = [
  {
    type: 'UNDERFILLED_DECISION_PENDING',
    recipient: () => hirerId,
    role: 'HIRER',
    eventKey: `quest-v2:UNDERFILLED_DECISION_PENDING:${scopeId}`,
    fields: { expiresAt },
    deepLink: `kuquestmobile://quest/${questId}`,
    run: underfilled({
      type: 'UNDERFILLED_DECISION_PENDING',
      recipientMemberIds: [hirerId],
      questId,
      expiresAt,
      now,
    }),
  },
  {
    type: 'UNDERFILLED_CONSENT_PENDING',
    recipient: () => workerId,
    role: 'WORKER',
    eventKey: `quest-v2:UNDERFILLED_CONSENT_PENDING:${scopeId}`,
    fields: { expiresAt },
    deepLink: `kuquestmobile://quest/${questId}/partial-start`,
    run: underfilled({
      type: 'UNDERFILLED_CONSENT_PENDING',
      recipientMemberIds: [workerId],
      questId,
      expiresAt,
      now,
    }),
  },
  {
    type: 'UNDERFILLED_COMPLETED',
    recipient: () => workerId,
    role: 'WORKER',
    eventKey: `quest-v2:UNDERFILLED_COMPLETED:${scopeId}`,
    fields: {},
    deepLink: `kuquestmobile://quest/${questId}`,
    run: underfilled({
      type: 'UNDERFILLED_COMPLETED',
      recipientMemberIds: [workerId],
      questId,
      now,
    }),
  },
  {
    type: 'UNDERFILLED_CANCELLED',
    recipient: () => workerId,
    role: 'WORKER',
    eventKey: `quest-v2:UNDERFILLED_CANCELLED:${scopeId}`,
    fields: { cancellationReason: 'WORKER_DECLINED' },
    deepLink: `kuquestmobile://quest/${questId}`,
    run: underfilled({
      type: 'UNDERFILLED_CANCELLED',
      recipientMemberIds: [workerId],
      questId,
      reason: 'WORKER_DECLINED',
      now,
    }),
  },
  {
    type: 'QUEST_ASSIGNED',
    recipient: () => workerId,
    role: 'WORKER',
    eventKey: `quest-v2:QUEST_ASSIGNED:${scopeId}`,
    fields: {},
    deepLink: `kuquestmobile://quest/${questId}`,
    run: underfilled({ type: 'QUEST_ASSIGNED', recipientMemberIds: [workerId], questId, now }),
  },
  {
    type: 'PROOF_NOT_APPROVED',
    recipient: () => workerId,
    role: 'WORKER',
    eventKey: `quest-v2:PROOF_NOT_APPROVED:${assignmentId}`,
    fields: { assignmentId },
    deepLink: `kuquestmobile://quest/${questId}`,
    run: (transaction) =>
      enqueueProofNotApprovedPush(transaction, {
        recipientMemberId: workerId,
        assignmentId,
        questId,
        now,
      }),
  },
  {
    type: 'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN',
    recipient: () => workerId,
    role: 'WORKER',
    eventKey: `quest-v2:QUEST_COMPLETED_DISPUTE_WINDOW_OPEN:${assignmentId}`,
    fields: { assignmentId },
    deepLink: `kuquestmobile://quest/${questId}`,
    run: (transaction) =>
      enqueueQuestCompletedDisputeWindowPush(transaction, {
        recipients: [{ workerId, assignmentId }],
        questId,
        now,
      }),
  },
  {
    type: 'QUEST_FAILED',
    recipient: () => workerId,
    role: 'WORKER',
    eventKey: `quest-v2:QUEST_FAILED:${questId}`,
    fields: { failureReason: 'DUE_AT_MISSED' },
    deepLink: `kuquestmobile://quest/${questId}`,
    run: (transaction) =>
      enqueueQuestFailedPush(transaction, {
        recipientMemberIds: [workerId],
        questId,
        reason: 'DUE_AT_MISSED',
        now,
      }),
  },
];

describe('Quest Push senders write the Member Notification inbox row', () => {
  for (const testCase of cases) {
    it(`${testCase.type}: one row, one linked Push, replay adds nothing`, async () => {
      if (!postgresAvailable) return;
      const memberId = testCase.recipient();
      await cleanMember(memberId);

      await db.transaction((transaction) => testCase.run(transaction));
      await db.transaction((transaction) => testCase.run(transaction));

      const rows = await rowsFor(memberId);
      const deliveries = await deliveriesFor(memberId);
      expect(rows).toHaveLength(1);
      expect(deliveries).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: testCase.type,
        eventKey: testCase.eventKey,
        transitionId: testCase.eventKey,
        questId,
        questTitle,
        actorRole: testCase.role,
        readAt: null,
        ...testCase.fields,
      });
      expect(deliveries[0]).toMatchObject({
        eventType: testCase.type,
        eventKey: testCase.eventKey,
        deepLink: testCase.deepLink,
      });
      expect(deliveries[0]?.data).toMatchObject({
        type: testCase.type,
        questId,
        transitionId: testCase.eventKey,
        notificationId: rows[0]?.id,
        category: 'QUEST',
        route: `/quest/${questId}`,
      });
      await cleanMember(memberId);
    });

    it(`${testCase.type}: a failed transaction leaves no row and no Push`, async () => {
      if (!postgresAvailable) return;
      const memberId = testCase.recipient();
      await cleanMember(memberId);

      await expect(
        db.transaction(async (transaction) => {
          await testCase.run(transaction);
          throw new Error('rollback');
        })
      ).rejects.toThrow('rollback');

      expect(await rowsFor(memberId)).toHaveLength(0);
      expect(await deliveriesFor(memberId)).toHaveLength(0);
    });
  }
});
