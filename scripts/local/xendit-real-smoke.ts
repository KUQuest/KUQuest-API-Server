import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { paymentProviderEventInbox } from '@/database/schema/payment.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import {
  createPayoutDestinationEncryption,
  savePayoutDestination,
} from '@/modules/payout-destination';
import {
  getPayout,
  initiatePayout,
  processPayoutProviderEvent,
  quotePayout,
  XenditPayoutProvider,
} from '@/modules/payout';
import {
  getTopUp,
  initiateTopUp,
  processTopUpProviderEvent,
  quoteTopUp,
  XenditPromptPayProvider,
} from '@/modules/top-up';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  getWallet,
  positiveSatang,
  signedSatang,
  verifyWalletProjection,
} from '@/modules/wallet';

import { and, eq } from 'drizzle-orm';

const testAmountSatang = positiveSatang(100);
const waitTimeoutMs = 90_000;
const webhookBaseUrl = (process.env.XENDIT_TEST_WEBHOOK_BASE_URL ?? 'https://webhook-test.kubits.org').replace(/\/+$/, '');
const xenditBaseUrl = (process.env.XENDIT_API_BASE_URL ?? 'https://api.xendit.co').replace(/\/+$/, '');
const xenditPaymentApiVersion = process.env.XENDIT_API_VERSION ?? '2024-11-11';
const payoutBankCode = process.env.XENDIT_TEST_PAYOUT_BANK_CODE ?? 'SCB';
const payoutAccountNumber = process.env.XENDIT_TEST_PAYOUT_ACCOUNT_NUMBER ?? '1234567890';

type SmokeError = Error & { code?: string; providerCode?: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Unknown error.';
  const details = error as SmokeError;
  const codes = [details.code, details.providerCode].filter(Boolean).join('/');
  return codes ? `${codes}: ${error.message}` : error.message;
};

const requireSafeTestConfiguration = () => {
  assert(
    process.env.RUN_REAL_XENDIT_TESTS === 'true',
    'Refusing to run. Set RUN_REAL_XENDIT_TESTS=true for an explicit local Test Mode run.',
  );
  assert(
    env.nodeEnv === 'development' && env.deploymentEnv === 'development',
    'Refusing to run outside NODE_ENV=development and DEPLOYMENT_ENV=development.',
  );
  assert(
    env.xenditSecretKey?.startsWith('xnd_development_'),
    'Refusing to run because XENDIT_SECRET_KEY is not an Xendit Development API key.',
  );
  assert(env.xenditWebhookToken, 'XENDIT_WEBHOOK_TOKEN is required.');
  assert(env.paymentProviderEventEncryptionKey, 'PAYMENT_PROVIDER_EVENT_ENCRYPTION_KEY is required.');
  assert(env.payoutDestinationEncryptionKey, 'PAYOUT_DESTINATION_ENCRYPTION_KEY is required.');
};

const waitForProviderEvent = async (resourceType: 'TOP_UP' | 'PAYOUT', internalReference: string) => {
  const deadline = Date.now() + waitTimeoutMs;
  let nextProgressAt = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // Polling must stay sequential so the database is checked at fixed intervals.
    // eslint-disable-next-line no-await-in-loop
    const [event] = await db
      .select()
      .from(paymentProviderEventInbox)
      .where(and(
        eq(paymentProviderEventInbox.resourceType, resourceType),
        eq(paymentProviderEventInbox.internalReference, internalReference),
      ))
      .limit(1);
    if (event) return event;

    if (Date.now() >= nextProgressAt) {
      console.log(`[local-xendit] waiting for ${resourceType} webhook...`);
      nextProgressAt = Date.now() + 10_000;
    }
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(1_000);
  }
  throw new Error(`${resourceType} webhook was not stored within ${waitTimeoutMs / 1_000} seconds.`);
};

const providerErrorPayload = async (response: Response) => {
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = null;
  }
  const code = typeof payload?.error_code === 'string'
    ? payload.error_code
    : typeof payload?.code === 'string'
      ? payload.code
      : undefined;
  const message = typeof payload?.message === 'string' ? payload.message : 'No provider message.';
  return code ? `${code}: ${message}` : message;
};

const simulatePayment = async (paymentRequestId: string, amountSatang: number) => {
  const response = await fetch(`${xenditBaseUrl}/v3/payment_requests/${encodeURIComponent(paymentRequestId)}/simulate`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${env.xenditSecretKey}:`)}`,
      'content-type': 'application/json',
      'api-version': xenditPaymentApiVersion,
    },
    body: JSON.stringify({ amount: amountSatang / 100 }),
  });
  if (!response.ok) {
    throw new Error(`Xendit payment simulation failed with HTTP ${response.status}: ${await providerErrorPayload(response)}`);
  }
};

const createTestMember = async (runId: string) => {
  const id = crypto.randomUUID();
  await db.insert(authUser).values({
    id,
    email: `local-xendit-${runId}@ku.th`,
    firstName: 'Local Xendit',
    lastName: 'Test',
  });
  const wallet = await ensureWallet(id);
  return { id, walletId: wallet.id };
};

const runInternalLedgerTest = async (userId: string, walletId: string, runId: string) => {
  const accounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, userId));
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  const earnings = accounts.find((account) => account.type === 'EARNINGS');
  assert(earnings && suspense, 'Wallet Ledger accounts were not provisioned.');

  const ledger = await createSealedLedgerTransaction({
    businessReference: `local-xendit-internal:${runId}`,
    eventType: 'ADJUSTMENT',
    description: 'Local Xendit smoke-test Earnings funding',
    postings: [
      { accountId: earnings.id, amountSatang: signedSatang(10_000) },
      { accountId: suspense.id, amountSatang: signedSatang(-10_000) },
    ],
  });
  assert(ledger.sealedAt instanceof Date, 'Internal Ledger transaction was not sealed.');

  const wallet = await getWallet(userId);
  const projection = await verifyWalletProjection(walletId);
  assert(wallet.earningsBalanceSatang === 10_000, 'Internal Ledger transaction did not update Earnings Balance.');
  assert(projection.matches, 'Wallet projection does not match the sealed Ledger.');
  return `sealed ${ledger.id}; Earnings Balance = 10,000 satang`;
};

const runPaymentTest = async (userId: string, runId: string) => {
  const quote = await quoteTopUp({
    principalUserId: userId,
    creditSatang: testAmountSatang,
  });
  const topUp = await initiateTopUp({
    principalUserId: userId,
    quoteId: quote.id,
    idempotency: { key: `local-xendit-payment:${runId}` },
  }, new XenditPromptPayProvider());
  assert(topUp.providerReference, 'Xendit did not return a payment request reference.');

  await simulatePayment(topUp.providerReference, topUp.paymentTotalSatang);
  const event = await waitForProviderEvent('TOP_UP', topUp.internalReference);
  await processTopUpProviderEvent(event.id);

  const completed = await getTopUp(userId, topUp.id);
  const wallet = await getWallet(userId);
  assert(completed.topUpStatus === 'PAID', `Top-up ended in ${completed.topUpStatus}, not PAID.`);
  assert(completed.creditedLedgerTransactionId, 'Paid Top-up has no credit Ledger transaction.');
  assert(wallet.spendingBalanceSatang === 100, 'Paid Top-up did not credit 100 satang to Spending Balance.');
  return `Xendit payment ${topUp.providerReference}; Top-up PAID; Spending Balance = 100 satang`;
};

const runPayoutTest = async (userId: string, runId: string) => {
  const encryption = createPayoutDestinationEncryption();
  await savePayoutDestination({
    principalUserId: userId,
    givenName: 'Local Xendit',
    surname: 'Test',
    relationship: 'SELF',
    bankCode: payoutBankCode,
    accountNumber: payoutAccountNumber,
    accountHolderName: 'Local Xendit Test',
    routingType: 'BANK_ACCOUNT',
    routingValue: payoutAccountNumber,
  }, encryption);

  const quote = await quotePayout({
    principalUserId: userId,
    receiptSatang: testAmountSatang,
  });
  const payout = await initiatePayout({
    principalUserId: userId,
    quoteId: quote.id,
    idempotency: { key: `local-xendit-payout:${runId}` },
  }, new XenditPayoutProvider(), encryption);
  assert(payout.providerReference, 'Xendit did not return a Payout reference.');

  const event = await waitForProviderEvent('PAYOUT', payout.internalReference);
  await processPayoutProviderEvent(event.id);

  const completed = await getPayout(userId, payout.id);
  const wallet = await getWallet(userId);
  assert(completed.payoutStatus === 'COMPLETED', `Payout ended in ${completed.payoutStatus}, not COMPLETED.`);
  assert(completed.finalLedgerTransactionId, 'Completed Payout has no final Ledger transaction.');
  assert(wallet.reservedForPayoutsSatang === 0, 'Completed Payout did not release the Payout Reserve.');
  return `Xendit Payout ${payout.providerReference}; Payout COMPLETED; Payout Reserve = 0 satang`;
};

const run = async () => {
  requireSafeTestConfiguration();
  const health = await fetch(`${webhookBaseUrl}/health`);
  assert(health.ok, `Webhook origin health check failed with HTTP ${health.status}.`);
  await sql`select 1`;
  await ensureInitialMoneyPolicy();

  const runId = crypto.randomUUID();
  const member = await createTestMember(runId);
  console.log(`[local-xendit] local Member fixture: ${member.id}`);
  console.log(`[local-xendit] Payout test destination: ${payoutBankCode} / account number hidden`);

  const failures: string[] = [];
  const cases: Array<[string, () => Promise<string>]> = [
    ['internal Ledger transaction', () => runInternalLedgerTest(member.id, member.walletId, runId)],
    ['real Xendit payment and callback', () => runPaymentTest(member.id, runId)],
    ['real Xendit Payout and callback', () => runPayoutTest(member.id, runId)],
  ];

  for (const [name, test] of cases) {
    try {
      console.log(`[local-xendit] START ${name}`);
      // Run these checks in order because they share one local Wallet fixture.
      // eslint-disable-next-line no-await-in-loop
      console.log(`[local-xendit] PASS ${name}: ${await test()}`);
    } catch (error: unknown) {
      const message = errorMessage(error);
      failures.push(`${name}: ${message}`);
      console.error(`[local-xendit] FAIL ${name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Local Xendit smoke test failed:\n- ${failures.join('\n- ')}`);
  }
  console.log('[local-xendit] ALL TESTS PASSED');
};

try {
  await run();
} finally {
  await sql.end({ timeout: 5 });
}
