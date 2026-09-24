import { defaultLocalDatabaseUrl } from '@/config/default-database-url';
import { sql } from '@/database/client';
import { getWallet } from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { expect, test } from 'bun:test';

import {
  financeSeedEarningsSatang,
  financeSeedPayoutReceiptSatang,
  financeSeedQuestTitle,
  financeSeedSpendingSatang,
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
// all 10 demo students, demo open/completed quests, reviews, and demo dispute case),
// so running verify-staging-seed.ts standalone fails on missing demo fixtures in an isolated test database.
// To keep the test fully deterministic and safe, we run the supported financeSeedScript directly
// and assert against the finance seed contracts:
//   - Finance test Student and recipient auth users prepared
//   - Payout Destination and pending Payout created
//   - Finance Quest Escrow draft prepared with status QUEST_DRAFT
//   - Wallet spending and earnings balances properly seeded
//   - Idempotent re-execution with no duplicate records or errors
//   - Zero provider network calls made
test('finance seed prepares and idempotently reuses the finance Student, Payout, and draft Quest', async () => {
  await ensurePostgres();

  const runId = randomUUID();
  const financeEmail = `finance-test-${runId}@ku.th`;
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
  await sql`
    INSERT INTO tag (name)
    VALUES ('Design')
    ON CONFLICT (name) DO NOTHING
  `;

  const queryFinanceContract = async () => {
    const [student] = await sql<
      {
        id: string;
        email: string;
      }[]
    >`
      SELECT id, email
      FROM auth_user
      WHERE lower(email) = ${financeEmail.toLowerCase()}
      LIMIT 1
    `;

    const [recipient] = await sql<
      {
        id: string;
        email: string;
      }[]
    >`
      SELECT id, email
      FROM auth_user
      WHERE lower(email) = ${recipientEmail.toLowerCase()}
      LIMIT 1
    `;

    const draftQuests = await sql<
      {
        id: string;
        title: string;
        questStatus: string;
        tagName: string;
      }[]
    >`
      SELECT quest.id, quest.title, quest.quest_status AS "questStatus", tag.name AS "tagName"
      FROM quest
      INNER JOIN tag ON tag.id = quest.tag_id
      WHERE quest.hirer_id = ${student?.id ?? ''}
        AND quest.title = ${financeSeedQuestTitle}
    `;

    const destinations = await sql<
      {
        id: string;
        retiredAt: Date | null;
      }[]
    >`
      SELECT id, retired_at AS "retiredAt"
      FROM payment_payout_accounts
      WHERE user_id = ${student?.id ?? ''}
        AND retired_at IS NULL
    `;

    const payouts = await sql<
      {
        id: string;
        payoutStatus: string;
      }[]
    >`
      SELECT id, payout_status AS "payoutStatus"
      FROM payment_payouts
      WHERE user_id = ${student?.id ?? ''}
        AND payout_status = 'PENDING_ADMIN_APPROVAL'
    `;

    return {
      student,
      recipient,
      draftQuests,
      destinations,
      payouts,
    };
  };

  try {
    // 1. Initial run: seed creates finance Student, recipient, Payout Destination, pending Payout, and Quest draft
    const firstRun = Bun.spawnSync(['bun', financeSeedScript], {
      env: testEnv,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const firstOutput = `${firstRun.stdout.toString()}${firstRun.stderr.toString()}`;

    expect(firstRun.exitCode).toBe(0);
    expect(firstOutput).toContain(`Prepared finance test Student ${financeEmail}`);
    expect(firstOutput).toContain(`Prepared finance test recipient ${recipientEmail}`);
    expect(firstOutput).toContain('Prepared Quest Escrow draft');
    expect(firstOutput).toContain('No provider call was made by the finance seed.');

    const firstData = await queryFinanceContract();
    expect(firstData.student).toBeDefined();
    expect(firstData.recipient).toBeDefined();
    expect(firstData.draftQuests).toHaveLength(1);
    expect(firstData.draftQuests[0]?.questStatus).toBe('QUEST_DRAFT');
    expect(firstData.draftQuests[0]?.tagName).toBe('Design');
    expect(firstData.destinations).toHaveLength(1);
    expect(firstData.payouts).toHaveLength(1);

    const wallet = await getWallet(firstData.student!.id);
    expect(Number(wallet.spendingBalanceSatang)).toBe(financeSeedSpendingSatang);
    expect(Number(wallet.earningsBalanceSatang)).toBe(
      financeSeedEarningsSatang - financeSeedPayoutReceiptSatang
    );

    // 2. Idempotency run: re-running the seed reuses existing records without duplication or errors
    const secondRun = Bun.spawnSync(['bun', financeSeedScript], {
      env: testEnv,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const secondOutput = `${secondRun.stdout.toString()}${secondRun.stderr.toString()}`;

    expect(secondRun.exitCode).toBe(0);
    expect(secondOutput).toContain(`Prepared finance test Student ${financeEmail}`);
    expect(secondOutput).toContain('No provider call was made by the finance seed.');

    const secondData = await queryFinanceContract();
    expect(secondData.draftQuests).toHaveLength(1);
    expect(secondData.draftQuests[0]?.id).toBe(firstData.draftQuests[0]?.id);
    expect(secondData.destinations).toHaveLength(1);
    expect(secondData.destinations[0]?.id).toBe(firstData.destinations[0]?.id);
    expect(secondData.payouts).toHaveLength(1);
    expect(secondData.payouts[0]?.id).toBe(firstData.payouts[0]?.id);
  } finally {
    await cleanupFinanceTestData([financeEmail, recipientEmail]);
  }
});
