import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { enabledAdminGuard } from '@/modules/auth/admin-auth.guard';
import { app } from '@/app';
import { db, sql } from '@/database/client';
import {
  authAccount,
  authAdmin,
  authSession,
} from '@/database/schema/auth.schema';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

const adminEmail = `admin-${randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
const protectedAdminApp = new Elysia({ name: 'admin-auth-test-app' })
  .use(enabledAdminGuard)
  .get('/admin-only', ({ admin }) => ({ email: admin.email }));

let adminId: string;

const requestAdminLogin = (password: string) =>
  app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password }),
    }),
  );

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }

  const seedAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const result = await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Test',
      firstName: 'Test',
      lastName: 'Admin',
    },
  });

  adminId = result.user.id;
});

beforeEach(async () => {
  await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, adminId));
});

afterAll(async () => {
  if (!adminId) return;

  await db.delete(authSession).where(eq(authSession.adminId, adminId));
  await db.delete(authAccount).where(eq(authAccount.adminId, adminId));
  await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
});

describe('Admin authentication with PostgreSQL', () => {
  it('signs in with credentials and creates an admin-owned session', async () => {
    const response = await requestAdminLogin(adminPassword);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user.email).toBe(adminEmail);
    expect(getCookieHeader(response)).toContain('kuquest-admin.session_token=');

    const sessions = await db
      .select({ userId: authSession.userId, adminId: authSession.adminId })
      .from(authSession)
      .where(eq(authSession.adminId, adminId));

    expect(sessions).toContainEqual({ userId: null, adminId });
  });

  it('rejects an invalid password without creating another session', async () => {
    const before = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.adminId, adminId));

    const response = await requestAdminLogin('WrongPass1!');

    expect(response.status).toBe(401);

    const after = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.adminId, adminId));

    expect(after).toHaveLength(before.length);
  });

  it('allows a valid Admin session through adminAuthenticationGuard', async () => {
    const loginResponse = await requestAdminLogin(adminPassword);
    const cookie = getCookieHeader(loginResponse);
    const response = await protectedAdminApp.handle(
      new Request('http://localhost/admin-only', {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: adminEmail });
  });

  it('rejects a Student cookie on an Admin-protected route', async () => {
    const response = await protectedAdminApp.handle(
      new Request('http://localhost/admin-only', {
        headers: { cookie: '__Secure-better-auth.session_token=student-session' },
      }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects a disabled Admin with the disabled error', async () => {
    await db
      .update(authAdmin)
      .set({ disabledAt: new Date() })
      .where(eq(authAdmin.id, adminId));

    const loginResponse = await requestAdminLogin(adminPassword);
    const cookie = getCookieHeader(loginResponse);
    const response = await protectedAdminApp.handle(
      new Request('http://localhost/admin-only', {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'ADMIN_DISABLED', message: 'Admin account is disabled' },
    });
  });
});
