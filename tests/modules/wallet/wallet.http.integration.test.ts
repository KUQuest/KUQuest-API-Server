import { app } from '@/app';
import { db } from '@/database/client';
import { walletLedgerAccount } from '@/database/schema/wallet.schema';
import {
  createSealedLedgerTransaction,
  ensureWallet,
  signedSatang,
} from '@/modules/wallet';

import { describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const signInTestMember = async (accountPath = 'account-1'): Promise<{ cookie: string; userId: string }> => {
  const loginResponse = await app.handle(
    new Request(`http://localhost/api/staging/test-auth/sign-in/${accountPath}`, {
      method: 'POST',
    }),
  );
  expect(loginResponse.status).toBe(200);
  const cookie = loginResponse.headers.getSetCookie()?.[0]?.split(';')[0];
  if (!cookie) throw new Error('Failed to extract session cookie from staging test auth login.');
  const body = (await loginResponse.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id };
};

describe('Wallet HTTP routes', () => {
  it('requires Member authentication for all Wallet endpoints', async () => {
    const unauthenticatedWallet = await app.handle(
      new Request('http://localhost/api/v1/wallet'),
    );
    const unauthenticatedConversion = await app.handle(
      new Request('http://localhost/api/v1/wallet/earnings-conversions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'auth-check',
        },
        body: JSON.stringify({ amountSatang: 100 }),
      }),
    );
    const unauthenticatedActivities = await app.handle(
      new Request('http://localhost/api/v1/wallet/activities'),
    );

    expect(unauthenticatedWallet.status).toBe(401);
    expect(unauthenticatedConversion.status).toBe(401);
    expect(unauthenticatedActivities.status).toBe(401);
  });

  it('publishes Wallet, Conversion, and Activities paths in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/wallet']?.get?.operationId).toBe('getOwnWallet');
    expect(document.paths['/api/v1/wallet/earnings-conversions']?.post?.operationId).toBe(
      'convertEarnings',
    );
    expect(document.paths['/api/v1/wallet/activities']?.get?.operationId).toBe(
      'listWalletActivities',
    );
  });

  it('reads own wallet compartments with integer Satang amounts', async () => {
    const { cookie } = await signInTestMember('account-1');

    const response = await app.handle(
      new Request('http://localhost/api/v1/wallet', {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        wallet: {
          spendingBalanceSatang: number;
          earningsBalanceSatang: number;
          fundingReservedSatang: number;
          reservedForPayoutsSatang: number;
        };
      };
    };

    expect(body.success).toBe(true);
    expect(typeof body.data.wallet.spendingBalanceSatang).toBe('number');
    expect(typeof body.data.wallet.earningsBalanceSatang).toBe('number');
    expect(typeof body.data.wallet.fundingReservedSatang).toBe('number');
    expect(typeof body.data.wallet.reservedForPayoutsSatang).toBe('number');
  });

  it('converts Earnings to Spending with idempotency, and records wallet activities', async () => {
    const { cookie, userId } = await signInTestMember('account-2');
    const wallet = await ensureWallet(userId);

    // Credit 10,000 satang to EARNINGS via sealed ledger transaction
    const [earningsAcc] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, 'EARNINGS')));
    const [suspenseAcc] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));

    if (!earningsAcc || !suspenseAcc) throw new Error('Missing ledger accounts for test');

    await createSealedLedgerTransaction({
      businessReference: `test:credit:http:${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT',
      description: 'Test earnings credit',
      postings: [
        { accountId: earningsAcc.id, amountSatang: signedSatang(10_000) },
        { accountId: suspenseAcc.id, amountSatang: signedSatang(-10_000) },
      ],
    });

    // Check activities endpoint lists the credit activity
    const activitiesResponse = await app.handle(
      new Request('http://localhost/api/v1/wallet/activities?limit=10', {
        headers: { cookie },
      }),
    );
    expect(activitiesResponse.status).toBe(200);
    const activitiesData = (await activitiesResponse.json()) as {
      success: boolean;
      data: {
        activities: Array<{
          id: string;
          type: string;
          earningsDeltaSatang: number;
          spendingDeltaSatang: number;
        }>;
      };
    };
    expect(activitiesData.success).toBe(true);
    expect(activitiesData.data.activities.length).toBeGreaterThanOrEqual(1);
    expect(activitiesData.data.activities[0]?.earningsDeltaSatang).toBe(10_000);

    // Convert 2,500 satang from Earnings to Spending
    const idempotencyKey = `http-conversion-key-${crypto.randomUUID()}`;
    const conversionResponse = await app.handle(
      new Request('http://localhost/api/v1/wallet/earnings-conversions', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ amountSatang: 2_500 }),
      }),
    );

    expect(conversionResponse.status).toBe(200);
    const conversionData = (await conversionResponse.json()) as {
      success: boolean;
      data: {
        id: string;
        principalUserId: string;
        amountSatang: number;
        businessReference: string;
        ledgerTransactionId: string;
        createdAt: string;
      };
    };
    expect(conversionData.success).toBe(true);
    expect(conversionData.data.amountSatang).toBe(2_500);
    expect(conversionData.data.principalUserId).toBe(userId);

    // Idempotent retry with same key returns identical conversion
    const replayResponse = await app.handle(
      new Request('http://localhost/api/v1/wallet/earnings-conversions', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ amountSatang: 2_500 }),
      }),
    );
    expect(replayResponse.status).toBe(200);
    const replayData = (await replayResponse.json()) as typeof conversionData;
    expect(replayData.data.id).toBe(conversionData.data.id);
    expect(replayData.data.ledgerTransactionId).toBe(conversionData.data.ledgerTransactionId);

    // Conflicting key reuse returns 409
    const conflictResponse = await app.handle(
      new Request('http://localhost/api/v1/wallet/earnings-conversions', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ amountSatang: 1_000 }),
      }),
    );
    expect(conflictResponse.status).toBe(409);
  });

  it('rejects invalid inputs on conversion and activities', async () => {
    const { cookie } = await signInTestMember('account-1');

    // Missing idempotency key
    const missingKey = await app.handle(
      new Request('http://localhost/api/v1/wallet/earnings-conversions', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ amountSatang: 100 }),
      }),
    );
    expect(missingKey.status).toBe(400);

    // Invalid amount satang (0 or negative)
    const zeroAmount = await app.handle(
      new Request('http://localhost/api/v1/wallet/earnings-conversions', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'idempotency-key': 'key-zero',
        },
        body: JSON.stringify({ amountSatang: 0 }),
      }),
    );
    expect(zeroAmount.status).toBe(400);

    // Invalid activities limit (>100)
    const invalidLimit = await app.handle(
      new Request('http://localhost/api/v1/wallet/activities?limit=101', {
        headers: { cookie },
      }),
    );
    expect(invalidLimit.status).toBe(400);
  });
});
