import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import {
  createPayoutDestinationEncryption,
  savePayoutDestination,
} from '@/modules/payout-destination';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  signedSatang,
} from '@/modules/wallet';
import { initiatePayout, quotePayout } from '@/modules/payout';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

const adminEmail = `payout-admin-route-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
const encryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'p'.repeat(32) },
});
let adminCookie = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const creditEarnings = async (studentId: string, amountSatang: number) => {
  const accounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, studentId));
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  const earnings = accounts.find((account) => account.type === 'EARNINGS');
  if (!earnings || !suspense) throw new Error('Wallet accounts were not provisioned.');
  await createSealedLedgerTransaction({
    businessReference: `test-payout-admin-route-credit:${crypto.randomUUID()}`,
    eventType: 'ADJUSTMENT',
    postings: [
      { accountId: earnings.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const createPendingPayout = async () => {
  const studentId = crypto.randomUUID();
  await db.insert(authUser).values({
    id: studentId,
    email: `${studentId}@ku.th`,
    firstName: 'Route',
    lastName: 'Student',
  });
  await ensureWallet(studentId);
  await savePayoutDestination({
    principalUserId: studentId,
    givenName: 'Route',
    surname: 'Student',
    relationship: 'SELF',
    bankCode: 'SCB',
    accountNumber: '1234567890',
    accountHolderName: 'Route Student',
    routingType: 'BANK_ACCOUNT',
    routingValue: '1234567890',
  }, encryption);
  await creditEarnings(studentId, 10_000);
  const quote = await quotePayout({
    principalUserId: studentId,
    receiptSatang: positiveSatang(1_234),
  });
  return initiatePayout({
    principalUserId: studentId,
    quoteId: quote.id,
    idempotency: { key: `payout-admin-route-submit-${crypto.randomUUID()}` },
  });
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
  const seedAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Route Admin',
      firstName: 'Route',
      lastName: 'Admin',
    },
  });
  const loginResponse = await app.handle(new Request('http://localhost/api/admin/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  }));
  if (loginResponse.status !== 200) throw new Error('Admin test session could not be created.');
  adminCookie = getCookieHeader(loginResponse);
});

describe('Payout API routes', () => {
  it('requires Member authentication for Student Payout endpoints', async () => {
    const quote = await app.handle(new Request('http://localhost/api/v1/payouts/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptSatang: 100 }),
    }));
    const list = await app.handle(new Request('http://localhost/api/v1/payouts'));

    expect(quote.status).toBe(401);
    expect(list.status).toBe(401);
  });

  it('requires Admin authentication for Admin Payout endpoints', async () => {
    const list = await app.handle(new Request('http://localhost/api/v1/admin/payouts'));
    const approval = await app.handle(new Request('http://localhost/api/v1/admin/payouts/018f47a7-1c7d-7c98-9a11-690d7e83430c/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'admin-auth-check',
      },
      body: JSON.stringify({}),
    }));

    expect(list.status).toBe(401);
    expect(approval.status).toBe(401);
  });

  it('publishes Student and Admin Payout contracts in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/payouts']?.post?.operationId).toBe('createPayout');
    expect(document.paths['/api/v1/payouts']?.get?.operationId).toBe('listPayouts');
    expect(document.paths['/api/v1/admin/payouts']?.get?.operationId).toBe('listAdminPayouts');
    expect(document.paths['/api/v1/admin/payouts/{payoutId}/approve']?.post?.operationId).toBe('approvePayout');
    expect(document.paths['/api/v1/admin/payouts/{payoutId}/reject']?.post?.operationId).toBe('rejectPayout');
  });

  it('serves the authenticated Admin queue, cursor, detail, and history contracts', async () => {
    const firstPayout = await createPendingPayout();
    const secondPayout = await createPendingPayout();

    const firstPageResponse = await app.handle(new Request(
      'http://localhost/api/v1/admin/payouts?limit=1&sort=newest',
      { headers: { cookie: adminCookie } },
    ));
    const firstPage = await firstPageResponse.json() as {
      success: boolean;
      data: { items: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(firstPageResponse.status).toBe(200);
    expect(firstPage.success).toBe(true);
    expect(firstPage.data.items).toHaveLength(1);
    expect(firstPage.data.nextCursor).toBeString();

    const secondPageResponse = await app.handle(new Request(
      `http://localhost/api/v1/admin/payouts?limit=1&sort=newest&cursor=${encodeURIComponent(firstPage.data.nextCursor!)}`,
      { headers: { cookie: adminCookie } },
    ));
    const secondPage = await secondPageResponse.json() as {
      data: { items: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(secondPageResponse.status).toBe(200);
    expect(secondPage.data.items).toHaveLength(1);
    expect(new Set([firstPayout.id, secondPayout.id])).toEqual(
      new Set([firstPage.data.items[0]?.id, secondPage.data.items[0]?.id]),
    );

    const approvalResponse = await app.handle(new Request(
      `http://localhost/api/v1/admin/payouts/${firstPayout.id}/approve`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': `payout-admin-route-approval-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ note: 'Approved by the route test.' }),
      },
    ));
    expect(approvalResponse.status).toBe(200);
    expect((await approvalResponse.json()).data.payoutStatus).toBe('CREATING');

    const historicalResponse = await app.handle(new Request(
      'http://localhost/api/v1/admin/payouts?status=CREATING&limit=50',
      { headers: { cookie: adminCookie } },
    ));
    expect(historicalResponse.status).toBe(200);
    expect((await historicalResponse.json()).data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstPayout.id, payoutStatus: 'CREATING' })]),
    );

    const detailResponse = await app.handle(new Request(
      `http://localhost/api/v1/admin/payouts/${firstPayout.id}`,
      { headers: { cookie: adminCookie } },
    ));
    const detail = await detailResponse.json() as {
      data: { history: Array<{ source: string; reason: string | null }>; [key: string]: unknown };
    };
    expect(detailResponse.status).toBe(200);
    expect(detail.data.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'ADMIN_APPROVAL', reason: 'Approved by the route test.' }),
    ]));
    expect(JSON.stringify(detail)).not.toContain('destinationAccountNumberCiphertext');
    expect(JSON.stringify(detail)).not.toContain('destinationRoutingValueCiphertext');

    const historyResponse = await app.handle(new Request(
      `http://localhost/api/v1/admin/payouts/${firstPayout.id}/status-history`,
      { headers: { cookie: adminCookie } },
    ));
    expect(historyResponse.status).toBe(200);
    expect((await historyResponse.json()).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'ADMIN_APPROVAL' }),
    ]));

    const missingHistoryResponse = await app.handle(new Request(
      `http://localhost/api/v1/admin/payouts/${crypto.randomUUID()}/status-history`,
      { headers: { cookie: adminCookie } },
    ));
    expect(missingHistoryResponse.status).toBe(404);
    expect((await missingHistoryResponse.json()).error.code).toBe('PAYOUT_NOT_FOUND');
  });

  it('serves the authenticated Admin rejection contract', async () => {
    const payout = await createPendingPayout();
    const idempotencyKey = `payout-admin-route-rejection-${crypto.randomUUID()}`;
    const request = () => app.handle(new Request(
      `http://localhost/api/v1/admin/payouts/${payout.id}/reject`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ reason: 'Rejected by the route test.' }),
      },
    ));

    const first = await request();
    const firstBody = await first.json();
    const replay = await request();
    const replayBody = await replay.json();

    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      id: payout.id,
      payoutStatus: 'CANCELLED',
      rejectionReason: 'Rejected by the route test.',
    });
    expect(replay.status).toBe(200);
    expect(replayBody).toEqual(firstBody);
  });
});
