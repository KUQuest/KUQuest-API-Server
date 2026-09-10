import { env, isFinanceTestRuntime } from '@/config/env';
import { db } from '@/database/client';
import { paymentProviderEventInbox } from '@/database/schema/payment.schema';

import { and, eq } from 'drizzle-orm';

import {
  XENDIT_PAYMENT_REQUESTS_API_VERSION,
  type InboundPaymentReconciliationProvider,
  XenditPromptPayProvider,
} from './top-up.provider';
import {
  getTopUp,
  type TopUp,
} from './top-up.service';
import {
  processTopUpProviderEvent,
  reconcileTopUp,
} from './top-up.provider-event.service';

const callbackWaitMs = 30_000;

export class TopUpTestModeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TopUpTestModeError';
  }
}

export const topUpTestSimulationIsEnabled = (): boolean => (
  isFinanceTestRuntime(env.nodeEnv, env.deploymentEnv)
  && env.xenditSecretKey?.startsWith('xnd_development_') === true
);

const providerErrorPayload = async (response: Response): Promise<string> => {
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = null;
  }
  const code = typeof payload?.error_code === 'string' ? payload.error_code : undefined;
  const message = typeof payload?.message === 'string' ? payload.message : 'No provider message.';
  return code ? `${code}: ${message}` : message;
};

const simulatePayment = async (paymentRequestId: string, amountSatang: number): Promise<void> => {
  if (!env.xenditSecretKey) {
    throw new TopUpTestModeError('TEST_PAYMENT_SIMULATION_UNAVAILABLE', 'Xendit is not configured.');
  }
  const baseUrl = (process.env.XENDIT_API_BASE_URL ?? 'https://api.xendit.co').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/v3/payment_requests/${encodeURIComponent(paymentRequestId)}/simulate`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${env.xenditSecretKey}:`)}`,
      'content-type': 'application/json',
      'api-version': process.env.XENDIT_API_VERSION ?? XENDIT_PAYMENT_REQUESTS_API_VERSION,
    },
    body: JSON.stringify({ amount: amountSatang / 100 }),
  });
  if (!response.ok) {
    throw new TopUpTestModeError(
      'TEST_PAYMENT_SIMULATION_FAILED',
      `Xendit payment simulation failed: ${await providerErrorPayload(response)}`,
    );
  }
};

const waitForPaymentEvent = async (internalReference: string) => {
  const deadline = Date.now() + callbackWaitMs;
  while (Date.now() < deadline) {
    // Poll sequentially so the database is checked at fixed intervals.
    // eslint-disable-next-line no-await-in-loop
    const [event] = await db
      .select()
      .from(paymentProviderEventInbox)
      .where(and(
        eq(paymentProviderEventInbox.resourceType, 'TOP_UP'),
        eq(paymentProviderEventInbox.internalReference, internalReference),
      ))
      .limit(1);
    if (event) return event;
    // Poll sequentially so the database is checked at fixed intervals.
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(1_000);
  }
  throw new TopUpTestModeError(
    'TEST_PAYMENT_CALLBACK_TIMEOUT',
    'The Xendit callback was not stored within 30 seconds.',
  );
};

export type TopUpTestSimulationResult = {
  topUp: TopUp;
  callbackReceived: boolean;
  reconciliationUsed: boolean;
};

export const simulateTopUpPayment = async (
  principalUserId: string,
  topUpId: string,
  reconciliationProvider: InboundPaymentReconciliationProvider = new XenditPromptPayProvider(),
): Promise<TopUpTestSimulationResult> => {
  if (!topUpTestSimulationIsEnabled()) {
    throw new TopUpTestModeError(
      'TEST_PAYMENT_SIMULATION_UNAVAILABLE',
      'Automatic Xendit payment simulation is available only with an Xendit Development key in a test runtime.',
    );
  }

  let topUp = await getTopUp(principalUserId, topUpId);
  if (topUp.topUpStatus !== 'PENDING') {
    return { topUp, callbackReceived: false, reconciliationUsed: false };
  }
  if (!topUp.providerReference) {
    throw new TopUpTestModeError(
      'TEST_PAYMENT_REFERENCE_MISSING',
      'Xendit returned no Payment Request reference.',
    );
  }

  await simulatePayment(topUp.providerReference, topUp.paymentTotalSatang);
  let callbackReceived = false;
  let reconciliationUsed = false;
  try {
    const event = await waitForPaymentEvent(topUp.internalReference);
    await processTopUpProviderEvent(event.id);
    callbackReceived = true;
    topUp = await getTopUp(principalUserId, topUp.id);
  } catch (error: unknown) {
    if (!(error instanceof TopUpTestModeError) || error.code !== 'TEST_PAYMENT_CALLBACK_TIMEOUT') throw error;
    topUp = await reconcileTopUp(principalUserId, topUp.id, reconciliationProvider);
    reconciliationUsed = true;
  }

  return { topUp, callbackReceived, reconciliationUsed };
};
