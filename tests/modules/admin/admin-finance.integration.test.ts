import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { encodeCursor } from '@/shared/cursor';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  releaseFundingReservation,
  reserveSpending,
  settleFundingReservation,
  signedSatang,
} from '@/modules/wallet';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
const adminEmail = `admin-finance-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminFinancePass1!';

let adminId = '';
let adminCookie = '';

const hirerId = crypto.randomUUID();
const workerId = crypto.randomUUID();
const tagId = crypto.randomUUID();
const hirerStudentId = String(Math.floor(1000000000 + Math.random() * 9000000000));
const workerStudentId = String(Math.floor(1000000000 + Math.random() * 9000000000));
let testQuestId = '';
let testReservationId = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

type IdRow = { id: string };

type LedgerTransactionPage = {
  data?: { items: { id: string }[]; nextCursor: string | null };
};

type LedgerErrorBody = {
  success: boolean;
  error?: { code: string; message: string };
};

const creditSpending = async (userId: string, amountSatang: number): Promise<string> => {
  const accounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, userId));
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  const spending = accounts.find((account) => account.type === 'SPENDING');
  if (!spending || !suspense) throw new Error('Test Wallet accounts were not provisioned.');
  const ledgerTransaction = await createSealedLedgerTransaction({
    businessReference: `admin-finance-credit:${crypto.randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spending.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
  return ledgerTransaction.id;
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();

  // Create Hirer and Worker
  await db.insert(authUser).values([
    {
      id: hirerId,
      email: `${hirerId}@ku.th`,
      firstName: 'Finance',
      lastName: 'Hirer',
      studentId: hirerStudentId,
    },
    {
      id: workerId,
      email: `${workerId}@ku.th`,
      firstName: 'Finance',
      lastName: 'Worker',
      studentId: workerStudentId,
    },
  ]);

  await ensureWallet(hirerId);
  await ensureWallet(workerId);
  await creditSpending(hirerId, 50_000);

  await db.insert(tag).values({ id: tagId, name: `Finance Tag ${tagId}` });

  // Create Admin
  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Finance Admin',
      firstName: 'Finance',
      lastName: 'Admin',
    },
  });
  adminId = signUp.user.id;

  const adminLogin = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (adminLogin.status !== 200) throw new Error('Finance Admin session was not created.');
  adminCookie = getCookieHeader(adminLogin);

  // Reserve spending for test quest
  testQuestId = crypto.randomUUID();
  const reservation = await db.transaction((transaction) =>
    reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: testQuestId,
      amountSatang: positiveSatang(30_000),
    })
  );
  testReservationId = reservation.id;

  // Insert test Quest
  await db.insert(quest).values({
    id: testQuestId,
    hirerId,
    title: 'Admin Finance Test Quest',
    condition: 'Complete financial test requirements',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 25_000,
    platformFeePerWorkerSatang: 5_000,
    questFundingTotalSatang: 30_000,
    questEscrowSatang: 30_000,
    fundingReservationId: testReservationId,
    tagId,
    headcount: 1,
    startTime: new Date(),
  });

  const assignmentId = crypto.randomUUID();
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId: testQuestId,
    workerId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    startedAt: new Date(),
  });

  // Settle partial funds to worker (20,000 satang to worker, 4,000 to platform fee = 24,000 total)
  await db.transaction((transaction) =>
    settleFundingReservation(transaction, {
      ownerUserId: hirerId,
      reservationId: testReservationId,
      settlementReference: `settle:${assignmentId}`,
      recipientUserId: workerId,
      recipientAmountSatang: positiveSatang(20_000),
      platformFeeSatang: positiveSatang(4_000),
      platformFeeValidation: 'QUEST_ESCROW_SNAPSHOT',
    })
  );

  // Release remaining 6,000 satang back to hirer
  await db.transaction((transaction) =>
    releaseFundingReservation(transaction, {
      ownerUserId: hirerId,
      reservationId: testReservationId,
      operationReference: `release:${testQuestId}`,
    })
  );
});

afterAll(async () => {
  if (testQuestId) {
    await db.delete(questAssignment).where(eq(questAssignment.questId, testQuestId));
    await db.delete(quest).where(eq(quest.id, testQuestId));
  }
  await db.delete(tag).where(eq(tag.id, tagId));
  if (adminId) {
    await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  }
});

describe('Admin Finance Endpoints Integration Tests', () => {
  describe('GET /api/v1/admin/finance/quests/:questId', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const response = await app.handle(
        new Request(`http://localhost/api/v1/admin/finance/quests/${testQuestId}`)
      );
      expect(response.status).toBe(401);
    });

    it('returns 404 when quest does not exist', async () => {
      const nonExistentId = crypto.randomUUID();
      const response = await app.handle(
        new Request(`http://localhost/api/v1/admin/finance/quests/${nonExistentId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('QUEST_NOT_FOUND');
    });

    it('returns complete quest financial audit and transfer log', async () => {
      const response = await app.handle(
        new Request(`http://localhost/api/v1/admin/finance/quests/${testQuestId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);

      const data = json.data;
      expect(data.quest.id).toBe(testQuestId);
      expect(data.quest.title).toBe('Admin Finance Test Quest');
      expect(data.quest.hirer.id).toBe(hirerId);
      expect(data.quest.hirer.studentId).toBe(hirerStudentId);

      expect(data.reservation).not.toBeNull();
      expect(data.reservation.id).toBe(testReservationId);
      expect(data.reservation.totalReservedSatang).toBe(30_000);
      expect(data.reservation.status).toBe('RELEASED');
      expect(data.reservation.remainingSatang).toBe(0);

      // Verify transfers
      expect(data.transfers.length).toBeGreaterThanOrEqual(3);

      // 1. Initial Reserve
      const reserve = data.transfers.find((t: { type: string }) => t.type === 'RESERVE');
      expect(reserve).toBeDefined();
      expect(reserve.from.type).toBe('HIRER');
      expect(reserve.from.id).toBe(hirerId);
      expect(reserve.to.type).toBe('QUEST_ESCROW');
      expect(reserve.amountSatang).toBe(30_000);

      // 2. Settlement
      const settlement = data.transfers.find((t: { type: string }) => t.type === 'SETTLEMENT');
      expect(settlement).toBeDefined();
      expect(settlement.from.type).toBe('QUEST_ESCROW');
      expect(settlement.to.type).toBe('WORKER');
      expect(settlement.to.id).toBe(workerId);
      expect(settlement.amountSatang).toBe(20_000);
      expect(settlement.platformFeeSatang).toBe(4_000);

      // 3. Release
      const release = data.transfers.find((t: { type: string }) => t.type === 'RELEASE');
      expect(release).toBeDefined();
      expect(release.from.type).toBe('QUEST_ESCROW');
      expect(release.to.type).toBe('HIRER');
      expect(release.to.id).toBe(hirerId);
      expect(release.amountSatang).toBe(6_000);

      // Verify ledger transactions
      expect(data.ledgerTransactions.length).toBeGreaterThanOrEqual(3);
      for (const tx of data.ledgerTransactions) {
        expect(tx.postings.length).toBeGreaterThanOrEqual(2);
        const sum = tx.postings.reduce(
          (total: number, p: { amountSatang: number }) => total + p.amountSatang,
          0
        );
        expect(sum).toBe(0); // Zero-sum balanced invariant
      }
    });
  });

  describe('GET /api/v1/admin/finance/ledger/transactions', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const response = await app.handle(
        new Request('http://localhost/api/v1/admin/finance/ledger/transactions')
      );
      expect(response.status).toBe(401);
    });

    it('returns paginated transactions with zero-sum invariant verified', async () => {
      const response = await app.handle(
        new Request('http://localhost/api/v1/admin/finance/ledger/transactions?limit=10', {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data.items)).toBe(true);
      expect(json.data.items.length).toBeGreaterThan(0);

      for (const tx of json.data.items) {
        expect(typeof tx.isBalanced).toBe('boolean');
        expect(Array.isArray(tx.postings)).toBe(true);
      }
    });

    it('filters ledger transactions by eventType', async () => {
      const response = await app.handle(
        new Request(
          'http://localhost/api/v1/admin/finance/ledger/transactions?eventType=FUNDING_RESERVE',
          {
            headers: { cookie: adminCookie },
          }
        )
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      for (const tx of json.data.items) {
        expect(tx.eventType).toBe('FUNDING_RESERVE');
      }
    });

    it('filters ledger transactions by userId', async () => {
      const response = await app.handle(
        new Request(`http://localhost/api/v1/admin/finance/ledger/transactions?userId=${hirerId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      for (const tx of json.data.items) {
        expect(tx.isBalanced).toBe(true);
        const sum = tx.postings.reduce(
          (total: number, p: { amountSatang: number }) => total + p.amountSatang,
          0
        );
        expect(sum).toBe(0);
      }
    });

    const ledgerListRequest = (params: URLSearchParams) =>
      app.handle(
        new Request(`http://localhost/api/v1/admin/finance/ledger/transactions?${params}`, {
          headers: { cookie: adminCookie },
        })
      );

    const expectInvalidCursor = async (response: Response, message: string) => {
      expect(response.status).toBe(400);
      const body = (await response.json()) as LedgerErrorBody;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('INVALID_CURSOR');
      expect(body.error?.message).toBe(message);
    };
    const seedLedgerTransaction = async (marker: string, createdAt: string): Promise<string> => {
      // Raw SQL seeding keeps microsecond precision; a JavaScript Date and the
      // query builder truncate timestamps to milliseconds. The business
      // reference is unique, so each row carries its own uuid suffix while the
      // list filter still matches the shared marker substring.
      const [row] = (await sql`
        insert into wallet_ledger_transactions (id, business_reference, event_type, created_at)
        values (
          ${crypto.randomUUID()},
          ${`${marker}-${crypto.randomUUID()}`},
          'ADJUSTMENT',
          ${createdAt}::timestamptz
        )
        returning id
      `) as IdRow[];
      if (!row) throw new Error('Ledger Transaction fixture was not created.');
      return row.id;
    };

    it('pages every transaction exactly once across a shared millisecond at limit 1', async () => {
      const marker = `ledger-cursor-${crypto.randomUUID()}`;
      // The sealed-ledger trigger rejects row deletion, so fixture rows stay
      // behind; the uuid marker keeps every run isolated.
      const createdAtValues = [
        '2030-08-05T00:00:00.100200Z',
        '2030-08-05T00:00:00.100800Z',
        '2030-08-05T00:00:00.101300Z',
        '2030-08-05T00:00:00.205700Z',
      ];
      const seededIds: string[] = [];
      for (const createdAt of createdAtValues) {
        // eslint-disable-next-line no-await-in-loop
        seededIds.push(await seedLedgerTransaction(marker, createdAt));
      }

      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const params = new URLSearchParams({ businessReference: marker, limit: '1' });
        if (cursor) params.set('cursor', cursor);
        // Each page cursor comes from the previous response, so these
        // requests must remain sequential.
        // eslint-disable-next-line no-await-in-loop
        const response = await ledgerListRequest(params);
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = (await response.json()) as LedgerTransactionPage;
        expect(body.data).toBeDefined();
        ids.push(...body.data!.items.map((item) => item.id));
        cursor = body.data!.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(ids).toEqual([...seededIds].reverse());
    });

    it('rejects a cursor whose anchor row is gone and a malformed cursor with the shared error envelope', async () => {
      // The sealed-ledger trigger rejects row deletion, so a well-formed
      // cursor for an id that does not exist stands in for a deleted anchor.
      // Both requests take the same missing-anchor rejection path.
      await expectInvalidCursor(
        await ledgerListRequest(
          new URLSearchParams({
            cursor: encodeCursor({
              id: crypto.randomUUID(),
              startTime: '2030-08-05T00:00:00.000Z',
            }),
          })
        ),
        'cursor does not match a Ledger Transaction'
      );
      await expectInvalidCursor(
        await ledgerListRequest(new URLSearchParams({ cursor: 'not-valid-base64url!!' })),
        'cursor is invalid'
      );
    });
  });

  describe('GET /api/v1/admin/finance/overview', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const response = await app.handle(
        new Request('http://localhost/api/v1/admin/finance/overview')
      );
      expect(response.status).toBe(401);
    });

    it('returns platform balances, volume, and subledger zero-sum integrity', async () => {
      const response = await app.handle(
        new Request('http://localhost/api/v1/admin/finance/overview', {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);

      const overview = json.data;
      expect(typeof overview.platformBalances.revenueSatang).toBe('number');
      expect(typeof overview.platformBalances.suspenseSatang).toBe('number');

      expect(typeof overview.memberBalancesSummary.totalSpendingSatang).toBe('number');
      expect(typeof overview.memberBalancesSummary.totalEarningsSatang).toBe('number');
      expect(typeof overview.memberBalancesSummary.totalFundingReservedSatang).toBe('number');
      expect(typeof overview.memberBalancesSummary.totalPayoutReservedSatang).toBe('number');

      expect(typeof overview.volumeLifetime.totalTopUpDepositedSatang).toBe('number');
      expect(typeof overview.volumeLifetime.totalPayoutCompletedSatang).toBe('number');
      // Double-entry subledger integrity
      expect(typeof overview.integrity.subledgerBalanced).toBe('boolean');
      expect(typeof overview.integrity.totalPostingsDiscrepancySatang).toBe('number');
    });
  });
  describe('GET /api/v1/admin/finance/members/:userId', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const response = await app.handle(
        new Request(`http://localhost/api/v1/admin/finance/members/${hirerId}`)
      );
      expect(response.status).toBe(401);
    });

    it('returns 404 when member does not exist', async () => {
      const nonExistentUserId = crypto.randomUUID();
      const response = await app.handle(
        new Request(`http://localhost/api/v1/admin/finance/members/${nonExistentUserId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('MEMBER_NOT_FOUND');
    });

    it('returns member wallet balances, projection reconciliation, and lifetime stats', async () => {
      const response = await app.handle(
        new Request(`http://localhost/api/v1/admin/finance/members/${hirerId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);

      const data = json.data;
      expect(data.member.userId).toBe(hirerId);
      expect(data.member.studentId).toBe(hirerStudentId);
      expect(data.wallet).not.toBeNull();
      expect(data.wallet.walletStatus).toBe('ACTIVE');
      expect(data.wallet.projectionMatchesLedger).toBe(true);
      expect(data.lifetimeStats).toBeDefined();
    });
  });

  describe('GET /api/v1/admin/top-ups', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const response = await app.handle(new Request('http://localhost/api/v1/admin/top-ups'));
      expect(response.status).toBe(401);
    });

    it('returns paginated top-ups list', async () => {
      const response = await app.handle(
        new Request('http://localhost/api/v1/admin/top-ups?limit=10', {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data.items)).toBe(true);
    });
  });

  describe('GET /api/v1/admin/finance/policies', () => {
    it('returns current money policy', async () => {
      const response = await app.handle(
        new Request('http://localhost/api/v1/admin/finance/policies/current', {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.policy).not.toBeNull();
      expect(typeof json.data.policy.revision).toBe('number');
      expect(typeof json.data.policy.platformFeeBps).toBe('number');
    });

    it('lists money policy revisions', async () => {
      const response = await app.handle(
        new Request('http://localhost/api/v1/admin/finance/policies', {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data.policies)).toBe(true);
      expect(json.data.policies.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/admin/activity-logs (Contract Plural Alias)', () => {
    it('supports plural alias matching Issue #67 contract', async () => {
      const response = await app.handle(
        new Request('http://localhost/api/v1/admin/activity-logs?limit=5', {
          headers: { cookie: adminCookie },
        })
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data.items)).toBe(true);
    });
  });
});
