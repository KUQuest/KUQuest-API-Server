import { db } from '@/database/client';
import {
  adminConductReport,
  conductReportReason,
  type ConductReportReason,
  conductReportStatus,
} from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, test } from 'bun:test';

type ConductReportFixture = {
  adminId: string;
  assignmentId: string;
  filerUserId: string;
  questId: string;
  reportedMemberId: string;
  tagId: string;
};

const createFixture = async (): Promise<ConductReportFixture> => {
  const adminId = randomUUID();
  const assignmentId = randomUUID();
  const filerUserId = randomUUID();
  const questId = randomUUID();
  const reportedMemberId = randomUUID();
  const tagId = randomUUID();

  await db.insert(authUser).values([
    {
      id: filerUserId,
      email: `${filerUserId}@ku.th`,
      firstName: 'Conduct',
      lastName: 'Filer',
    },
    {
      id: reportedMemberId,
      email: `${reportedMemberId}@ku.th`,
      firstName: 'Conduct',
      lastName: 'Reported',
    },
  ]);
  await db.insert(authAdmin).values({
    id: adminId,
    email: `${adminId}@ku.th`,
    firstName: 'Conduct',
    lastName: 'Admin',
  });
  await db.insert(tag).values({
    id: tagId,
    name: `Conduct Report schema test ${tagId}`,
  });
  await db.insert(quest).values({
    id: questId,
    hirerId: filerUserId,
    title: 'Conduct Report schema test',
    condition: 'Complete the schema test work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_ASSIGNED',
    rewardSatang: 500,
    tagId,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId,
    workerId: reportedMemberId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: new Date('2030-01-01T10:00:00.000Z'),
  });

  return { adminId, assignmentId, filerUserId, questId, reportedMemberId, tagId };
};

const insertReport = async (
  fixture: ConductReportFixture,
  overrides: Partial<typeof adminConductReport.$inferInsert> = {}
) => {
  const [report] = await db
    .insert(adminConductReport)
    .values({
      questId: fixture.questId,
      filerUserId: fixture.filerUserId,
      reportedMemberId: fixture.reportedMemberId,
      assignmentId: fixture.assignmentId,
      reason: conductReportReason.abandoned,
      ...overrides,
    })
    .returning();

  return report;
};

test('persists a pending Conduct Report with the Rulebook defaults', async () => {
  const fixture = await createFixture();
  const report = await insertReport(fixture, { detail: 'The Worker did not submit proof.' });

  expect(report?.status).toBe(conductReportStatus.pending);
  expect(report?.version).toBe(1);
  expect(report?.decisionReason).toBeNull();
  expect(report?.resolvedByAdminId).toBeNull();
  expect(report?.resolvedAt).toBeNull();
});

test('allows a final Conduct Report decision only with complete decision data', async () => {
  const fixture = await createFixture();
  const resolvedAt = new Date('2030-01-02T10:00:00.000Z');
  const report = await insertReport(fixture, {
    status: conductReportStatus.upheld,
    decisionReason: 'The Quest record confirms the violation.',
    resolvedByAdminId: fixture.adminId,
    resolvedAt,
  });

  expect(report?.status).toBe(conductReportStatus.upheld);
  expect(report?.decisionReason).toBe('The Quest record confirms the violation.');
  expect(report?.resolvedByAdminId).toBe(fixture.adminId);
  expect(report?.resolvedAt).toEqual(resolvedAt);
});

test('supports a Worker filing CONDUCT_OUT_OF_SCOPE against the Hirer', async () => {
  const fixture = await createFixture();
  const report = await insertReport(fixture, {
    filerUserId: fixture.reportedMemberId,
    reportedMemberId: fixture.filerUserId,
    reason: conductReportReason.outOfScope,
  });

  expect(report?.reason).toBe(conductReportReason.outOfScope);
  expect(report?.assignmentId).toBe(fixture.assignmentId);
});

test('rejects a second Conduct Report for the same reported Member on one Quest', async () => {
  const fixture = await createFixture();
  await insertReport(fixture);

  await expect(insertReport(fixture)).rejects.toThrow();
});

test('rejects unsupported reasons and incomplete final decisions', async () => {
  const invalidReasonFixture = await createFixture();
  await expect(
    insertReport(invalidReasonFixture, {
      reason: 'CONDUCT_POOR_QUALITY' as ConductReportReason,
    })
  ).rejects.toThrow();

  const incompleteDecisionFixture = await createFixture();
  await expect(
    insertReport(incompleteDecisionFixture, { status: conductReportStatus.dismissed })
  ).rejects.toThrow();
});

test('requires the Assignment to belong to the Quest and reported Member', async () => {
  const fixture = await createFixture();
  const otherQuestId = randomUUID();
  const otherAssignmentId = randomUUID();

  await db.insert(quest).values({
    id: otherQuestId,
    hirerId: fixture.filerUserId,
    title: 'Other Quest for Conduct Report schema test',
    condition: 'Complete the other schema test work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_ASSIGNED',
    rewardSatang: 500,
    tagId: fixture.tagId,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  await db.insert(questAssignment).values({
    id: otherAssignmentId,
    questId: otherQuestId,
    workerId: fixture.reportedMemberId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: new Date('2030-01-01T10:00:00.000Z'),
  });

  await expect(insertReport(fixture, { assignmentId: otherAssignmentId })).rejects.toThrow();
});

test('rejects blank report detail and self-reported Members', async () => {
  const blankDetailFixture = await createFixture();
  await expect(insertReport(blankDetailFixture, { detail: '  ' })).rejects.toThrow();

  const selfReportFixture = await createFixture();
  await expect(
    insertReport(selfReportFixture, { reportedMemberId: selfReportFixture.filerUserId })
  ).rejects.toThrow();
});

test('protects retained Conduct Report references from parent deletion', async () => {
  const fixture = await createFixture();
  await insertReport(fixture);

  await expect(
    (async () => {
      await db.delete(questAssignment).where(eq(questAssignment.id, fixture.assignmentId));
    })()
  ).rejects.toThrow();
  await expect(
    (async () => {
      await db.delete(quest).where(eq(quest.id, fixture.questId));
    })()
  ).rejects.toThrow();
});
