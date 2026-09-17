import { db, sql } from '@/database/client';
import { adminDisputeCase, disputeCaseStatus } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { tag } from '@/database/schema/tag.schema';

import { randomUUID } from 'node:crypto';

import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import {
  ensureFrontendDemoDisputeQuest,
  frontendDemoDisputeAmountSatang,
  frontendDemoDisputeQuestTitle,
  frontendDemoDisputeReservationReference,
} from '../../scripts/seed-frontend-demo';

const ensurePostgres = async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'This test needs PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause }
    );
  }
};

// Financial records (wallets, funding reservations, ledger entries, etc.)
// are immutable by database retention triggers and cannot be hard-deleted.
// Each test run uses fresh random UUID-based user emails and admin IDs where applicable,
// and retaining these seed fixtures does not leak state across runs and avoids trigger violations.
const cleanupDemoTestData = async (_emails: string[] = [], _adminIds: string[] = []) => {
  // Explicit no-op: immutable financial records must be retained per database policy.
};

test('frontend demo seed prepares, idempotently reuses, and preserves terminal decisions for the demo Dispute Quest', async () => {
  await ensurePostgres();

  const runId = randomUUID();
  const createdAdminIds: string[] = [];
  const hirerEmail = `nattapong.srisawat-${runId}@ku.th`;
  const workerEmail = `warisara.boonmee-${runId}@ku.th`;

  const studentSuffix = (BigInt(`0x${runId.replace(/-/g, '').slice(0, 12)}`) % 90_000_000n)
    .toString()
    .padStart(8, '0');

  // Prepare demo Hirer and Worker accounts
  const [hirer] = await db
    .insert(authUser)
    .values({
      email: hirerEmail,
      firstName: 'Nattapong',
      lastName: 'Srisawat',
      studentId: `65${studentSuffix}`,
      emailVerified: true,
    })
    .returning({ id: authUser.id });

  const [worker] = await db
    .insert(authUser)
    .values({
      email: workerEmail,
      firstName: 'Warisara',
      lastName: 'Boonmee',
      studentId: `66${studentSuffix}`,
      emailVerified: true,
    })
    .returning({ id: authUser.id });

  if (!hirer || !worker) {
    throw new Error('Failed to create demo test users.');
  }

  // Ensure a Tag exists for the Quest
  const [existingTag] = await db
    .select({ id: tag.id })
    .from(tag)
    .where(eq(tag.name, 'Design'))
    .limit(1);

  const tagId =
    existingTag?.id ??
    (
      await db
        .insert(tag)
        .values({ name: `Design-${runId}` })
        .returning({ id: tag.id })
    )[0]!.id;

  const queryDisputeSeedContract = async (questId: string) => {
    return sql<
      {
        disputeCaseId: string;
        disputeStatus: string;
        filerUserId: string;
        questId: string;
        questTitle: string;
        questStatus: string;
        reservationId: string;
        reservationStatus: string;
        reservationAmountSatang: number;
        reservationReference: string;
        assignmentId: string;
        assignmentStatus: string;
        workerId: string;
        hirerId: string;
      }[]
    >`
      SELECT
        dispute.id AS "disputeCaseId",
        dispute.status AS "disputeStatus",
        dispute.filer_user_id AS "filerUserId",
        failed_quest.id AS "questId",
        failed_quest.title AS "questTitle",
        failed_quest.quest_status AS "questStatus",
        reservation.id AS "reservationId",
        reservation.status AS "reservationStatus",
        reservation.total_reserved_satang AS "reservationAmountSatang",
        reservation.caller_reference AS "reservationReference",
        assignment.id AS "assignmentId",
        assignment.assignment_status AS "assignmentStatus",
        worker.id AS "workerId",
        hirer.id AS "hirerId"
      FROM admin_dispute_cases dispute
      INNER JOIN quest failed_quest ON failed_quest.id = dispute.quest_id
      INNER JOIN wallet_funding_reservations reservation
        ON reservation.id = failed_quest.funding_reservation_id
      INNER JOIN quest_assignment assignment
        ON assignment.quest_id = failed_quest.id
        AND assignment.worker_id = dispute.filer_user_id
      INNER JOIN auth_user hirer ON hirer.id = failed_quest.hirer_id
      INNER JOIN auth_user worker ON worker.id = assignment.worker_id
      WHERE failed_quest.id = ${questId}
    `;
  };

  try {
    // 1. Initial run: ensureFrontendDemoDisputeQuest creates failed Quest, active 50,000-satang reservation, incomplete assignment, and pending dispute case
    const firstResult = await ensureFrontendDemoDisputeQuest(hirer.id, worker.id, tagId);
    expect(firstResult.questId).toBeDefined();
    expect(firstResult.disputeCaseId).toBeDefined();

    const firstRecords = await queryDisputeSeedContract(firstResult.questId);
    expect(firstRecords).toHaveLength(1);

    const [disputeRecord] = firstRecords;
    expect(disputeRecord.questTitle).toBe(frontendDemoDisputeQuestTitle);
    expect(disputeRecord.questStatus).toBe('QUEST_FAILED');
    expect(disputeRecord.reservationStatus).toBe('ACTIVE');
    expect(disputeRecord.reservationAmountSatang).toBe(frontendDemoDisputeAmountSatang);
    expect(disputeRecord.reservationReference).toBe(frontendDemoDisputeReservationReference);
    expect(disputeRecord.assignmentStatus).toBe('ASSIGNMENT_INCOMPLETE');
    expect(disputeRecord.disputeStatus).toBe(disputeCaseStatus.pending);
    expect(disputeRecord.filerUserId).toBe(worker.id);
    expect(disputeRecord.workerId).toBe(worker.id);
    expect(disputeRecord.hirerId).toBe(hirer.id);

    // 2. Idempotency run: calling ensureFrontendDemoDisputeQuest again reuses existing records without duplication or errors
    const secondResult = await ensureFrontendDemoDisputeQuest(hirer.id, worker.id, tagId);
    expect(secondResult.questId).toBe(firstResult.questId);
    expect(secondResult.disputeCaseId).toBe(firstResult.disputeCaseId);

    const secondRecords = await queryDisputeSeedContract(firstResult.questId);
    expect(secondRecords).toHaveLength(1);
    expect(secondRecords[0].disputeCaseId).toBe(disputeRecord.disputeCaseId);
    expect(secondRecords[0].questId).toBe(disputeRecord.questId);
    expect(secondRecords[0].reservationId).toBe(disputeRecord.reservationId);
    expect(secondRecords[0].assignmentId).toBe(disputeRecord.assignmentId);

    // 3. Terminal decision preservation: re-running does not overwrite resolved/dismissed dispute cases
    const adminId = randomUUID();
    createdAdminIds.push(adminId);
    await db.insert(authAdmin).values({
      id: adminId,
      email: `admin-${runId}@ku.th`,
      firstName: 'Admin',
      lastName: 'Reviewer',
    });

    await db
      .update(adminDisputeCase)
      .set({
        status: disputeCaseStatus.dismissed,
        resolvedByAdminId: adminId,
        resolvedAt: new Date(),
      })
      .where(eq(adminDisputeCase.id, disputeRecord.disputeCaseId));

    const thirdResult = await ensureFrontendDemoDisputeQuest(hirer.id, worker.id, tagId);
    expect(thirdResult.questId).toBe(firstResult.questId);
    expect(thirdResult.disputeCaseId).toBe(firstResult.disputeCaseId);

    const [persistedDispute] = await db
      .select({
        status: adminDisputeCase.status,
        resolvedByAdminId: adminDisputeCase.resolvedByAdminId,
        resolvedAt: adminDisputeCase.resolvedAt,
      })
      .from(adminDisputeCase)
      .where(eq(adminDisputeCase.id, disputeRecord.disputeCaseId));

    expect(persistedDispute?.status).toBe(disputeCaseStatus.dismissed);
    expect(persistedDispute?.resolvedByAdminId).toBe(adminId);
    expect(persistedDispute?.resolvedAt).toBeInstanceOf(Date);
  } finally {
    await cleanupDemoTestData([hirerEmail, workerEmail], createdAdminIds);
  }
});
