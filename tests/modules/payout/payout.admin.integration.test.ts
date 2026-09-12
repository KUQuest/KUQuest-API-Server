import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { createStagingTestAuthRoute } from '@/modules/auth';
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
import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';

const adminEmail = `payout-admin-route-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
const encryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'p'.repeat(32) },
});
let adminCookie = '';
const memberEmail = `payout-admin-member-${crypto.randomUUID()}@ku.th`;
const memberPassword = 'TestStudent1!';
const memberAuthApp = new Elysia({ name: 'payout-admin-member-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: memberEmail,
    password: memberPassword,
    firstName: 'Payout',
    lastName: 'Member',
  }),
);
let memberCookie = '';

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
  const memberLogin = await memberAuthApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: memberPassword }),
    }),
  );
  if (memberLogin.status !== 200) throw new Error(`Member authentication failed: ${memberLogin.status}`);
  memberCookie = getCookieHeader(memberLogin);
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
        'if-match': '1',
      },
      body: JSON.stringify({ reasonCode: 'PAYOUT_POLICY_REVIEW' }),
    }));

    expect(list.status).toBe(401);
    expect(approval.status).toBe(401);
  });

  it('keeps Member and Admin Payout sessions separate', async () => {
    const memberOnAdmin = await app.handle(new Request('http://localhost/api/v1/admin/payouts', {
      headers: { cookie: memberCookie },
    }));
    const adminOnMember = await app.handle(new Request('http://localhost/api/v1/payouts', {
      headers: { cookie: adminCookie },
    }));

    expect(memberOnAdmin.status).toBe(403);
    expect(adminOnMember.status).toBe(401);
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
    expect(document.paths['/api/v1/admin/payouts/{payoutId}/cancel']?.post?.operationId).toBe('cancelPayout');
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
          'if-match': String(firstPayout.version),
        },
        body: JSON.stringify({ reasonCode: 'PAYOUT_POLICY_REVIEW' }),
      },
    ));
    expect(approvalResponse.status).toBe(200);
    expect((await approvalResponse.json()).data).toMatchObject({
      resourceSummary: {
        id: firstPayout.id,
        payoutStatus: 'SUBMITTED_TO_PROVIDER',
        version: 2,
      },
      resourceVersion: 2,
      adminActionId: expect.any(String),
    });

    const historicalResponse = await app.handle(new Request(
      'http://localhost/api/v1/admin/payouts?status=SUBMITTED_TO_PROVIDER&limit=50',
      { headers: { cookie: adminCookie } },
    ));
    expect(historicalResponse.status).toBe(200);
    expect((await historicalResponse.json()).data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstPayout.id, payoutStatus: 'SUBMITTED_TO_PROVIDER', version: 2 })]),
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
      expect.objectContaining({ source: 'ADMIN_APPROVAL', reason: 'PAYOUT_POLICY_REVIEW' }),
    ]));
    expect(detail.data).toMatchObject({
      maskedDestinationValue: '****7890',
      maskedRoutingValue: '****7890',
    });
    expect(JSON.stringify(detail)).not.toContain('1234567890');
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

  it('serves the authenticated Admin cancellation contract', async () => {
    const payout = await createPendingPayout();
    const idempotencyKey = `payout-admin-route-cancellation-${crypto.randomUUID()}`;
    const request = () => app.handle(new Request(
      `http://localhost/api/v1/admin/payouts/${payout.id}/cancel`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'if-match': String(payout.version),
        },
        body: JSON.stringify({ reasonCode: 'PAYOUT_INVALID_DESTINATION' }),
      },
    ));

    const first = await request();
    const firstBody = await first.json();
    const replay = await request();
    const replayBody = await replay.json();

    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      resourceSummary: {
        id: payout.id,
        payoutStatus: 'CANCELLED',
        cancellationReasonCode: 'PAYOUT_INVALID_DESTINATION',
        version: 2,
      },
      resourceVersion: 2,
      adminActionId: expect.any(String),
    });
    expect(replay.status).toBe(200);
    expect(replayBody).toEqual(firstBody);
  });

  it('rejects a stale Payout version without changing the Payout or writing an Admin Action', async () => {
    const payout = await createPendingPayout();
    const idempotencyKey = `payout-admin-route-stale-${crypto.randomUUID()}`;
    const response = await app.handle(new Request(
      `http://localhost/api/v1/admin/payouts/${payout.id}/approve`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'if-match': String(payout.version + 1),
        },
        body: JSON.stringify({ reasonCode: 'PAYOUT_POLICY_REVIEW' }),
      },
    ));
    const body = await response.json();
    const [storedPayout] = await db
      .select({ payoutStatus: paymentPayouts.payoutStatus, version: paymentPayouts.version })
      .from(paymentPayouts)
      .where(eq(paymentPayouts.id, payout.id));
    const actions = await db
      .select({ id: adminAction.id })
      .from(adminAction)
      .where(eq(adminAction.requestKey, idempotencyKey));

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('ADMIN_ACTION_CONFLICT');
    expect(storedPayout).toEqual({ payoutStatus: 'PENDING_ADMIN_APPROVAL', version: payout.version });
    expect(actions).toHaveLength(0);
  });

  it('rejects invalid queue bounds and cursors', async () => {
    const invalidLimit = await app.handle(new Request(
      'http://localhost/api/v1/admin/payouts?limit=51',
      { headers: { cookie: adminCookie } },
    ));
    const invalidCursor = await app.handle(new Request(
      'http://localhost/api/v1/admin/payouts?cursor=not-a-cursor',
      { headers: { cookie: adminCookie } },
    ));

    expect(invalidLimit.status).toBe(400);
    expect(invalidCursor.status).toBe(400);
  });
});
