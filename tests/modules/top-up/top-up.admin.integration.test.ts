import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { paymentTopUp, paymentTopUpStatusHistory } from '@/database/schema/payment.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { ensureInitialMoneyPolicy, ensureWallet, positiveSatang } from '@/modules/wallet';
import { initiateTopUp, quoteTopUp } from '@/modules/top-up';
import type {
  InboundPaymentProvider,
  InboundPaymentRequest,
  InboundPaymentResponse,
} from '@/modules/top-up';
import { encodeCursor } from '@/shared/cursor';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

const adminEmail = `top-up-admin-test-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminPassword1!';
let adminId = '';
let adminCookie = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

class FakeInboundPaymentProvider implements InboundPaymentProvider {
  readonly requests: InboundPaymentRequest[] = [];
  readonly referencePrefix = `pr-admin-list-${crypto.randomUUID()}`;
  private attempt = 0;

  async createPayment(input: InboundPaymentRequest): Promise<InboundPaymentResponse> {
    this.requests.push(input);
    this.attempt += 1;
    return {
      providerReference: `${this.referencePrefix}-${this.attempt}`,
      providerStatus: 'REQUIRES_ACTION',
      providerAmountSatang: input.paymentTotalSatang,
      providerApiVersion: 'test-v1',
      providerChannelCode: 'TEST_QR',
      qrPayload: `qr-${this.attempt}`,
      qrExpiresAt: input.expiresAt,
    };
  }
}

type AdminTopUpListResponse = {
  success: boolean;
  data?: {
    items: { id: string; displayId: string }[];
    nextCursor: string | null;
  };
  error?: { code: string; message: string };
};

const listTopUps = (params: URLSearchParams): Promise<Response> =>
  app.handle(
    new Request(`http://localhost/api/v1/admin/top-ups?${params}`, {
      headers: { cookie: adminCookie },
    })
  );

const seedTopUpMember = async (): Promise<string> => {
  const userId = crypto.randomUUID();
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'AdminList',
    lastName: 'Walk',
    studentId: String(1_000_000_000 + Math.floor(Math.random() * 9_000_000_000)),
  });
  await ensureWallet(userId);
  return userId;
};

const seedDatedTopUp = async (
  userId: string,
  provider: FakeInboundPaymentProvider,
  createdAt: string
): Promise<string> => {
  const quote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });
  const topUp = await initiateTopUp(
    {
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: `admin-list-${crypto.randomUUID()}` },
    },
    provider
  );
  await sql`update payment_top_ups set created_at = ${createdAt}::timestamptz where id = ${topUp.id}`;
  return topUp.id;
};

// Four rows inside two adjacent milliseconds: two rows with distinct
// microseconds inside one millisecond and an exact timestamp tie, so a
// millisecond-granular cursor drops rows while paging.
const seedTieSpacedTopUps = async (
  userId: string
): Promise<{ first: string; within: string; ties: [string, string] }> => {
  const provider = new FakeInboundPaymentProvider();
  const first = await seedDatedTopUp(userId, provider, '2030-08-05T00:00:00.100200Z');
  const within = await seedDatedTopUp(userId, provider, '2030-08-05T00:00:00.100800Z');
  const tieLow = await seedDatedTopUp(userId, provider, '2030-08-05T00:00:00.101300Z');
  const tieHigh = await seedDatedTopUp(userId, provider, '2030-08-05T00:00:00.101300Z');
  return { first, within, ties: [tieLow, tieHigh] };
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
  const seedAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });

  const signUp = await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'TopUp Admin',
      firstName: 'TopUp',
      lastName: 'Admin',
    },
  });
  adminId = signUp.user.id;

  const loginResponse = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  expect(loginResponse.status).toBe(200);
  adminCookie = getCookieHeader(loginResponse);
});

afterAll(async () => {
  if (adminId) {
    await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  }
});

describe('Admin Top-Up API routes', () => {
  it('requires Admin authentication for all routes', async () => {
    const fakeId = crypto.randomUUID();
    const unauthenticatedReconcile = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${fakeId}/reconcile`, {
        method: 'POST',
      })
    );
    expect(unauthenticatedReconcile.status).toBe(401);
    const unauthenticatedDetail = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${fakeId}`)
    );
    expect(unauthenticatedDetail.status).toBe(401);
    const unauthenticatedHistory = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${fakeId}/status-history`)
    );
    expect(unauthenticatedHistory.status).toBe(401);

    const unauthenticatedRetry = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/events/${fakeId}/retry`, {
        method: 'POST',
      })
    );
    expect(unauthenticatedRetry.status).toBe(401);
  });

  it('returns 404 when reconciling a non-existent Top-Up', async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${fakeId}/reconcile`, {
        method: 'POST',
        headers: { cookie: adminCookie },
      })
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 when retrying a non-existent provider event', async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/events/${fakeId}/retry`, {
        method: 'POST',
        headers: { cookie: adminCookie },
      })
    );
    expect(response.status).toBe(404);
  });
  it('returns safe Admin Top-Up detail with a stable display ID', async () => {
    const userId = await seedTopUpMember();
    const topUpId = await seedDatedTopUp(
      userId,
      new FakeInboundPaymentProvider(),
      new Date().toISOString()
    );

    const listResponse = await listTopUps(new URLSearchParams({ userId }));
    const listBody = (await listResponse.json()) as {
      data: {
        items: Array<{
          id: string;
          displayId: string;
          member: { firstName: string; lastName: string; studentId: string | null };
        }>;
      };
    };
    const listItem = listBody.data.items.find((item) => item.id === topUpId);
    if (!listItem) throw new Error('The seeded Top-Up is missing from the Admin list.');
    expect(listResponse.status).toBe(200);
    expect(listItem.displayId).toMatch(/^TOP-\d{6,}$/);

    const detailResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${topUpId}`, {
        headers: { cookie: adminCookie },
      })
    );
    const detail = (await detailResponse.json()) as {
      success: boolean;
      data: {
        id: string;
        displayId: string;
        userId: string;
        member: { firstName: string; lastName: string; studentId: string | null };
        [key: string]: unknown;
      };
    };
    expect(detailResponse.status).toBe(200);
    expect(detail.success).toBe(true);
    expect(detail.data).toMatchObject({
      id: topUpId,
      displayId: listItem.displayId,
      userId,
      member: {
        firstName: 'AdminList',
        lastName: 'Walk',
        studentId: expect.stringMatching(/^\d{10}$/),
      },
      topUpStatus: 'PENDING',
      creditAmountSatang: 100,
      paymentMethod: 'TEST_QR',
    });
    expect(detail.data.id).toBe(topUpId);
    expect(detail.data.displayId).not.toBe(topUpId);
    expect(detail.data.member).toEqual(listItem.member);
    expect(detail.data).not.toHaveProperty('internalReference');
    expect(detail.data).not.toHaveProperty('providerApiVersion');
    expect(detail.data).not.toHaveProperty('qrPayload');
    expect(JSON.stringify(detail)).not.toContain('qr-1');
    expect(Object.keys(detail.data).sort()).toEqual([
      'createdAt',
      'creditAmountSatang',
      'displayId',
      'expiresAt',
      'id',
      'member',
      'paidAt',
      'paymentMethod',
      'paymentTotalSatang',
      'providerFeeSatang',
      'providerReference',
      'providerTaxSatang',
      'topUpStatus',
      'userId',
    ]);

    const missingResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${crypto.randomUUID()}`, {
        headers: { cookie: adminCookie },
      })
    );
    const missingBody = (await missingResponse.json()) as {
      success: boolean;
      error: { code: string };
    };
    expect(missingResponse.status).toBe(404);
    expect(missingBody.success).toBe(false);
    expect(missingBody.error.code).toBe('TOP_UP_NOT_FOUND');
  });

  it('returns recorded Top-Up status history with its occurrence time, including failure', async () => {
    const userId = await seedTopUpMember();
    const topUpId = await seedDatedTopUp(
      userId,
      new FakeInboundPaymentProvider(),
      new Date().toISOString()
    );
    const providerOccurredAt = new Date('2026-08-27T00:00:00.000Z');
    await db
      .update(paymentTopUp)
      .set({ topUpStatus: 'FAILED', updatedAt: providerOccurredAt })
      .where(eq(paymentTopUp.id, topUpId));
    await db.insert(paymentTopUpStatusHistory).values({
      topUpId,
      fromStatus: 'PENDING',
      toStatus: 'FAILED',
      providerStatus: 'FAILED',
      source: 'PROVIDER',
      reason: 'Provider reported a failed payment.',
      occurredAt: providerOccurredAt,
    });

    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${topUpId}/status-history`, {
        headers: { cookie: adminCookie },
      })
    );
    const body = (await response.json()) as {
      success: boolean;
      data: Array<{
        fromStatus: string | null;
        toStatus: string;
        source: string;
        occurredAt: string;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromStatus: 'PENDING',
          toStatus: 'FAILED',
          source: 'PROVIDER',
          occurredAt: providerOccurredAt.toISOString(),
        }),
      ])
    );

    const missing = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${crypto.randomUUID()}/status-history`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('TOP_UP_NOT_FOUND');
  });

  it('pages newest-first through every Top-Up without dropping rows that share the anchor millisecond', async () => {
    const userId = await seedTopUpMember();
    const seeded = await seedTieSpacedTopUps(userId);

    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 8; page += 1) {
      const params = new URLSearchParams({ userId, limit: '1' });
      if (cursor) params.set('cursor', cursor);
      // Each page cursor comes from the previous response, so these requests
      // must remain sequential.
      // eslint-disable-next-line no-await-in-loop
      const response = await listTopUps(params);
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()) as AdminTopUpListResponse;
      expect(body.success).toBe(true);
      ids.push(...body.data!.items.map((item) => item.id));
      cursor = body.data!.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();

    const tieDescending = [...seeded.ties].sort((left, right) => (left < right ? -1 : 1)).reverse();
    expect(ids).toEqual([...tieDescending, seeded.within, seeded.first]);
  });

  it('rejects a cursor whose anchor Top-Up is gone with the invalid-cursor error envelope', async () => {
    // Hard delete is blocked for Top-Ups (record retention), so the missing
    // anchor is exercised with a cursor naming a uuid that matches no row.
    const userId = await seedTopUpMember();
    await seedTieSpacedTopUps(userId);
    const ghostCursor = encodeCursor({
      id: crypto.randomUUID(),
      startTime: '2030-08-05T00:00:00.100Z',
    });

    const response = await listTopUps(
      new URLSearchParams({ userId, limit: '1', cursor: ghostCursor })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as AdminTopUpListResponse;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('INVALID_CURSOR');
    expect(body.error?.message).toBe('cursor does not match a Top-Up');
  });

  it('rejects a malformed cursor with the invalid-cursor error envelope', async () => {
    const response = await listTopUps(
      new URLSearchParams({ limit: '1', cursor: 'not-valid-base64url!!' })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as AdminTopUpListResponse;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('INVALID_CURSOR');
    expect(body.error?.message).toBe('cursor is invalid');
  });
});
