import { createApp } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authSession } from '@/database/schema/auth.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import {
  createPayoutDestinationEncryption,
  savePayoutDestination,
} from '@/modules/payout-destination';
import {
  approvePayoutInTransaction,
  cancelPayoutInTransaction,
  getPayout,
  initiatePayout,
  processApprovedPayout,
  reconcilePayout,
  quotePayout,
} from '@/modules/payout';
import type { OutboundPayoutProvider, OutboundPayoutRequest } from '@/modules/payout';
import { getTopUp, initiateTopUp, quoteTopUp, reconcileTopUp } from '@/modules/top-up';
import type {
  InboundPaymentProvider,
  InboundPaymentRequest,
  InboundPaymentResponse,
} from '@/modules/top-up';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  satang,
  signedSatang,
} from '@/modules/wallet';

import { QuestWebSocketClient } from '../quest/quest-update-test-client';
import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'bun:test';

const password = 'TestStudent1!';
const members = [randomUUID(), randomUUID()].map((id) => ({
  email: `payment-events-${id}@ku.th`,
  firstName: 'Payment',
  lastName: 'Events',
}));
const authApps = members.map((member) =>
  new Elysia().use(
    createStagingTestAuthRoute({
      enabled: true,
      deploymentEnv: 'staging',
      ...member,
      password,
    })
  )
);
const sessions: { id: string; cookie: string }[] = [];
const destinationEncryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'p'.repeat(32) },
});

class TestInboundProvider implements InboundPaymentProvider {
  async createPayment(input: InboundPaymentRequest): Promise<InboundPaymentResponse> {
    return {
      providerReference: `payment-events-${randomUUID()}`,
      providerStatus: 'REQUIRES_ACTION',
      providerAmountSatang: input.paymentTotalSatang,
      providerApiVersion: 'test-v1',
      providerChannelCode: 'QRPROMPTPAY',
      qrPayload: 'test-qr',
      qrExpiresAt: input.expiresAt,
    };
  }
}

const connect = async (cookie: string, origin: string | null = 'http://localhost:5000') => {
  const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
  const port = server.server?.port;
  if (port === undefined) throw new Error('Payment status test server did not start');
  try {
    const socket = await QuestWebSocketClient.connect(
      port,
      '',
      cookie,
      origin,
      '/api/v1/payments/events'
    );
    return { server, socket };
  } catch (error) {
    await server.stop();
    throw error;
  }
};

const expectSubscribed = async (socket: QuestWebSocketClient) => {
  expect(JSON.parse((await socket.nextText())!)).toEqual({ type: 'SUBSCRIBED', version: 1 });
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
  for (const [index, member] of members.entries()) {
    const response = await authApps[index]!.handle(
      new Request('http://localhost/api/staging/test-auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: member.email, password }),
      })
    );
    if (response.status !== 200) throw new Error(`Sign-in failed: ${response.status}`);
    const body = (await response.json()) as { user: { id: string } };
    sessions.push({
      id: body.user.id,
      cookie: (response.headers.getSetCookie?.() ?? [])
        .map((header) => header.split(';', 1)[0])
        .join('; '),
    });
    await ensureWallet(body.user.id);
  }
});

describe('Member payment status stream', () => {
  it('delivers committed Top-up changes only to the owning Member', async () => {
    const owner = sessions[0]!;
    const other = sessions[1]!;
    const { server, socket } = await connect(owner.cookie);
    const second = await connect(other.cookie);
    try {
      await expectSubscribed(socket);
      await expectSubscribed(second.socket);
      const quote = await quoteTopUp({
        principalUserId: owner.id,
        creditSatang: positiveSatang(100),
      });
      const topUp = await initiateTopUp(
        {
          principalUserId: owner.id,
          quoteId: quote.id,
          idempotency: { key: `payment-events-top-up-${randomUUID()}` },
        },
        new TestInboundProvider()
      );
      expect(JSON.parse((await socket.nextText())!)).toEqual({
        type: 'PAYMENT_STATUS_CHANGED',
        version: 1,
        resourceType: 'TOP_UP',
        resourceId: topUp.id,
      });
      expect((await getTopUp(owner.id, topUp.id)).topUpStatus).toBe('PENDING');
      const reconciler = {
        getPaymentStatus: async (request: {
          providerReference: string | null;
          expectedPaymentTotalSatang: number;
        }) => ({
          providerReference: request.providerReference!,
          providerStatus: 'SUCCEEDED',
          normalizedStatus: 'PAID' as const,
          providerAmountSatang: positiveSatang(request.expectedPaymentTotalSatang),
          providerApiVersion: 'test-v1',
          providerChannelCode: 'QRPROMPTPAY',
          occurredAt: new Date(),
        }),
      };
      await reconcileTopUp(owner.id, topUp.id, reconciler);
      expect(JSON.parse((await socket.nextText())!)).toEqual({
        type: 'PAYMENT_STATUS_CHANGED',
        version: 1,
        resourceType: 'TOP_UP',
        resourceId: topUp.id,
      });
      expect((await getTopUp(owner.id, topUp.id)).topUpStatus).toBe('PAID');
      await reconcileTopUp(owner.id, topUp.id, reconciler);
      expect(await socket.nextText(150)).toBeUndefined();
      expect(await second.socket.nextText(150)).toBeUndefined();
      socket.destroy();
      const reconnect = await connect(owner.cookie);
      try {
        await expectSubscribed(reconnect.socket);
        const response = await createApp().handle(
          new Request(`http://localhost/api/v1/top-ups/${topUp.id}`, {
            headers: { cookie: owner.cookie },
          })
        );
        expect(response.status).toBe(200);
        expect((await response.json()) as { data: { topUpStatus: string } }).toMatchObject({
          data: { topUpStatus: 'PAID' },
        });
        expect(await reconnect.socket.nextText(150)).toBeUndefined();
      } finally {
        reconnect.socket.destroy();
        await reconnect.server.stop();
      }
    } finally {
      socket.destroy();
      second.socket.destroy();
      await second.server.stop();
      await server.stop();
    }
  });

  it('delivers a Payout Admin decision after commit, but no event for a rolled-back decision', async () => {
    const owner = sessions[0]!;
    const adminId = randomUUID();
    await db.insert(authAdmin).values({
      id: adminId,
      email: `${adminId}@example.com`,
      firstName: 'Payment',
      lastName: 'Admin',
    });
    const accounts = await db
      .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
      .from(walletLedgerAccount)
      .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
      .where(eq(walletWallet.userId, owner.id));
    const [suspense] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
    const earnings = accounts.find(({ type }) => type === 'EARNINGS');
    if (!suspense || !earnings) throw new Error('Wallet accounts missing');
    await createSealedLedgerTransaction({
      businessReference: `payment-events-credit-${randomUUID()}`,
      eventType: 'ADJUSTMENT',
      postings: [
        { accountId: earnings.id, amountSatang: signedSatang(1_000) },
        { accountId: suspense.id, amountSatang: signedSatang(-1_000) },
      ],
    });
    await savePayoutDestination(
      {
        principalUserId: owner.id,
        givenName: 'Payment',
        surname: 'Events',
        relationship: 'SELF',
        bankCode: 'SCB',
        accountNumber: '1234567890',
        accountHolderName: 'Payment Events',
        routingType: 'BANK_ACCOUNT',
        routingValue: '1234567890',
      },
      destinationEncryption
    );
    const { server, socket } = await connect(owner.cookie);
    try {
      await expectSubscribed(socket);
      const quote = await quotePayout({
        principalUserId: owner.id,
        receiptSatang: positiveSatang(100),
      });
      const payout = await initiatePayout({
        principalUserId: owner.id,
        quoteId: quote.id,
        idempotency: { key: `payment-events-payout-${randomUUID()}` },
      });
      const expected = {
        type: 'PAYMENT_STATUS_CHANGED',
        version: 1,
        resourceType: 'PAYOUT',
        resourceId: payout.id,
      };
      expect(JSON.parse((await socket.nextText())!)).toEqual(expected);
      await expect(
        db.transaction(async (transaction) => {
          await cancelPayoutInTransaction(transaction, {
            payoutId: payout.id,
            adminId,
            reasonCode: 'PAYOUT_POLICY_REVIEW',
          });
          throw new Error('roll back');
        })
      ).rejects.toThrow('roll back');
      expect(await socket.nextText(150)).toBeUndefined();
      expect((await getPayout(owner.id, payout.id)).payoutStatus).toBe('PENDING_ADMIN_APPROVAL');
      await db.transaction((transaction) =>
        cancelPayoutInTransaction(transaction, {
          payoutId: payout.id,
          adminId,
          reasonCode: 'PAYOUT_POLICY_REVIEW',
        })
      );
      expect(JSON.parse((await socket.nextText())!)).toEqual(expected);
      expect((await getPayout(owner.id, payout.id)).payoutStatus).toBe('CANCELLED');
      const nextQuote = await quotePayout({
        principalUserId: owner.id,
        receiptSatang: positiveSatang(100),
      });
      const nextPayout = await initiatePayout({
        principalUserId: owner.id,
        quoteId: nextQuote.id,
        idempotency: { key: `payment-events-worker-${randomUUID()}` },
      });
      expect(JSON.parse((await socket.nextText())!)).toMatchObject({
        resourceType: 'PAYOUT',
        resourceId: nextPayout.id,
      });
      await db.transaction((transaction) =>
        approvePayoutInTransaction(transaction, {
          payoutId: nextPayout.id,
          adminId,
          reasonCode: 'PAYOUT_POLICY_REVIEW',
        })
      );
      expect(JSON.parse((await socket.nextText())!)).toMatchObject({
        resourceType: 'PAYOUT',
        resourceId: nextPayout.id,
      });
      const provider: OutboundPayoutProvider = {
        createPayout: async (request: OutboundPayoutRequest) => ({
          providerReference: `payment-events-${randomUUID()}`,
          providerStatus: 'ACCEPTED',
          providerAmountSatang: request.receiptSatang,
          actualFeeSatang: satang(0),
          actualTaxSatang: satang(0),
          actualDebitSatang: request.receiptSatang,
          providerApiVersion: 'test-v1',
        }),
      };
      await processApprovedPayout(nextPayout.id, provider, destinationEncryption);
      expect(JSON.parse((await socket.nextText())!)).toMatchObject({
        resourceType: 'PAYOUT',
        resourceId: nextPayout.id,
      });
      expect((await getPayout(owner.id, nextPayout.id)).payoutStatus).toBe('PROVIDER_PENDING');
      const payoutReconciler = {
        getPayoutStatus: async (request: {
          providerReference: string | null;
          expectedPrincipalSatang: number;
        }) => ({
          providerReference: request.providerReference!,
          providerStatus: 'SUCCEEDED',
          normalizedStatus: 'SUCCEEDED' as const,
          providerAmountSatang: positiveSatang(request.expectedPrincipalSatang),
          actualFeeSatang: satang(0),
          actualTaxSatang: satang(0),
          actualDebitSatang: positiveSatang(request.expectedPrincipalSatang),
          providerApiVersion: 'test-v1',
          occurredAt: new Date(),
        }),
      };
      await reconcilePayout(owner.id, nextPayout.id, payoutReconciler);
      expect(JSON.parse((await socket.nextText())!)).toMatchObject({
        resourceType: 'PAYOUT',
        resourceId: nextPayout.id,
      });
      expect((await getPayout(owner.id, nextPayout.id)).payoutStatus).toBe('SUCCEEDED');
      await reconcilePayout(owner.id, nextPayout.id, payoutReconciler);
      expect(await socket.nextText(150)).toBeUndefined();
    } finally {
      socket.destroy();
      await server.stop();
    }
  });

  it('refuses anonymous sockets and closes non-read-only clients', async () => {
    await expect(connect('')).rejects.toThrow('WebSocket handshake rejected');
    const { server, socket } = await connect(sessions[0]!.cookie);
    try {
      await expectSubscribed(socket);
      socket.sendText('{}');
      const frame = await socket.nextFrame();
      expect(frame?.opcode).toBe(8);
      expect(frame?.payload.readUInt16BE(0)).toBe(1008);
    } finally {
      socket.destroy();
      await server.stop();
    }
  });

  it('rejects untrusted origins and limits simultaneous sockets for one Member', async () => {
    const cookie = sessions[0]!.cookie;
    const untrusted = await connect(cookie, 'https://untrusted.example');
    const first = await connect(cookie);
    const second = await connect(cookie);
    const excess = await connect(cookie);
    try {
      const denied = await untrusted.socket.nextFrame();
      expect(denied?.opcode).toBe(8);
      expect(denied?.payload.readUInt16BE(0)).toBe(4403);
      await expectSubscribed(first.socket);
      await expectSubscribed(second.socket);
      const limited = await excess.socket.nextFrame();
      expect(limited?.opcode).toBe(8);
      expect(limited?.payload.readUInt16BE(0)).toBe(4429);
    } finally {
      untrusted.socket.destroy();
      first.socket.destroy();
      second.socket.destroy();
      excess.socket.destroy();
      await excess.server.stop();
      await second.server.stop();
      await first.server.stop();
      await untrusted.server.stop();
    }
  });

  it('closes a revoked Session before delivering a later Top-up update', async () => {
    const member = sessions[1]!;
    const { server, socket } = await connect(member.cookie);
    try {
      await expectSubscribed(socket);
      await db.delete(authSession).where(eq(authSession.userId, member.id));
      const quote = await quoteTopUp({
        principalUserId: member.id,
        creditSatang: positiveSatang(100),
      });
      await initiateTopUp(
        {
          principalUserId: member.id,
          quoteId: quote.id,
          idempotency: { key: `payment-events-revoked-${randomUUID()}` },
        },
        new TestInboundProvider()
      );
      const frame = await socket.nextFrame();
      expect(frame?.opcode).toBe(8);
      expect(frame?.payload.readUInt16BE(0)).toBe(4401);
    } finally {
      socket.destroy();
      await server.stop();
    }
  });
});
