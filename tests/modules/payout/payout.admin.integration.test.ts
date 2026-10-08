import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { paymentPayoutStatusHistory, paymentPayouts } from '@/database/schema/payment.schema';
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
import { encodeCursor } from '@/shared/cursor';

import { beforeAll, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { and, eq, gt, inArray } from 'drizzle-orm';

import { createStagingTestAuthRoute } from '../../fixtures/seeded-test-auth';

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
  })
);
let memberCookie = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const creditEarnings = async (memberId: string, amountSatang: number) => {
  const accounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, memberId));
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

const createPayoutForMember = async (memberId: string) => {
  await creditEarnings(memberId, 10_000);
  const quote = await quotePayout({
    principalUserId: memberId,
    receiptSatang: positiveSatang(1_234),
  });
  return initiatePayout({
    principalUserId: memberId,
    quoteId: quote.id,
    idempotency: { key: `payout-admin-route-submit-${crypto.randomUUID()}` },
  });
};

const createPendingPayout = async () => {
  const memberId = crypto.randomUUID();
  await db.insert(authUser).values({
    id: memberId,
    email: `${memberId}@ku.th`,
    firstName: 'Route',
    lastName: 'Student',
    studentId: String(1_000_000_000 + Math.floor(Math.random() * 9_000_000_000)),
  });
  await ensureWallet(memberId);
  await savePayoutDestination(
    {
      principalUserId: memberId,
      givenName: 'Route',
      surname: 'Student',
      relationship: 'SELF',
      bankCode: 'SCB',
      accountNumber: '1234567890',
      accountHolderName: 'Route Student',
      routingType: 'BANK_ACCOUNT',
      routingValue: '1234567890',
    },
    encryption
  );
  return createPayoutForMember(memberId);
};

const adminPayoutDecisionRequest = (
  payoutId: string,
  action: 'approve' | 'cancel',
  version: number,
  reasonCode: string,
  idempotencyKey: string
) =>
  app.handle(
    new Request(`http://localhost/api/v1/admin/payouts/${payoutId}/${action}`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'if-match': String(version),
      },
      body: JSON.stringify({ reasonCode }),
    })
  );

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
  // This file seeds future-dated Payouts; heal any row an interrupted run
  // left at the head of the shared Admin queue before the queue tests run.
  await db
    .update(paymentPayouts)
    .set({ createdAt: new Date() })
    .where(
      and(
        gt(paymentPayouts.createdAt, new Date('2030-01-01T00:00:00Z')),
        eq(paymentPayouts.payoutStatus, 'PENDING_ADMIN_APPROVAL')
      )
    );
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
  const loginResponse = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (loginResponse.status !== 200) throw new Error('Admin test session could not be created.');
  adminCookie = getCookieHeader(loginResponse);
  const memberLogin = await memberAuthApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: memberPassword }),
    })
  );
  if (memberLogin.status !== 200)
    throw new Error(`Member authentication failed: ${memberLogin.status}`);
  memberCookie = getCookieHeader(memberLogin);
});

describe('Payout API routes', () => {
  it('requires Member authentication for Student Payout endpoints', async () => {
    const quote = await app.handle(
      new Request('http://localhost/api/v1/payouts/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ receiptSatang: 100 }),
      })
    );
    const list = await app.handle(new Request('http://localhost/api/v1/payouts'));

    expect(quote.status).toBe(401);
    expect(list.status).toBe(401);
  });

  it('requires Admin authentication for Admin Payout endpoints', async () => {
    const list = await app.handle(new Request('http://localhost/api/v1/admin/payouts'));
    const approval = await app.handle(
      new Request(
        'http://localhost/api/v1/admin/payouts/018f47a7-1c7d-7c98-9a11-690d7e83430c/approve',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'admin-auth-check',
            'if-match': '1',
          },
          body: JSON.stringify({ reasonCode: 'PAYOUT_DESTINATION_VERIFIED' }),
        }
      )
    );

    expect(list.status).toBe(401);
    expect(approval.status).toBe(401);
  });

  it('keeps Member and Admin Payout sessions separate', async () => {
    const memberOnAdmin = await app.handle(
      new Request('http://localhost/api/v1/admin/payouts', {
        headers: { cookie: memberCookie },
      })
    );
    const adminOnMember = await app.handle(
      new Request('http://localhost/api/v1/payouts', {
        headers: { cookie: adminCookie },
      })
    );

    expect(memberOnAdmin.status).toBe(403);
    expect(adminOnMember.status).toBe(401);
  });

  it('publishes Student and Admin Payout contracts in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            security?: unknown;
            description?: string;
            requestBody?: { content?: Record<string, { schema?: unknown }> };
          }
        >
      >;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/payouts']?.post?.operationId).toBe('createPayout');
    expect(document.paths['/api/v1/payouts']?.get?.operationId).toBe('listPayouts');
    expect(document.paths['/api/v1/admin/payouts']?.get?.operationId).toBe('listAdminPayouts');
    expect(document.paths['/api/v1/admin/payouts/{payoutId}/approve']?.post?.operationId).toBe(
      'approvePayout'
    );
    expect(document.paths['/api/v1/admin/payouts/{payoutId}/cancel']?.post?.operationId).toBe(
      'cancelPayout'
    );

    const approveOperation = document.paths['/api/v1/admin/payouts/{payoutId}/approve']?.post;
    const cancelOperation = document.paths['/api/v1/admin/payouts/{payoutId}/cancel']?.post;
    expect(approveOperation?.description).toContain('Payout reason catalog version 2');
    expect(approveOperation?.description).toContain('PAYOUT_RISK_REVIEW_CLEARED');
    expect(cancelOperation?.description).toContain('Payout reason catalog version 2');
    expect(cancelOperation?.description).toContain('PAYOUT_REQUIRED_INFORMATION_MISSING');
    const approvalSchemaText = JSON.stringify(
      approveOperation?.requestBody?.content?.['application/json']?.schema
    );
    const cancellationSchemaText = JSON.stringify(
      cancelOperation?.requestBody?.content?.['application/json']?.schema
    );
    expect(approveOperation?.description).toContain('decisionReasonText');
    expect(cancelOperation?.description).toContain('decisionReasonText');
    expect(approvalSchemaText).toContain('decisionReasonText');
    expect(cancellationSchemaText).toContain('decisionReasonText');
    expect(approvalSchemaText).toContain('PAYOUT_DESTINATION_VERIFIED');
    expect(approvalSchemaText).not.toContain('PAYOUT_POLICY_REVIEW');
    expect(cancellationSchemaText).toContain('PAYOUT_REQUIRED_INFORMATION_MISSING');
    expect(cancellationSchemaText).not.toContain('PAYOUT_POLICY_REVIEW');
    expect(approvalSchemaText).toContain('"maxLength":200');
    expect(cancellationSchemaText).toContain('"maxLength":200');
    const payoutList = document.paths['/api/v1/admin/payouts']?.get;
    expect(payoutList?.description).toContain('status=ALL');
    expect(JSON.stringify(document)).toContain('"ALL"');
    expect(JSON.stringify(document)).toContain('totalCount');
    const approval = document.paths['/api/v1/admin/payouts/{payoutId}/approve']?.post;
    const cancellation = document.paths['/api/v1/admin/payouts/{payoutId}/cancel']?.post;
    expect(approval?.description).toContain('decisionReasonText');
    expect(cancellation?.description).toContain('decisionReasonText');
    expect(JSON.stringify(approval?.requestBody)).toContain('decisionReasonText');
    expect(JSON.stringify(cancellation?.requestBody)).toContain('decisionReasonText');
    expect(JSON.stringify(approval?.requestBody)).toContain('"maxLength":200');
    expect(JSON.stringify(cancellation?.requestBody)).toContain('"maxLength":200');
  });

  it('serves the authenticated Admin queue, cursor, detail, and history contracts', async () => {
    const firstPayout = await createPendingPayout();
    const secondPayout = await createPendingPayout();

    const firstPageResponse = await app.handle(
      new Request('http://localhost/api/v1/admin/payouts?limit=1&sort=newest', {
        headers: { cookie: adminCookie },
      })
    );
    const firstPage = (await firstPageResponse.json()) as {
      success: boolean;
      data: { items: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(firstPageResponse.status).toBe(200);
    expect(firstPage.success).toBe(true);
    expect(firstPage.data.items).toHaveLength(1);
    expect(firstPage.data.nextCursor).toBeString();

    const secondPageResponse = await app.handle(
      new Request(
        `http://localhost/api/v1/admin/payouts?limit=1&sort=newest&cursor=${encodeURIComponent(firstPage.data.nextCursor!)}`,
        { headers: { cookie: adminCookie } }
      )
    );
    const secondPage = (await secondPageResponse.json()) as {
      data: { items: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(secondPageResponse.status).toBe(200);
    expect(secondPage.data.items).toHaveLength(1);
    expect(new Set([firstPayout.id, secondPayout.id])).toEqual(
      new Set([firstPage.data.items[0]?.id, secondPage.data.items[0]?.id])
    );

    const memberPageResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts?userId=${firstPayout.principalUserId}`, {
        headers: { cookie: adminCookie },
      })
    );
    const memberPage = (await memberPageResponse.json()) as {
      success: boolean;
      data: {
        items: Array<{
          id: string;
          displayId: string;
          student: { id: string; studentId: string | null };
        }>;
      };
    };
    expect(memberPageResponse.status).toBe(200);
    expect(memberPage.success).toBe(true);
    expect(memberPage.data.items.map((item) => item.id)).toEqual([firstPayout.id]);
    expect(memberPage.data.items[0]?.displayId).toMatch(/^PAY-\d{6,}$/);
    expect(memberPage.data.items[0]?.id).toBe(firstPayout.id);
    expect(memberPage.data.items[0]?.displayId).not.toBe(firstPayout.id);
    expect(memberPage.data.items[0]?.student).toMatchObject({
      id: firstPayout.principalUserId,
      studentId: expect.stringMatching(/^\d{10}$/),
    });

    const approvalResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${firstPayout.id}/approve`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': `payout-admin-route-approval-${crypto.randomUUID()}`,
          'if-match': String(firstPayout.version),
        },
        body: JSON.stringify({ reasonCode: 'PAYOUT_DESTINATION_VERIFIED' }),
      })
    );
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

    const historicalResponse = await app.handle(
      new Request('http://localhost/api/v1/admin/payouts?status=SUBMITTED_TO_PROVIDER&limit=50', {
        headers: { cookie: adminCookie },
      })
    );
    expect(historicalResponse.status).toBe(200);
    expect((await historicalResponse.json()).data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstPayout.id,
          payoutStatus: 'SUBMITTED_TO_PROVIDER',
          version: 2,
        }),
      ])
    );

    const detailResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${firstPayout.id}`, {
        headers: { cookie: adminCookie },
      })
    );
    const detail = (await detailResponse.json()) as {
      data: {
        displayId: string;
        student: { id: string; studentId: string | null };
        history: Array<{
          source: string;
          reason: string | null;
          reasonCode: string | null;
          decisionReasonText: string | null;
          admin: { firstName: string; lastName: string } | null;
        }>;
        [key: string]: unknown;
      };
    };
    expect(detailResponse.status).toBe(200);
    expect(detail.data.displayId).toBe(memberPage.data.items[0]?.displayId);
    expect(detail.data.student).toMatchObject({
      id: firstPayout.principalUserId,
      studentId: expect.stringMatching(/^\d{10}$/),
    });
    expect(detail.data.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'ADMIN_APPROVAL',
          reason: 'PAYOUT_DESTINATION_VERIFIED',
          reasonCode: 'PAYOUT_DESTINATION_VERIFIED',
          decisionReasonText: null,
          admin: { firstName: 'Route', lastName: 'Admin' },
        }),
      ])
    );
    expect(detail.data).toMatchObject({
      maskedDestinationValue: '****7890',
      maskedRoutingValue: '****7890',
    });
    expect(JSON.stringify(detail)).not.toContain('1234567890');
    expect(JSON.stringify(detail)).not.toContain('destinationAccountNumberCiphertext');
    expect(JSON.stringify(detail)).not.toContain('destinationRoutingValueCiphertext');

    const historyResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${firstPayout.id}/status-history`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(historyResponse.status).toBe(200);
    expect((await historyResponse.json()).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'ADMIN_APPROVAL' })])
    );

    const missingHistoryResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${crypto.randomUUID()}/status-history`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(missingHistoryResponse.status).toBe(404);
    expect((await missingHistoryResponse.json()).error.code).toBe('PAYOUT_NOT_FOUND');
  });

  it('searches by Payout display ID without returning destination data', async () => {
    const payout = await createPendingPayout();
    const detailResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${payout.id}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(detailResponse.status).toBe(200);
    const displayId = (await detailResponse.json()).data.displayId as string;

    const searchResponse = await app.handle(
      new Request(
        `http://localhost/api/v1/admin/search?q=${encodeURIComponent(displayId)}&kind=payout`,
        { headers: { cookie: adminCookie } }
      )
    );
    expect(searchResponse.status).toBe(200);
    const searchBody = await searchResponse.json();
    expect(searchBody.data.items).toHaveLength(1);
    const item = searchBody.data.items[0];
    expect(item).toMatchObject({
      kind: 'payout',
      id: payout.id,
      resourceId: payout.id,
      displayId,
      title: 'Payout for Route Student',
      status: 'PENDING_ADMIN_APPROVAL',
    });
    expect(Object.keys(item).sort()).toEqual([
      'displayId',
      'id',
      'kind',
      'newestAt',
      'resourceId',
      'status',
      'title',
    ]);
    expect(JSON.stringify(item)).not.toContain('1234567890');
    expect(JSON.stringify(item)).not.toContain('destinationAccountNumberCiphertext');
    expect(JSON.stringify(item)).not.toContain('destinationRoutingValueCiphertext');
  });

  it('serves the authenticated Admin cancellation contract', async () => {
    const payout = await createPendingPayout();
    const idempotencyKey = `payout-admin-route-cancellation-${crypto.randomUUID()}`;
    const request = () =>
      app.handle(
        new Request(`http://localhost/api/v1/admin/payouts/${payout.id}/cancel`, {
          method: 'POST',
          headers: {
            cookie: adminCookie,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
            'if-match': String(payout.version),
          },
          body: JSON.stringify({ reasonCode: 'PAYOUT_INVALID_DESTINATION' }),
        })
      );

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

  it('stores optional Admin notes for Payout approval and cancellation', async () => {
    const approvedPayout = await createPendingPayout();
    const cancelledPayout = await createPendingPayout();
    const approvalNote = 'x'.repeat(200);
    const cancellationNote = 'The Payout Destination could not be verified.';

    const approveResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${approvedPayout.id}/approve`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': `payout-admin-note-approve-${approvedPayout.id}`,
          'if-match': String(approvedPayout.version),
        },
        body: JSON.stringify({
          reasonCode: 'PAYOUT_DESTINATION_VERIFIED',
          decisionReasonText: approvalNote,
        }),
      })
    );
    const cancelResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${cancelledPayout.id}/cancel`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': `payout-admin-note-cancel-${cancelledPayout.id}`,
          'if-match': String(cancelledPayout.version),
        },
        body: JSON.stringify({
          reasonCode: 'PAYOUT_INVALID_DESTINATION',
          decisionReasonText: cancellationNote,
        }),
      })
    );
    const approveBody = await approveResponse.json();
    const cancelBody = await cancelResponse.json();

    expect(approveResponse.status).toBe(200);
    expect(cancelResponse.status).toBe(200);
    expect(approveBody.data.resourceSummary).not.toHaveProperty('decisionReasonText');
    expect(cancelBody.data.resourceSummary).not.toHaveProperty('decisionReasonText');

    const approveActivity = await app.handle(
      new Request(
        `http://localhost/api/v1/admin/activity-log?resourceType=payout&resourceId=${approvedPayout.id}`,
        { headers: { cookie: adminCookie } }
      )
    );
    const cancelActivity = await app.handle(
      new Request(
        `http://localhost/api/v1/admin/activity-log?resourceType=payout&resourceId=${cancelledPayout.id}`,
        { headers: { cookie: adminCookie } }
      )
    );
    expect(approveActivity.status).toBe(200);
    expect(cancelActivity.status).toBe(200);
    expect((await approveActivity.json()).data.items).toContainEqual(
      expect.objectContaining({
        action: 'PAYOUT_APPROVE',
        reasonCode: 'PAYOUT_DESTINATION_VERIFIED',
        decisionReasonText: approvalNote,
      })
    );
    expect((await cancelActivity.json()).data.items).toContainEqual(
      expect.objectContaining({
        action: 'PAYOUT_CANCEL',
        reasonCode: 'PAYOUT_INVALID_DESTINATION',
        decisionReasonText: cancellationNote,
      })
    );

    const approvedDetail = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${approvedPayout.id}`, {
        headers: { cookie: adminCookie },
      })
    );
    const cancelledDetail = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${cancelledPayout.id}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(approvedDetail.status).toBe(200);
    expect(cancelledDetail.status).toBe(200);
    expect((await approvedDetail.json()).data.history).toContainEqual(
      expect.objectContaining({
        reasonCode: 'PAYOUT_DESTINATION_VERIFIED',
        decisionReasonText: approvalNote,
        admin: { firstName: 'Route', lastName: 'Admin' },
      })
    );
    expect((await cancelledDetail.json()).data.history).toContainEqual(
      expect.objectContaining({
        reasonCode: 'PAYOUT_INVALID_DESTINATION',
        decisionReasonText: cancellationNote,
        admin: { firstName: 'Route', lastName: 'Admin' },
      })
    );
  });

  it('rejects blank and over-200-character Admin decision notes', async () => {
    const rejectNote = async (
      operation: 'approve' | 'cancel',
      reasonCode: string,
      decisionReasonText: string
    ) => {
      const payout = await createPendingPayout();
      const requestKey = `payout-admin-invalid-note-${payout.id}`;
      const response = await app.handle(
        new Request(`http://localhost/api/v1/admin/payouts/${payout.id}/${operation}`, {
          method: 'POST',
          headers: {
            cookie: adminCookie,
            'content-type': 'application/json',
            'idempotency-key': requestKey,
            'if-match': String(payout.version),
          },
          body: JSON.stringify({ reasonCode, decisionReasonText }),
        })
      );
      const body = await response.json();
      const [storedPayout] = await db
        .select({ payoutStatus: paymentPayouts.payoutStatus, version: paymentPayouts.version })
        .from(paymentPayouts)
        .where(eq(paymentPayouts.id, payout.id));
      const actions = await db
        .select({ id: adminAction.id })
        .from(adminAction)
        .where(eq(adminAction.requestKey, requestKey));

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION');
      expect(storedPayout).toEqual({ payoutStatus: 'PENDING_ADMIN_APPROVAL', version: 1 });
      expect(actions).toHaveLength(0);
    };

    await rejectNote('approve', 'PAYOUT_DESTINATION_VERIFIED', '   ');
    await rejectNote('cancel', 'PAYOUT_INVALID_DESTINATION', 'x'.repeat(201));
  });

  const decisionReasonCases = [
    ['approve', 'PAYOUT_DESTINATION_VERIFIED', 'PAYOUT_APPROVE'],
    ['approve', 'PAYOUT_ACCOUNT_OWNER_MATCHED', 'PAYOUT_APPROVE'],
    ['approve', 'PAYOUT_POLICY_CHECK_PASSED', 'PAYOUT_APPROVE'],
    ['approve', 'PAYOUT_RISK_REVIEW_CLEARED', 'PAYOUT_APPROVE'],
    ['cancel', 'PAYOUT_INVALID_DESTINATION', 'PAYOUT_CANCEL'],
    ['cancel', 'PAYOUT_ACCOUNT_OWNER_MISMATCH', 'PAYOUT_CANCEL'],
    ['cancel', 'PAYOUT_POLICY_CHECK_FAILED', 'PAYOUT_CANCEL'],
    ['cancel', 'PAYOUT_RISK_REVIEW_FAILED', 'PAYOUT_CANCEL'],
    ['cancel', 'PAYOUT_REQUIRED_INFORMATION_MISSING', 'PAYOUT_CANCEL'],
  ] as const;

  const expectReasonCodeRejected = async (
    action: 'approve' | 'cancel',
    reasonCode: string,
    idempotencyKeyPrefix: string
  ) => {
    const payout = await createPendingPayout();
    const idempotencyKey = `${idempotencyKeyPrefix}-${crypto.randomUUID()}`;
    const response = await adminPayoutDecisionRequest(
      payout.id,
      action,
      payout.version,
      reasonCode,
      idempotencyKey
    );
    const body = await response.json();
    const actions = await db
      .select({ id: adminAction.id })
      .from(adminAction)
      .where(eq(adminAction.requestKey, idempotencyKey));

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION');
    expect(actions).toHaveLength(0);
  };

  for (const [action, reasonCode, expectedAction] of decisionReasonCases) {
    it(`records ${reasonCode} in Payout Admin Action catalog version 2`, async () => {
      const payout = await createPendingPayout();
      const response = await adminPayoutDecisionRequest(
        payout.id,
        action,
        payout.version,
        reasonCode,
        `payout-catalog-v2-${crypto.randomUUID()}`
      );
      expect(response.status).toBe(200);
      if (response.status !== 200) return;
      const body = (await response.json()) as { data: { adminActionId: string } };
      const [record] = await db
        .select({
          action: adminAction.action,
          reasonCatalogVersion: adminAction.reasonCatalogVersion,
          reasonCode: adminAction.reasonCode,
        })
        .from(adminAction)
        .where(eq(adminAction.id, body.data.adminActionId));

      expect(record).toEqual({
        action: expectedAction,
        reasonCatalogVersion: 2,
        reasonCode,
      });
    });
  }

  for (const [action, reasonCode] of decisionReasonCases) {
    const mismatchedAction = action === 'approve' ? 'cancel' : 'approve';
    it(`rejects ${reasonCode} for Payout ${mismatchedAction}`, async () => {
      await expectReasonCodeRejected(mismatchedAction, reasonCode, 'payout-wrong-action');
    });
  }

  for (const action of ['approve', 'cancel'] as const) {
    for (const reasonCode of ['PAYOUT_POLICY_REVIEW', 'PAYOUT_RISK_REVIEW'] as const) {
      it(`rejects version-1 ${reasonCode} for Payout ${action}`, async () => {
        await expectReasonCodeRejected(action, reasonCode, 'payout-catalog-v1');
      });
    }
  }

  it('keeps version-1 Payout Admin Actions readable in the Activity Log', async () => {
    const payout = await createPendingPayout();
    const [admin] = await db
      .select({ id: authAdmin.id })
      .from(authAdmin)
      .where(eq(authAdmin.email, adminEmail));
    if (!admin) throw new Error('Admin account was not provisioned.');

    await db.insert(adminAction).values({
      adminId: admin.id,
      action: 'PAYOUT_APPROVE',
      resourceType: 'payout',
      resourceId: payout.id,
      requestKey: `payout-catalog-v1-history-${crypto.randomUUID()}`,
      requestHash: 'a'.repeat(64),
      reasonCatalogVersion: 1,
      reasonCode: 'PAYOUT_POLICY_REVIEW',
      expectedVersion: payout.version,
      resultVersion: payout.version + 1,
      metadata: {},
      resultData: {},
    });

    const response = await app.handle(
      new Request(
        `http://localhost/api/v1/admin/activity-log?resourceType=payout&resourceId=${payout.id}`,
        { headers: { cookie: adminCookie } }
      )
    );
    const body = (await response.json()) as {
      data: {
        items: Array<{ action: string; reasonCatalogVersion: number; reasonCode: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.items).toContainEqual(
      expect.objectContaining({
        action: 'PAYOUT_APPROVE',
        reasonCatalogVersion: 1,
        reasonCode: 'PAYOUT_POLICY_REVIEW',
      })
    );
  });

  it('keeps version-1 reason codes readable in Payout status history', async () => {
    const payout = await createPendingPayout();
    await db.insert(paymentPayoutStatusHistory).values({
      payoutId: payout.id,
      fromStatus: 'PENDING_ADMIN_APPROVAL',
      toStatus: 'CANCELLED',
      source: 'ADMIN_CANCELLATION',
      reason: 'PAYOUT_POLICY_REVIEW',
    });

    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${payout.id}/status-history`, {
        headers: { cookie: adminCookie },
      })
    );
    const body = (await response.json()) as {
      data: Array<{ source: string; reason: string | null }>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toContainEqual(
      expect.objectContaining({ source: 'ADMIN_CANCELLATION', reason: 'PAYOUT_POLICY_REVIEW' })
    );
  });

  it('rejects a stale Payout version without changing the Payout or writing an Admin Action', async () => {
    const payout = await createPendingPayout();
    const idempotencyKey = `payout-admin-route-stale-${crypto.randomUUID()}`;
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${payout.id}/approve`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'if-match': String(payout.version + 1),
        },
        body: JSON.stringify({ reasonCode: 'PAYOUT_DESTINATION_VERIFIED' }),
      })
    );
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
    expect(storedPayout).toEqual({
      payoutStatus: 'PENDING_ADMIN_APPROVAL',
      version: payout.version,
    });
    expect(actions).toHaveLength(0);
  });

  it('rejects invalid queue bounds and cursors', async () => {
    const invalidLimit = await app.handle(
      new Request('http://localhost/api/v1/admin/payouts?limit=51', {
        headers: { cookie: adminCookie },
      })
    );
    const invalidCursor = await app.handle(
      new Request('http://localhost/api/v1/admin/payouts?cursor=not-a-cursor', {
        headers: { cookie: adminCookie },
      })
    );

    expect(invalidLimit.status).toBe(400);
    expect(invalidCursor.status).toBe(400);
  });

  it('walks every pending Payout exactly once across microsecond boundaries', async () => {
    const seedCreatedAt = async (payoutId: string, createdAt: string) => {
      await sql`update payment_payouts set created_at = ${createdAt}::timestamptz where id = ${payoutId}`;
    };
    const first = await createPendingPayout();
    const tieFirst = await createPendingPayout();
    const tieSecond = await createPendingPayout();
    const last = await createPendingPayout();
    await seedCreatedAt(first.id, '2031-01-05T00:00:00.100200Z');
    await seedCreatedAt(tieFirst.id, '2031-01-05T00:00:00.101300Z');
    await seedCreatedAt(tieSecond.id, '2031-01-05T00:00:00.101300Z');
    await seedCreatedAt(last.id, '2031-01-05T00:00:00.102400Z');
    const seededIds = [first.id, tieFirst.id, tieSecond.id, last.id];
    const tieAscending = [tieFirst.id, tieSecond.id].sort((left, right) => (left < right ? -1 : 1));
    const clusterOldest = [first.id, ...tieAscending, last.id];
    const clusterNewest = [last.id, ...[...tieAscending].reverse(), first.id];
    type PayoutPage = { data: { items: Array<{ id: string }>; nextCursor: string | null } };

    // Pages must be requested sequentially: each cursor comes from the
    // previous response. The page cap only guards against the pre-fix
    // defect, where a millisecond-truncated cursor repeats its anchor row
    // forever; the walk must otherwise reach the end of the whole queue.
    const readEveryPage = async (sort: 'newest' | 'oldest'): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 1000; page += 1) {
        const params = new URLSearchParams({ limit: '1', sort });
        if (cursor) params.set('cursor', cursor);
        // eslint-disable-next-line no-await-in-loop
        const response = await app.handle(
          new Request(`http://localhost/api/v1/admin/payouts?${params}`, {
            headers: { cookie: adminCookie },
          })
        );
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = (await response.json()) as PayoutPage;
        ids.push(...body.data.items.map((item) => item.id));
        cursor = body.data.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      for (const id of seededIds) {
        expect(ids.filter((row) => row === id)).toHaveLength(1);
      }
      return ids;
    };

    try {
      // Other pending Payouts from the rest of the suite stay in the queue,
      // so the seeded cluster is asserted as an ordered, once-only
      // subsequence of the full walk.
      const newestIds = await readEveryPage('newest');
      expect(newestIds.filter((id) => seededIds.includes(id))).toEqual(clusterNewest);
      const oldestIds = await readEveryPage('oldest');
      expect(oldestIds.filter((id) => seededIds.includes(id))).toEqual(clusterOldest);
    } finally {
      // Hand the seeds back to the present so they cannot head the shared
      // queue for later tests or later runs.
      await db
        .update(paymentPayouts)
        .set({ createdAt: new Date() })
        .where(inArray(paymentPayouts.id, seededIds));
    }
  }, 60_000);

  it('lists complete filtered Member Payout history across all statuses', async () => {
    const failedPayout = await createPendingPayout();
    await db
      .update(paymentPayouts)
      .set({ payoutStatus: 'FAILED' })
      .where(eq(paymentPayouts.id, failedPayout.id));
    const cancelledPayout = await createPayoutForMember(failedPayout.principalUserId);
    const pendingPayout = await createPendingPayout();
    const submittedPayout = await createPendingPayout();
    const providerPendingPayout = await createPendingPayout();
    const succeededPayout = await createPendingPayout();
    const statusCases = [
      { payout: pendingPayout, status: 'PENDING_ADMIN_APPROVAL' },
      { payout: submittedPayout, status: 'SUBMITTED_TO_PROVIDER' },
      { payout: providerPendingPayout, status: 'PROVIDER_PENDING' },
      { payout: succeededPayout, status: 'SUCCEEDED' },
      { payout: failedPayout, status: 'FAILED' },
      { payout: cancelledPayout, status: 'CANCELLED' },
    ] as const;
    const timestamp = '2099-01-05T00:00:00.101300Z';
    await Promise.all(
      statusCases.map(
        ({ payout, status }) => sql`
          update payment_payouts
          set payout_status = ${status},
              created_at = ${timestamp}::timestamptz,
              updated_at = ${timestamp}::timestamptz
          where id = ${payout.id}
        `
      )
    );

    type PayoutListItem = {
      id: string;
      displayId: string;
      student: { id: string; displayId: string };
      payoutStatus: string;
      bankCode: string;
      bankName: string;
      destinationType: string;
      maskedDestinationValue: string;
      maskedRoutingValue: string;
      createdAt: string;
      updatedAt: string;
    };
    type PayoutListPage = {
      data: { items: PayoutListItem[]; nextCursor: string | null; totalCount: number };
    };
    const seededIds = statusCases.map(({ payout }) => payout.id);
    const ascendingSeedIds = [...seededIds].sort();

    const readLatestAllStatusPages = async () => {
      const items: PayoutListItem[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < statusCases.length; page += 1) {
        const params = new URLSearchParams({ status: 'ALL', limit: '1', sort: 'newest' });
        if (cursor) params.set('cursor', cursor);
        // eslint-disable-next-line no-await-in-loop
        const response = await app.handle(
          new Request(`http://localhost/api/v1/admin/payouts?${params}`, {
            headers: { cookie: adminCookie },
          })
        );
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = (await response.json()) as PayoutListPage;
        expect(body.data.totalCount).toBeGreaterThanOrEqual(statusCases.length);
        expect(body.data.items).toHaveLength(1);
        const item = body.data.items[0];
        if (!item) throw new Error('Payout history page did not contain its expected item.');
        expect(seededIds).toContain(item.id);
        expect(item).toMatchObject({
          displayId: expect.stringMatching(/^PAY-\d{6,}$/),
          student: { displayId: expect.stringMatching(/^MEM-\d{6,}$/) },
          bankCode: 'SCB',
          bankName: 'Siam Commercial Bank',
          destinationType: 'BANK_ACCOUNT',
          maskedDestinationValue: '****7890',
          maskedRoutingValue: '****7890',
          createdAt: '2099-01-05T00:00:00.101Z',
          updatedAt: '2099-01-05T00:00:00.101Z',
        });
        expect(JSON.stringify(body)).not.toContain('1234567890');
        expect(JSON.stringify(body)).not.toContain('destinationAccountNumberCiphertext');
        expect(JSON.stringify(body)).not.toContain('destinationRoutingValueCiphertext');
        items.push(item);
        cursor = body.data.nextCursor;
        if (page < statusCases.length - 1) expect(cursor).toBeString();
      }

      expect(items).toHaveLength(statusCases.length);
      expect(new Set(items.map((item) => item.id)).size).toBe(statusCases.length);
      expect(items.map((item) => item.id)).toEqual([...ascendingSeedIds].reverse());
      for (const { payout, status } of statusCases) {
        expect(items.find((item) => item.id === payout.id)?.payoutStatus).toBe(status);
      }
    };

    await readLatestAllStatusPages();

    const readMemberHistory = async (sort: 'newest' | 'oldest') => {
      const items: PayoutListItem[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 2; page += 1) {
        const params = new URLSearchParams({
          status: 'ALL',
          userId: failedPayout.principalUserId,
          limit: '1',
          sort,
        });
        if (cursor) params.set('cursor', cursor);
        // eslint-disable-next-line no-await-in-loop
        const response = await app.handle(
          new Request(`http://localhost/api/v1/admin/payouts?${params}`, {
            headers: { cookie: adminCookie },
          })
        );
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = (await response.json()) as PayoutListPage;
        expect(body.data.totalCount).toBe(2);
        expect(body.data.items).toHaveLength(1);
        expect(body.data.items[0]?.student).toMatchObject({
          id: failedPayout.principalUserId,
          displayId: expect.stringMatching(/^MEM-\d{6,}$/),
        });
        if (page === 0) expect(body.data.nextCursor).toBeString();
        else expect(body.data.nextCursor).toBeNull();
        items.push(...body.data.items);
        cursor = body.data.nextCursor;
        if (!cursor) break;
      }

      expect(cursor).toBeNull();
      const ascendingMemberIds = [failedPayout.id, cancelledPayout.id].sort();
      expect(items.map((item) => item.id)).toEqual(
        sort === 'newest' ? [...ascendingMemberIds].reverse() : ascendingMemberIds
      );
      return items;
    };

    await readMemberHistory('newest');
    await readMemberHistory('oldest');

    const singleStatusResults = await Promise.all(
      statusCases.map(async ({ payout, status }) => {
        const params = new URLSearchParams({ status, userId: payout.principalUserId, limit: '50' });
        const response = await app.handle(
          new Request(`http://localhost/api/v1/admin/payouts?${params}`, {
            headers: { cookie: adminCookie },
          })
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as PayoutListPage;
        expect(body.data.totalCount).toBe(1);
        expect(body.data.items.map((item) => item.id)).toEqual([payout.id]);
        return body.data.items[0]?.payoutStatus;
      })
    );
    expect(singleStatusResults).toEqual(statusCases.map(({ status }) => status));

    const defaultResponse = await app.handle(
      new Request(
        `http://localhost/api/v1/admin/payouts?userId=${pendingPayout.principalUserId}&limit=50`,
        { headers: { cookie: adminCookie } }
      )
    );
    const defaultBody = (await defaultResponse.json()) as PayoutListPage;
    expect(defaultResponse.status).toBe(200);
    expect(defaultBody.data).toMatchObject({
      items: [
        expect.objectContaining({ id: pendingPayout.id, payoutStatus: 'PENDING_ADMIN_APPROVAL' }),
      ],
      totalCount: 1,
      nextCursor: null,
    });

    const emptyResults = await Promise.all(
      ['ALL', 'FAILED'].map(async (status) => {
        const params = new URLSearchParams({ status, userId: crypto.randomUUID() });
        const response = await app.handle(
          new Request(`http://localhost/api/v1/admin/payouts?${params}`, {
            headers: { cookie: adminCookie },
          })
        );
        expect(response.status).toBe(200);
        return response.json();
      })
    );
    for (const result of emptyResults) {
      expect(result).toMatchObject({ data: { items: [], totalCount: 0, nextCursor: null } });
    }
    const restoredAt = new Date();
    await db
      .update(paymentPayouts)
      .set({ createdAt: restoredAt, updatedAt: restoredAt })
      .where(inArray(paymentPayouts.id, seededIds));
  }, 60_000);

  it('rejects a cursor whose Payout no longer exists', async () => {
    const cursor = encodeCursor({
      startTime: '2031-01-05T00:00:00.100200Z',
      id: crypto.randomUUID(),
    });
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts?cursor=${encodeURIComponent(cursor)}`, {
        headers: { cookie: adminCookie },
      })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_LIMIT');
  });
});
