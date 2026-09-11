import { app } from '@/app';
import { sql } from '@/database/client';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';

import { beforeAll, describe, expect, it } from 'bun:test';

const adminEmail = `top-up-admin-test-${crypto.randomUUID()}@example.com`;
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
      name: 'TopUp Admin',
      firstName: 'TopUp',
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

describe('Admin Top-Up API routes', () => {
  it('requires Admin authentication for all routes', async () => {
    const fakeId = crypto.randomUUID();
    const unauthenticatedReconcile = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${fakeId}/reconcile`, {
        method: 'POST',
      }),
    );
    expect(unauthenticatedReconcile.status).toBe(401);

    const unauthenticatedRetry = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/events/${fakeId}/retry`, {
        method: 'POST',
      }),
    );
    expect(unauthenticatedRetry.status).toBe(401);
  });

  it('returns 404 when reconciling a non-existent Top-Up', async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/${fakeId}/reconcile`, {
        method: 'POST',
        headers: { cookie: adminCookie },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 when retrying a non-existent provider event', async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/top-ups/events/${fakeId}/retry`, {
        method: 'POST',
        headers: { cookie: adminCookie },
      }),
    );
    expect(response.status).toBe(404);
  });
});
