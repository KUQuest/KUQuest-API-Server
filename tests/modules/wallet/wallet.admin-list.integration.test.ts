import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  signedSatang,
} from '@/modules/wallet';
import { encodeCursor } from '@/shared/cursor';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

const adminEmail = `admin-wallet-list-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminWalletPass1!';

let adminId = '';
let adminCookie = '';

const testUserId = crypto.randomUUID();
const testStudentId = String(Math.floor(1000000000 + Math.random() * 9000000000));
let testWalletId = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const creditBalances = async (
  userId: string,
  spendingSatang: number,
  earningsSatang: number
): Promise<void> => {
  const accounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, userId));
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));

  const spending = accounts.find((a) => a.type === 'SPENDING');
  const earnings = accounts.find((a) => a.type === 'EARNINGS');
  if (!spending || !earnings || !suspense) throw new Error('Accounts missing');

  await createSealedLedgerTransaction({
    businessReference: `wallet-list-credit:${crypto.randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spending.id, amountSatang: signedSatang(spendingSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-spendingSatang) },
    ],
  });

  await createSealedLedgerTransaction({
    businessReference: `wallet-list-earnings:${crypto.randomUUID()}`,
    eventType: 'ADJUSTMENT',
    postings: [
      { accountId: earnings.id, amountSatang: signedSatang(earningsSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-earningsSatang) },
    ],
  });
};

type AdminWalletListResponse = {
  success: boolean;
  data?: { items: { id: string }[]; nextCursor: string | null };
  error?: { code: string; message: string };
};

const listWallets = (params: URLSearchParams): Promise<Response> =>
  app.handle(
    new Request(`http://localhost/api/v1/admin/wallets?${params}`, {
      headers: { cookie: adminCookie },
    })
  );

const seedDatedWallet = async (lastName: string, createdAt: string): Promise<string> => {
  const userId = crypto.randomUUID();
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'CursorWalk',
    lastName,
  });
  const wallet = await ensureWallet(userId);
  await sql`update wallet_wallets set created_at = ${createdAt}::timestamptz where id = ${wallet.id}`;
  return wallet.id;
};

// Four wallets inside two adjacent milliseconds: two rows with distinct
// microseconds inside one millisecond and an exact timestamp tie, so a
// millisecond-granular cursor drops rows while paging.
const seedTieSpacedWallets = async (
  lastName: string
): Promise<{ first: string; within: string; ties: [string, string] }> => {
  const first = await seedDatedWallet(lastName, '2030-08-05T00:00:00.100200Z');
  const within = await seedDatedWallet(lastName, '2030-08-05T00:00:00.100800Z');
  const tieLow = await seedDatedWallet(lastName, '2030-08-05T00:00:00.101300Z');
  const tieHigh = await seedDatedWallet(lastName, '2030-08-05T00:00:00.101300Z');
  return { first, within, ties: [tieLow, tieHigh] };
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();

  await db.insert(authUser).values({
    id: testUserId,
    email: `${testUserId}@ku.th`,
    firstName: 'WalletList',
    lastName: 'Tester',
    studentId: testStudentId,
    telephone: '0812345678',
  });

  const wallet = await ensureWallet(testUserId);
  testWalletId = wallet.id;
  await creditBalances(testUserId, 15_000, 25_000);

  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Wallet Admin',
      firstName: 'Wallet',
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
  if (adminLogin.status !== 200) throw new Error('Admin login failed');
  adminCookie = getCookieHeader(adminLogin);
});

afterAll(async () => {
  if (adminId) {
    await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  }
});

describe('Admin Wallet Directory Integration Tests', () => {
  describe('GET /api/v1/admin/wallets', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const res = await app.handle(new Request('http://localhost/api/v1/admin/wallets'));
      expect(res.status).toBe(401);
    });

    it('lists user wallets with both spending and earnings balances in one request', async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/wallets?userId=${testUserId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBe(1);

      const item = json.data.items[0];
      expect(item.id).toBe(testWalletId);
      expect(item.userId).toBe(testUserId);
      expect(item.member.firstName).toBe('WalletList');
      expect(item.member.lastName).toBe('Tester');
      expect(item.member.studentId).toBe(testStudentId);
      expect(item.walletStatus).toBe('ACTIVE');

      // Both balances in one request:
      expect(item.balances.spendingBalanceSatang).toBe(15_000);
      expect(item.balances.earningsBalanceSatang).toBe(25_000);
      expect(item.balances.totalBalanceSatang).toBe(40_000);
    });

    it('searches user wallets by studentId', async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/wallets?search=${testStudentId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBe(1);
      expect(json.data.items[0].member.studentId).toBe(testStudentId);
    });

    it('filters user wallets by status', async () => {
      const res = await app.handle(
        new Request('http://localhost/api/v1/admin/wallets?status=ACTIVE&limit=5', {
          headers: { cookie: adminCookie },
        })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      for (const item of json.data.items) {
        expect(item.walletStatus).toBe('ACTIVE');
      }
    });

    it('pages newest-first through every Wallet without dropping rows that share the anchor millisecond', async () => {
      const walkLastName = `CursorWalk-${crypto.randomUUID()}`;
      const seeded = await seedTieSpacedWallets(walkLastName);

      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const params = new URLSearchParams({ search: walkLastName, limit: '1' });
        if (cursor) params.set('cursor', cursor);
        // Each page cursor comes from the previous response, so these requests
        // must remain sequential.
        // eslint-disable-next-line no-await-in-loop
        const response = await listWallets(params);
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = (await response.json()) as AdminWalletListResponse;
        expect(body.success).toBe(true);
        ids.push(...body.data!.items.map((item) => item.id));
        cursor = body.data!.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();

      const tieDescending = [...seeded.ties]
        .sort((left, right) => (left < right ? -1 : 1))
        .reverse();
      expect(ids).toEqual([...tieDescending, seeded.within, seeded.first]);
    });

    it('rejects a cursor that names no Wallet with the invalid-cursor error envelope', async () => {
      const ghostCursor = encodeCursor({
        id: crypto.randomUUID(),
        startTime: '2030-08-05T00:00:00.100Z',
      });

      const response = await listWallets(new URLSearchParams({ limit: '1', cursor: ghostCursor }));
      expect(response.status).toBe(400);
      const body = (await response.json()) as AdminWalletListResponse;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('INVALID_CURSOR');
      expect(body.error?.message).toBe('cursor does not match a Wallet');
    });

    it('rejects a malformed cursor with the invalid-cursor error envelope', async () => {
      const response = await listWallets(
        new URLSearchParams({ limit: '1', cursor: 'not-valid-base64url!!' })
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as AdminWalletListResponse;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('INVALID_CURSOR');
      expect(body.error?.message).toBe('cursor is invalid');
    });
  });

  describe('GET /api/v1/admin/wallets/:walletId', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/wallets/${testWalletId}`)
      );
      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent wallet', async () => {
      const nonExistentId = crypto.randomUUID();
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/wallets/${nonExistentId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('WALLET_NOT_FOUND');
    });

    it('returns wallet detail with both balance compartments and ledger reconciliation', async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/wallets/${testWalletId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const w = json.data.wallet;
      expect(w.id).toBe(testWalletId);
      expect(w.userId).toBe(testUserId);
      expect(w.member.studentId).toBe(testStudentId);
      expect(w.balances.spendingBalanceSatang).toBe(15_000);
      expect(w.balances.earningsBalanceSatang).toBe(25_000);
      expect(w.balances.totalBalanceSatang).toBe(40_000);
      expect(w.projectionMatchesLedger).toBe(true);
    });
  });
});
