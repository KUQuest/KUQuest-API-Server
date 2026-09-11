import { app } from '@/app';
import { sql } from '@/database/client';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';

import { beforeAll, describe, expect, it } from 'bun:test';

const adminEmail = `payout-reconcile-test-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminPassword1!';
let adminCookie = '';

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
      name: 'Payout Reconcile Admin',
      firstName: 'Payout',
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
});

describe('Admin Payout Reconciliation API routes', () => {
  it('requires Admin authentication for all routes', async () => {
    const fakeId = crypto.randomUUID();
    const unauthenticatedReconcile = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${fakeId}/reconcile`, {
        method: 'POST',
      }),
    );
    expect(unauthenticatedReconcile.status).toBe(401);

    const unauthenticatedRetry = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/events/${fakeId}/retry`, {
        method: 'POST',
      }),
    );
    expect(unauthenticatedRetry.status).toBe(401);
  });

  it('returns 404 when reconciling a non-existent Payout', async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/${fakeId}/reconcile`, {
        method: 'POST',
        headers: { cookie: adminCookie },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 when retrying a non-existent payout provider event', async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/payouts/events/${fakeId}/retry`, {
        method: 'POST',
        headers: { cookie: adminCookie },
      }),
    );
    expect(response.status).toBe(404);
  });
});
