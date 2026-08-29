import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { department, occupation } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletLedgerAccount } from '@/database/schema/wallet.schema';
import {
  createPayoutDestinationEncryption,
  getPayoutDestination,
  savePayoutDestination,
} from '@/modules/payout-destination';
import { createStudentAuth } from '@/modules/auth';
import { initiatePayout, quotePayout } from '@/modules/payout';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  getWallet,
  positiveSatang,
  signedSatang,
} from '@/modules/wallet';
import {
  questMode,
  questParticipation,
  questStatus,
} from '@/modules/quest/quest.contract';

import { and, eq, inArray, isNull } from 'drizzle-orm';

export const financeSeedQuestTitle = '[Finance Test] Publish Escrow Quest Draft';
export const financeSeedSpendingSatang = 1_000_000;
export const financeSeedEarningsSatang = 500_000;
export const financeSeedPayoutReceiptSatang = 100_000;

const requireValue = (name: string, value: string | undefined): string => {
  if (!value?.trim()) throw new Error(`${name} is required for the finance seed.`);
  return value.trim();
};

const assertFinanceSeedEnvironment = (): {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  recipientEmail: string;
  recipientFirstName: string;
  recipientLastName: string;
} => {
  if (process.env.STAGING_FINANCE_SEED_ENABLED !== 'true') {
    throw new Error('Set STAGING_FINANCE_SEED_ENABLED=true to run the finance seed.');
  }

  const isDevelopmentSeed =
    env.nodeEnv === 'development' && env.deploymentEnv === 'development';
  const isStagingSeed = env.nodeEnv === 'production' && env.deploymentEnv === 'staging';
  if (!isDevelopmentSeed && !isStagingSeed) {
    throw new Error(
      'The finance seed is allowed only in development/development or production/staging.',
    );
  }

  if (!env.xenditSecretKey?.startsWith('xnd_development_')) {
    throw new Error('The finance seed requires an Xendit Development API key.');
  }

  if (!env.payoutDestinationEncryptionKey) {
    throw new Error('PAYOUT_DESTINATION_ENCRYPTION_KEY is required for the finance seed.');
  }

  const email = requireValue('STAGING_TEST_AUTH_EMAIL', env.stagingTestAuthEmail).toLowerCase();
  if (!/^[^\s@]+@ku\.th$/.test(email)) {
    throw new Error('STAGING_TEST_AUTH_EMAIL must be a valid @ku.th email.');
  }

  const recipientEmail = requireValue(
    'LOCAL_FINANCE_TEST_RECIPIENT_EMAIL',
    env.localFinanceTestRecipientEmail,
  ).toLowerCase();
  if (!/^[^\s@]+@ku\.th$/.test(recipientEmail) || recipientEmail === email) {
    throw new Error('LOCAL_FINANCE_TEST_RECIPIENT_EMAIL must be a different @ku.th email.');
  }

  return {
    email,
    password: requireValue('STAGING_TEST_AUTH_PASSWORD', env.stagingTestAuthPassword),
    firstName: requireValue('STAGING_TEST_AUTH_FIRST_NAME', env.stagingTestAuthFirstName),
    lastName: requireValue('STAGING_TEST_AUTH_LAST_NAME', env.stagingTestAuthLastName),
    recipientEmail,
    recipientFirstName: requireValue(
      'LOCAL_FINANCE_TEST_RECIPIENT_FIRST_NAME',
      env.localFinanceTestRecipientFirstName,
    ),
    recipientLastName: requireValue(
      'LOCAL_FINANCE_TEST_RECIPIENT_LAST_NAME',
      env.localFinanceTestRecipientLastName,
    ),
  };
};

const ensureFinanceStudent = async (settings: ReturnType<typeof assertFinanceSeedEnvironment>) => {
  const studentAuth = createStudentAuth({
    emailAndPasswordEnabled: true,
    allowEmailSignUp: true,
    autoSignIn: false,
  });
  let [student] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, settings.email))
    .limit(1);

  if (!student) {
    const result = await studentAuth.api.signUpEmail({
      body: {
        email: settings.email,
        password: settings.password,
        name: `${settings.firstName} ${settings.lastName}`,
        firstName: settings.firstName,
        lastName: settings.lastName,
      },
    });
    if (!result.user) throw new Error('The finance test Student could not be created.');
    student = { id: result.user.id };
  }

  const [studentOccupation] = await db
    .select({ id: occupation.id })
    .from(occupation)
    .where(eq(occupation.requiresStudentId, true))
    .limit(1);
  const [studentDepartment] = await db
    .select({ id: department.id })
    .from(department)
    .orderBy(department.id)
    .limit(1);

  await db
    .update(authUser)
    .set({
      emailVerified: true,
      firstName: settings.firstName,
      lastName: settings.lastName,
      studentId: '6599999999',
      occupationId: studentOccupation?.id,
      departmentId: studentDepartment?.id,
      termsAcceptedAt: new Date(),
      termsVersion: '1.0',
    })
    .where(eq(authUser.id, student.id));

  return student.id;
};

const ensureFinanceRecipient = async (settings: ReturnType<typeof assertFinanceSeedEnvironment>) => {
  const [existing] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, settings.recipientEmail))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(authUser)
    .values({
      id: crypto.randomUUID(),
      email: settings.recipientEmail,
      emailVerified: true,
      firstName: settings.recipientFirstName,
      lastName: settings.recipientLastName,
    })
    .returning({ id: authUser.id });
  if (!created) throw new Error('The finance test recipient could not be created.');
  return created.id;
};

const walletAccount = async (userId: string, type: 'SPENDING' | 'EARNINGS') => {
  const wallet = await ensureWallet(userId);
  const [account] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, type)))
    .limit(1);
  if (!account) throw new Error(`The finance test ${type} Ledger Account is missing.`);
  return account.id;
};

const platformSuspenseAccount = async (): Promise<string> => {
  const [account] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(
      eq(walletLedgerAccount.type, 'PLATFORM_SUSPENSE'),
      isNull(walletLedgerAccount.walletId),
    ))
    .limit(1);
  if (!account) throw new Error('The platform suspense Ledger Account is missing.');
  return account.id;
};

const seedBalance = async (
  userId: string,
  type: 'spending' | 'earnings',
  amountSatang: number,
): Promise<void> => {
  const walletAccountId = await walletAccount(userId, type.toUpperCase() as 'SPENDING' | 'EARNINGS');
  const suspenseAccountId = await platformSuspenseAccount();
  await createSealedLedgerTransaction({
    businessReference: `seed:finance:${userId}:${type}:v1`,
    eventType: 'ADJUSTMENT',
    createdByUserId: userId,
    description: 'Non-production finance test seed',
    postings: [
      { accountId: walletAccountId, amountSatang: signedSatang(amountSatang) },
      { accountId: suspenseAccountId, amountSatang: signedSatang(-amountSatang) },
    ],
    idempotency: {
      principalUserId: userId,
      operationScope: 'seed.finance',
      key: `v1:${type}`,
      requestHash: `seed-finance-v1:${type}:${amountSatang}`,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    },
  });
};

const ensurePayoutDestination = async (userId: string, settings: ReturnType<typeof assertFinanceSeedEnvironment>) => {
  const existing = await getPayoutDestination(userId);
  if (existing) return existing;

  return savePayoutDestination(
    {
      principalUserId: userId,
      givenName: settings.firstName,
      surname: settings.lastName,
      relationship: 'SELF',
      bankCode: 'PROMPTPAY',
      accountNumber: '1234567890',
      accountHolderName: `${settings.firstName} ${settings.lastName}`,
      routingType: 'PROMPTPAY',
      routingValue: '0812345678',
    },
    createPayoutDestinationEncryption(),
  );
};

const ensurePendingPayout = async (userId: string): Promise<{ id: string; payoutStatus: string }> => {
  const [existing] = await db
    .select({ id: paymentPayouts.id, payoutStatus: paymentPayouts.payoutStatus })
    .from(paymentPayouts)
    .where(and(
      eq(paymentPayouts.userId, userId),
      inArray(paymentPayouts.payoutStatus, [
        'PENDING_ADMIN_APPROVAL',
        'CREATING',
        'PENDING',
        'AWAITING_RECONCILIATION',
      ]),
    ))
    .limit(1);
  if (existing) return existing;

  const quote = await quotePayout({
    principalUserId: userId,
    receiptSatang: positiveSatang(financeSeedPayoutReceiptSatang),
  });
  const payout = await initiatePayout({
    principalUserId: userId,
    quoteId: quote.id,
    idempotency: { key: `finance-seed-payout-v1:${quote.id}` },
  });
  return { id: payout.id, payoutStatus: payout.payoutStatus };
};

const ensureFinanceQuestDraft = async (userId: string): Promise<string> => {
  const [existing] = await db
    .select({ id: quest.id })
    .from(quest)
    .where(and(eq(quest.hirerId, userId), eq(quest.title, financeSeedQuestTitle)))
    .limit(1);
  if (existing) return existing.id;

  const [designTag] = await db
    .select({ id: tag.id })
    .from(tag)
    .where(eq(tag.name, 'Design'))
    .limit(1);
  if (!designTag) throw new Error('The Design Tag is missing.');

  const now = Date.now();
  const [created] = await db
    .insert(quest)
    .values({
      hirerId: userId,
      title: financeSeedQuestTitle,
      description: 'A non-production Quest for testing publish and Quest Escrow.',
      condition: 'Submit the requested design and a short explanation.',
      mode: questMode.noCandidate,
      participation: questParticipation.solo,
      questStatus: questStatus.draft,
      rewardSatang: positiveSatang(50_000),
      tagId: designTag.id,
      headcount: 1,
      startTime: new Date(now + 7 * 24 * 60 * 60 * 1000),
      dueAt: new Date(now + 14 * 24 * 60 * 60 * 1000),
      proofRequired: true,
    })
    .returning({ id: quest.id });
  if (!created) throw new Error('The finance test Quest draft could not be created.');
  return created.id;
};

const main = async (): Promise<void> => {
  const settings = assertFinanceSeedEnvironment();
  await ensureInitialMoneyPolicy();

  const financeMemberId = await ensureFinanceStudent(settings);
  const recipientId = await ensureFinanceRecipient(settings);
  await ensureWallet(recipientId);
  await seedBalance(financeMemberId, 'spending', financeSeedSpendingSatang);
  await seedBalance(financeMemberId, 'earnings', financeSeedEarningsSatang);
  const destination = await ensurePayoutDestination(financeMemberId, settings);
  const payout = await ensurePendingPayout(financeMemberId);
  const questId = await ensureFinanceQuestDraft(financeMemberId);
  const wallet = await getWallet(financeMemberId);

  console.log(`Prepared finance test Student ${settings.email}.`);
  console.log(`Prepared finance test recipient ${settings.recipientEmail}.`);
  console.log(`Prepared Payout Destination ${destination.maskedRoutingValue}.`);
  console.log(`Prepared Payout ${payout.id} with status ${payout.payoutStatus}.`);
  console.log(`Prepared Quest Escrow draft ${questId}.`);
  console.log(
    `Seeded Wallet balances: Spending ${wallet.spendingBalanceSatang} satang, Earnings ${wallet.earningsBalanceSatang} satang.`,
  );
  console.log('No provider call was made by the finance seed.');
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Finance seed failed.');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
