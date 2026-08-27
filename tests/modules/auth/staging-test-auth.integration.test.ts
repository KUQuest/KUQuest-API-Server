import { app } from '@/app';
import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { authPlugin, createStagingTestAuthRoute } from '@/modules/auth';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { afterAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

const testEmail = `staging-test-${randomUUID()}@ku.th`;
const testPassword = 'TestStudent1!';
const stagingTestApp = new Elysia({ name: 'staging-test-auth-integration' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: testEmail,
    password: testPassword,
    firstName: 'Staging',
    lastName: 'Test Student',
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

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

afterAll(async () => {
  await db.delete(authUser).where(eq(authUser.email, testEmail));
});

describe('staging test authentication', () => {
  it('is unavailable when the staging flag is off', async () => {
    const response = await app.handle(
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

    const profileResponse = await app.handle(
      new Request('http://localhost/api/v1/profile', {
        headers: { cookie: getCookieHeader(loginResponse) },
      }),
    );

    expect(profileResponse.status).toBe(200);
    expect((await profileResponse.json()).success).toBe(true);
  });
});
