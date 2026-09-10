import { env, isFinanceTestRuntime } from '@/config/env';
import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  InboundPaymentProviderError,
  getTopUp,
  initiateTopUp,
  quoteTopUp,
  simulateTopUpPayment,
  TopUpTestModeError,
} from '@/modules/top-up';
import {
  ensureWallet,
  getWallet,
  MoneyDomainError,
  positiveSatang,
  reserveSpending,
  satang,
  settleFundingReservation,
} from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';
import { eq } from 'drizzle-orm';
import QRCode from 'qrcode';

import type {
  localTestPaymentBodySchema,
  localTestTransferBodySchema,
} from './local-finance-test.schema';

type PaymentBody = Static<typeof localTestPaymentBodySchema>;
type TransferBody = Static<typeof localTestTransferBodySchema>;
type HandlerContext = {
  body: PaymentBody | TransferBody;
  request: Request;
  session: { user: { id: string; email: string } };
  set: { status?: number | string };
};

class LocalFinanceTestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalFinanceTestError';
  }
}

const testUserEmail = env.stagingTestAuthEmail?.trim().toLowerCase();
const recipientEmail = env.localFinanceTestRecipientEmail?.trim().toLowerCase();

export const localFinanceTestIsEnabled = Boolean(
  env.localFinanceTestEnabled &&
  isFinanceTestRuntime(env.nodeEnv, env.deploymentEnv) &&
  env.stagingTestAuthEnabled &&
  env.xenditSecretKey?.startsWith('xnd_development_') &&
  testUserEmail &&
  recipientEmail,
);

export const isConfiguredLocalFinanceTestUser = (email: string): boolean => (
  localFinanceTestIsEnabled && email.trim().toLowerCase() === testUserEmail
);

const errorResponse = (set: HandlerContext['set'], error: unknown): ApiResponse => {
  if (error instanceof TopUpTestModeError) {
    set.status = 502;
    return apiError(error.code, error.message);
  }
  if (error instanceof InboundPaymentProviderError) {
    set.status = 502;
    return apiError(error.code, error.message);
  }
  if (error instanceof MoneyDomainError) {
    set.status = 409;
    return apiError(error.code, error.message);
  }
  if (error instanceof LocalFinanceTestError) {
    set.status = 502;
    return apiError(error.code, error.message);
  }
  throw error;
};

const serializeWallet = (wallet: Awaited<ReturnType<typeof getWallet>>) => ({
  spendingBalanceSatang: wallet.spendingBalanceSatang,
  earningsBalanceSatang: wallet.earningsBalanceSatang,
  fundingReservedSatang: wallet.fundingReservedSatang,
  reservedForPayoutsSatang: wallet.reservedForPayoutsSatang,
});

const serializeTopUp = (topUp: Awaited<ReturnType<typeof getTopUp>>) => ({
  id: topUp.id,
  internalReference: topUp.internalReference,
  providerReference: topUp.providerReference,
  providerStatus: topUp.providerStatus,
  providerChannelCode: topUp.providerChannelCode,
  creditSatang: topUp.creditSatang,
  paymentTotalSatang: topUp.paymentTotalSatang,
  qrPayload: topUp.qrPayload,
  qrExpiresAt: topUp.qrExpiresAt?.toISOString() ?? null,
  topUpStatus: topUp.topUpStatus,
});

const qrDataUrlFor = async (payload: string | null): Promise<string | null> => (
  payload
    ? QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
    })
    : null
);

const ensureRecipient = async (payerId: string) => {
  if (!recipientEmail || recipientEmail === testUserEmail) {
    throw new LocalFinanceTestError(
      'TEST_RECIPIENT_NOT_CONFIGURED',
      'The local finance test recipient is not configured correctly.',
    );
  }

  let [recipient] = await db
    .select({ id: authUser.id, email: authUser.email })
    .from(authUser)
    .where(eq(authUser.email, recipientEmail))
    .limit(1);
  if (!recipient) {
    [recipient] = await db
      .insert(authUser)
      .values({
        id: crypto.randomUUID(),
        email: recipientEmail,
        firstName: env.localFinanceTestRecipientFirstName ?? 'Finance',
        lastName: env.localFinanceTestRecipientLastName ?? 'Recipient',
      })
      .onConflictDoNothing()
      .returning({ id: authUser.id, email: authUser.email });
  }
  if (!recipient) {
    [recipient] = await db
      .select({ id: authUser.id, email: authUser.email })
      .from(authUser)
      .where(eq(authUser.email, recipientEmail))
      .limit(1);
  }
  if (!recipient || recipient.id === payerId) {
    throw new LocalFinanceTestError('TEST_RECIPIENT_NOT_FOUND', 'The local finance test recipient could not be created.');
  }
  await ensureWallet(recipient.id);
  return recipient;
};

export const createLocalTestPayment = async ({
  body,
  request,
  session,
  set,
}: HandlerContext): Promise<ApiResponse> => {
  try {
    const creditSatang = positiveSatang('creditSatang' in body ? body.creditSatang ?? 100 : 100);
    const quote = await quoteTopUp({ principalUserId: session.user.id, creditSatang });
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() || `local-test-payment:${crypto.randomUUID()}`;
    let topUp = await initiateTopUp({
      principalUserId: session.user.id,
      quoteId: quote.id,
      idempotency: { key: idempotencyKey },
    });

    const simulated = 'simulate' in body && body.simulate === true;
    let callbackReceived = false;
    let reconciliationUsed = false;
    if (simulated) {
      const simulation = await simulateTopUpPayment(session.user.id, topUp.id);
      topUp = simulation.topUp;
      callbackReceived = simulation.callbackReceived;
      reconciliationUsed = simulation.reconciliationUsed;
    }

    const serializedTopUp = serializeTopUp(topUp);
    return apiSuccess({
      testUserEmail: session.user.email,
      simulated,
      callbackReceived,
      reconciliationUsed,
      topUp: {
        ...serializedTopUp,
        qrDataUrl: await qrDataUrlFor(topUp.qrPayload),
      },
      wallet: serializeWallet(await getWallet(session.user.id)),
    });
  } catch (error: unknown) {
    return errorResponse(set, error);
  }
};

export const getLocalTestWallet = async ({
  session,
  set,
}: Pick<HandlerContext, 'session' | 'set'>): Promise<ApiResponse> => {
  try {
    const wallet = await ensureWallet(session.user.id);
    return apiSuccess({
      testUserEmail: session.user.email,
      wallet: serializeWallet(wallet),
    });
  } catch (error: unknown) {
    return errorResponse(set, error);
  }
};

export const createLocalTestTransfer = async ({
  body,
  request,
  session,
  set,
}: HandlerContext): Promise<ApiResponse> => {
  try {
    const amountSatang = positiveSatang('amountSatang' in body ? body.amountSatang ?? 100 : 100);
    const recipient = await ensureRecipient(session.user.id);
    const transferKey = request.headers.get('idempotency-key')?.trim() || `local-test-transfer:${crypto.randomUUID()}`;
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: session.user.id,
      callerScope: 'local-finance-test',
      callerReference: transferKey,
      amountSatang,
    }));
    const settlement = await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: session.user.id,
      reservationId: reservation.id,
      settlementReference: `${transferKey}:settlement`,
      recipientUserId: recipient.id,
      recipientAmountSatang: amountSatang,
      platformFeeSatang: satang(0),
    }));

    return apiSuccess({
      payerEmail: session.user.email,
      recipientEmail: recipient.email,
      amountSatang,
      reservation: {
        id: reservation.id,
        status: 'SETTLED',
        remainingSatang: 0,
      },
      settlement: {
        id: settlement.id,
        ledgerTransactionId: settlement.ledgerTransactionId,
        recipientAmountSatang: settlement.recipientAmountSatang,
        totalAmountSatang: settlement.totalAmountSatang,
      },
      payerWallet: serializeWallet(await getWallet(session.user.id)),
      recipientWallet: serializeWallet(await getWallet(recipient.id)),
    });
  } catch (error: unknown) {
    return errorResponse(set, error);
  }
};
