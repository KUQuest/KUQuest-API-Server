import { defaultLocalDatabaseUrl } from '@/config/default-database-url';
import { db, sql } from '@/database/client';
import { adminDisputeCase } from '@/database/schema/admin.schema';
import { authAdmin } from '@/database/schema/auth.schema';

import { randomUUID } from 'node:crypto';

import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import {
  financeSeedDisputeAmountSatang,
  financeSeedDisputeQuestTitle,
} from '../../scripts/seed-finance-test';

const financeSeedScript = `${import.meta.dir}/../../scripts/seed-finance-test.ts`;
const stagingSeedScript = `${import.meta.dir}/../../scripts/seed-staging.ts`;

test('finance seed refuses to run without the explicit safety flag', () => {
  const result = Bun.spawnSync(['bun', financeSeedScript], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEPLOYMENT_ENV: 'development',
      XENDIT_SECRET_KEY: 'xnd_development_test-only',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('Set STAGING_FINANCE_SEED_ENABLED=true');
});

test('finance seed refuses a production Xendit key', () => {
  const result = Bun.spawnSync(['bun', financeSeedScript], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEPLOYMENT_ENV: 'development',
      STAGING_FINANCE_SEED_ENABLED: 'true',
      XENDIT_SECRET_KEY: 'xnd_production_test-only',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('requires an Xendit Development API key');
});

test('finance seed refuses a development node in a production deployment', () => {
  const result = Bun.spawnSync(['bun', financeSeedScript], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEPLOYMENT_ENV: 'production',
      STAGING_FINANCE_SEED_ENABLED: 'true',
      XENDIT_SECRET_KEY: 'xnd_development_test-only',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('allowed only in development/development or production/staging');
});

test('staging seed refuses a production deployment before running child seeds', () => {
  const result = Bun.spawnSync(['bun', stagingSeedScript], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DEPLOYMENT_ENV: 'production',
      STAGING_FINANCE_SEED_ENABLED: 'true',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('allowed only in development/development or production/staging');
});

test('staging seed refuses a development node in a production deployment', () => {
  const result = Bun.spawnSync(['bun', stagingSeedScript], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEPLOYMENT_ENV: 'production',
      STAGING_FINANCE_SEED_ENABLED: 'true',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('allowed only in development/development or production/staging');
});

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

// Financial records (wallets, funding reservations, ledger entries, payouts, etc.)
// are immutable by database retention triggers and cannot be hard-deleted.
// Each test run uses fresh random UUID-based user emails and admin IDs, so retaining
// these seed fixtures does not leak state across runs and avoids trigger violations.
const cleanupFinanceTestData = async (_emails: string[] = [], _adminIds: string[] = []) => {
  // Explicit no-op: immutable financial records must be retained per database policy.
};

// Note on test architecture and verify-staging-seed limitation:
// scripts/verify-staging-seed.ts validates the complete staging bootstrap (including
// all 10 demo students, demo open/completed quests, and reviews), so running
// verify-staging-seed.ts standalone fails on missing demo fixtures in an isolated test database.
// To keep the test fully deterministic and safe, we run the supported financeSeedScript directly
// and assert against the exact database query contract that verify-staging-seed.ts evaluates
// to verify the Admin Dispute case seed:
//   - Failed Quest titled "[Finance Test] Failed Dispute Quest" with status QUEST_FAILED
//   - Active Funding Reservation for 50,000 satang
//   - Incomplete Assignment (ASSIGNMENT_INCOMPLETE) for the finance recipient
//   - Admin Dispute Case with status DISPUTE_CASE_PENDING filed by the worker
//   - Idempotent re-execution with no duplicate records
//   - Preservation of terminal decisions (e.g., DISPUTE_CASE_DISMISSED) across re-seed runs
//   - Zero provider network calls made
test('finance seed prepares, idempotently reuses, and preserves terminal decisions for the Admin Dispute seed', async () => {
  await ensurePostgres();

  const runId = randomUUID();
  const financeEmail = `finance-test-${runId}@ku.th`;
  const createdAdminIds: string[] = [];
  const recipientEmail = `recipient-test-${runId}@ku.th`;
  const studentSuffix = (BigInt(`0x${runId.replace(/-/g, '').slice(0, 12)}`) % 90_000_000n)
    .toString()
    .padStart(8, '0');
  const studentId = `65${studentSuffix}`;
  const testEnv: Record<string, string> = {
    ...process.env,
    NODE_ENV: 'development',
    DEPLOYMENT_ENV: 'development',
    STAGING_FINANCE_SEED_ENABLED: 'true',
    XENDIT_SECRET_KEY: 'xnd_development_test-only',
    PAYOUT_DESTINATION_ENCRYPTION_KEY:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    STAGING_TEST_AUTH_EMAIL: financeEmail,
    STAGING_TEST_AUTH_PASSWORD: 'FinancePassword1!',
    STAGING_TEST_AUTH_FIRST_NAME: 'Finance',
    STAGING_TEST_AUTH_LAST_NAME: 'Student',
    STAGING_TEST_AUTH_STUDENT_ID: studentId,
    LOCAL_FINANCE_TEST_RECIPIENT_EMAIL: recipientEmail,
    LOCAL_FINANCE_TEST_RECIPIENT_FIRST_NAME: 'Recipient',
    LOCAL_FINANCE_TEST_RECIPIENT_LAST_NAME: 'Student',
    BETTER_AUTH_SECRET: 'finance-seed-test-secret-at-least-32-chars-long',
    DATABASE_URL: process.env.DATABASE_URL ?? defaultLocalDatabaseUrl,
  };

  const queryDisputeSeedContract = async () => {
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
      INNER JOIN auth_user hirer ON hirer.id = failed_quest.hirer_id
      INNER JOIN auth_user worker ON worker.id = assignment.worker_id
      WHERE lower(hirer.email) = ${financeEmail.toLowerCase()}
        AND lower(worker.email) = ${recipientEmail.toLowerCase()}
        AND failed_quest.title = ${financeSeedDisputeQuestTitle}
    `;
  };

  try {
    // 1. Initial run: seed creates failed quest, active reservation, incomplete assignment, and pending dispute case
    const firstRun = Bun.spawnSync(['bun', financeSeedScript], {
      env: testEnv,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const firstOutput = `${firstRun.stdout.toString()}${firstRun.stderr.toString()}`;

    expect(firstRun.exitCode).toBe(0);
    expect(firstOutput).toContain('Prepared pending Dispute Case');
    expect(firstOutput).toContain('No provider call was made by the finance seed.');

    const firstRecords = await queryDisputeSeedContract();
    expect(firstRecords).toHaveLength(1);

    const [disputeRecord] = firstRecords;
    expect(disputeRecord.questTitle).toBe(financeSeedDisputeQuestTitle);
    expect(disputeRecord.questStatus).toBe('QUEST_FAILED');
    expect(disputeRecord.reservationStatus).toBe('ACTIVE');
    expect(disputeRecord.reservationAmountSatang).toBe(financeSeedDisputeAmountSatang);
    expect(disputeRecord.assignmentStatus).toBe('ASSIGNMENT_INCOMPLETE');
    expect(disputeRecord.disputeStatus).toBe('DISPUTE_CASE_PENDING');
    expect(disputeRecord.filerUserId).toBe(disputeRecord.workerId);

    // 2. Idempotency run: re-running the seed reuses existing records without duplication or errors
    const secondRun = Bun.spawnSync(['bun', financeSeedScript], {
      env: testEnv,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const secondOutput = `${secondRun.stdout.toString()}${secondRun.stderr.toString()}`;

    expect(secondRun.exitCode).toBe(0);
    expect(secondOutput).toContain('Prepared pending Dispute Case');

    const secondRecords = await queryDisputeSeedContract();
    expect(secondRecords).toHaveLength(1);
    expect(secondRecords[0].disputeCaseId).toBe(disputeRecord.disputeCaseId);
    expect(secondRecords[0].questId).toBe(disputeRecord.questId);
    expect(secondRecords[0].reservationId).toBe(disputeRecord.reservationId);
    expect(secondRecords[0].assignmentId).toBe(disputeRecord.assignmentId);

    // 3. Terminal decision preservation: re-running the seed does not overwrite resolved/dismissed dispute cases
    const adminId = randomUUID();
    createdAdminIds.push(adminId);
    await db.insert(authAdmin).values({
      id: adminId,
      email: `admin-${runId}@ku.th`,
      firstName: 'Finance',
      lastName: 'Admin',
    });

    await db
      .update(adminDisputeCase)
      .set({
        status: 'DISPUTE_CASE_DISMISSED',
        resolvedByAdminId: adminId,
        resolvedAt: new Date(),
      })
      .where(eq(adminDisputeCase.id, disputeRecord.disputeCaseId));

    const thirdRun = Bun.spawnSync(['bun', financeSeedScript], {
      env: testEnv,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const thirdOutput = `${thirdRun.stdout.toString()}${thirdRun.stderr.toString()}`;

    expect(thirdRun.exitCode).toBe(0);
    expect(thirdOutput).toContain('Prepared pending Dispute Case');

    const [persistedDispute] = await db
      .select({
        status: adminDisputeCase.status,
        resolvedByAdminId: adminDisputeCase.resolvedByAdminId,
        resolvedAt: adminDisputeCase.resolvedAt,
      })
      .from(adminDisputeCase)
      .where(eq(adminDisputeCase.id, disputeRecord.disputeCaseId));

    expect(persistedDispute?.status).toBe('DISPUTE_CASE_DISMISSED');
    expect(persistedDispute?.resolvedByAdminId).toBe(adminId);
    expect(persistedDispute?.resolvedAt).toBeInstanceOf(Date);
  } finally {
    await cleanupFinanceTestData([financeEmail, recipientEmail], createdAdminIds);
  }
});
