import { app } from '@/app';
import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { walletWallet } from '@/database/schema/wallet.schema';
import { authPlugin, createStagingTestAuthRoute } from '@/modules/auth';
import { getWallet } from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { afterAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

const testEmail = `staging-test-${randomUUID()}@ku.th`;
const testPassword = 'TestStudent1!';
const testAccount2Email = `staging-test-account-2-${randomUUID()}@ku.th`;
const testAccount2Password = 'TestStudent2!';
const stagingTestApp = new Elysia({ name: 'staging-test-auth-integration' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: testEmail,
    password: testPassword,
    firstName: 'Staging',
    lastName: 'Test Student',
    account2: {
      email: testAccount2Email,
      password: testAccount2Password,
      firstName: 'Chat',
      lastName: 'Worker',
    },
  }),
);
const composedStagingTestApp = new Elysia({
  name: 'staging-test-auth-composition',
})
  .use(authPlugin)
  .use(
    createStagingTestAuthRoute({
      enabled: true,
      deploymentEnv: 'staging',
      email: testEmail,
      password: testPassword,
      firstName: 'Staging',
      lastName: 'Test Student',
    }),
  );

const disabledStagingTestApp = new Elysia({ name: 'disabled-staging-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: false,
    deploymentEnv: 'staging',
    email: testEmail,
    password: testPassword,
    firstName: 'Staging',
    lastName: 'Test Student',
  }),
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

afterAll(async () => {
  await Promise.all([testEmail, testAccount2Email].map(async (email) => {
    const [wallet] = await db
      .select({ id: walletWallet.id })
      .from(walletWallet)
      .innerJoin(authUser, eq(walletWallet.userId, authUser.id))
      .where(eq(authUser.email, email));
    // Wallet provisioning retains immutable status history, so keep this fixture after the Wallet exists.
    if (!wallet) await db.delete(authUser).where(eq(authUser.email, email));
  }));
});

describe('staging test authentication', () => {
  it('is unavailable when the staging flag is off', async () => {
    const response = await disabledStagingTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/get-session'),
    );

    expect(response.status).toBe(404);
  });

  it('does not enable the route outside the staging deployment environment', async () => {
    const productionTestApp = new Elysia({ name: 'production-test-auth' }).use(
      createStagingTestAuthRoute({
        enabled: true,
        deploymentEnv: 'production',
        email: testEmail,
        password: testPassword,
        firstName: 'Staging',
        lastName: 'Test Student',
      }),
    );
    const response = await productionTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/get-session'),
    );

    expect(response.status).toBe(404);
  });

  it('routes through the auth composition when the staging flag is enabled', async () => {
    const response = await composedStagingTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: testEmail,
          password: 'WrongStudent1!',
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('creates a configured Student and issues a normal session', async () => {
    const invalidLoginResponse = await stagingTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: 'WrongStudent1!' }),
      }),
    );

    expect(invalidLoginResponse.status).toBe(401);

    const loginResponse = await stagingTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      }),
    );

    expect(loginResponse.status).toBe(200);
    expect(getCookieHeader(loginResponse)).toContain('better-auth.session_token=');

    const loginBody = (await loginResponse.json()) as { user: { id: string } };
    const wallet = await getWallet(loginBody.user.id);
    expect(wallet).toMatchObject({
      walletStatus: 'ACTIVE',
      spendingBalanceSatang: 0,
      earningsBalanceSatang: 0,
      fundingReservedSatang: 0,
      reservedForPayoutsSatang: 0,
    });

    const profileResponse = await app.handle(
      new Request('http://localhost/api/v1/profile', {
        headers: { cookie: getCookieHeader(loginResponse) },
      }),
    );

    expect(profileResponse.status).toBe(200);
    expect((await profileResponse.json()).success).toBe(true);

    const walletResponse = await app.handle(
      new Request('http://localhost/api/v1/wallet', {
        headers: { cookie: getCookieHeader(loginResponse) },
      }),
    );

    expect(walletResponse.status).toBe(200);
    expect(await walletResponse.json()).toMatchObject({
      success: true,
      data: {
        wallet: {
          spendingBalanceSatang: 0,
          earningsBalanceSatang: 0,
          fundingReservedSatang: 0,
          reservedForPayoutsSatang: 0,
        },
      },
    });
  });

  it('issues a normal session for the default test Student without exposing credentials', async () => {
    const response = await stagingTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/sign-in/default', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(200);
    expect(getCookieHeader(response)).toContain('better-auth.session_token=');
  });

  it('issues separate normal sessions for Account 1 and Account 2', async () => {
    const account1Response = await stagingTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/sign-in/account-1', {
        method: 'POST',
      }),
    );
    const account2Response = await stagingTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/sign-in/account-2', {
        method: 'POST',
      }),
    );

    expect(account1Response.status).toBe(200);
    expect(account2Response.status).toBe(200);
    const account1Body = (await account1Response.json()) as { user: { id: string } };
    const account2Body = (await account2Response.json()) as { user: { id: string } };
    expect(account1Body.user.id).not.toBe(account2Body.user.id);

    const account2SessionResponse = await stagingTestApp.handle(
      new Request('http://localhost/api/staging/test-auth/get-session', {
        headers: { cookie: getCookieHeader(account2Response) },
      }),
    );
    expect(account2SessionResponse.status).toBe(200);
    expect((await account2SessionResponse.json()).user.id).toBe(account2Body.user.id);

    const account2Wallet = await getWallet(account2Body.user.id);
    expect(account2Wallet.walletStatus).toBe('ACTIVE');
  });
});
