import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { createWallet, getWallet } from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';

const adminEmail = `wallet-admin-test-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminPassword1!';
let adminCookie = '';

const studentId = crypto.randomUUID();
let studentWalletId = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

beforeAll(async () => {
  await sql`select 1`;
  const seedAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });

  await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Wallet Admin',
      firstName: 'Wallet',
      lastName: 'Admin',
    },
  });

  const loginResponse = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    }),
  );
  expect(loginResponse.status).toBe(200);
  adminCookie = getCookieHeader(loginResponse);

  await db.insert(authUser).values({
    id: studentId,
    email: `student-${studentId}@ku.th`,
    firstName: 'Student',
    lastName: 'AdminTest',
  });

  const wallet = await createWallet(studentId);
  studentWalletId = wallet.id;
});

describe('Admin Wallet API routes', () => {
  it('requires Admin authentication for all routes', async () => {
    const unauthenticated = await app.handle(
      new Request(`http://localhost/api/v1/admin/wallets/${studentWalletId}/status-history`),
    );
    expect(unauthenticated.status).toBe(401);
  });

  it('retrieves the status history of a Wallet', async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/wallets/${studentWalletId}/status-history`, {
        headers: { cookie: adminCookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { history: unknown[] } };
    expect(body.data.history.length).toBeGreaterThanOrEqual(1);
  });

  it('freezes and restores a Wallet with status changes and history', async () => {
    const freezeResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/wallets/${studentWalletId}/status`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': `freeze-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          toStatus: 'FROZEN',
          reason: 'Investigation hold',
        }),
      }),
    );
    expect(freezeResponse.status).toBe(200);
    const freezeBody = (await freezeResponse.json()) as { data: { wallet: { walletStatus: string } } };
    expect(freezeBody.data.wallet.walletStatus).toBe('FROZEN');

    const walletAfterFreeze = await getWallet(studentId);
    expect(walletAfterFreeze.walletStatus).toBe('FROZEN');

    const unfreezeResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/wallets/${studentWalletId}/status`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'idempotency-key': `unfreeze-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          toStatus: 'ACTIVE',
          reason: 'Investigation cleared',
        }),
      }),
    );
    expect(unfreezeResponse.status).toBe(200);
    const unfreezeBody = (await unfreezeResponse.json()) as { data: { wallet: { walletStatus: string } } };
    expect(unfreezeBody.data.wallet.walletStatus).toBe('ACTIVE');

    const walletAfterRestore = await getWallet(studentId);
    expect(walletAfterRestore.walletStatus).toBe('ACTIVE');
  });

  it('verifies subledger projection against authoritative ledger postings', async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/wallets/${studentWalletId}/verification`, {
        headers: { cookie: adminCookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { matches: boolean } };
    expect(body.data.matches).toBe(true);
  });

  it('rebuilds the Wallet projection directly from ledger', async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/wallets/${studentWalletId}/rebuild-projection`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { wallet: { spendingBalanceSatang: number } } };
    expect(body.data.wallet.spendingBalanceSatang).toBe(0);
  });
});
