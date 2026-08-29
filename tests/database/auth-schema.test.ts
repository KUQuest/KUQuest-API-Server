import { db, sql } from '@/database/client';
import { authAccount, authAdmin, authUser } from '@/database/schema/auth.schema';

import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq, getTableColumns } from 'drizzle-orm';

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }
});

describe('authentication database schema', () => {
  it('uses the requested user database columns', () => {
    const columns = getTableColumns(authUser);

    expect(columns.id.name).toBe('id');
    expect(columns.id.primary).toBe(true);
    expect(columns.firstName.name).toBe('first_name');
    expect(columns.lastName.name).toBe('last_name');
  });

  it('stores Academic Registration fields renamed/added for BE-94', () => {
    const columns = getTableColumns(authUser);

    expect(columns.departmentId.name).toBe('department_id');
    expect(columns.occupationId.name).toBe('occupation_id');
    expect(columns.termsAcceptedAt.name).toBe('terms_accepted_at');
    expect(columns.termsVersion.name).toBe('terms_version');
    expect(columns).not.toHaveProperty('majorId');
  });
});

describe('auth_account ownership and provider constraints (QA-44)', () => {
  it('rejects an account row owned by neither a Student nor an Admin', async () => {
    const error = await db
      .insert(authAccount)
      .values({ accountId: randomUUID(), providerId: 'credential' })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as { cause?: { code?: string; constraint_name?: string } }).cause).toMatchObject({
      code: '23514',
      constraint_name: 'auth_account_check',
    });
  });

  it('rejects an account row owned by both a Student and an Admin', async () => {
    const [student] = await db
      .insert(authUser)
      .values({ email: `${randomUUID()}@ku.th`, firstName: 'Owns', lastName: 'Both' })
      .returning({ id: authUser.id });
    const [admin] = await db
      .insert(authAdmin)
      .values({ email: `${randomUUID()}@example.com`, firstName: 'Owns', lastName: 'Both' })
      .returning({ id: authAdmin.id });

    try {
      const error = await db
        .insert(authAccount)
        .values({
          accountId: randomUUID(),
          providerId: 'credential',
          userId: student.id,
          adminId: admin.id,
        })
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as { cause?: { code?: string; constraint_name?: string } }).cause).toMatchObject({
        code: '23514',
        constraint_name: 'auth_account_check',
      });
    } finally {
      await db.delete(authUser).where(eq(authUser.id, student.id));
      await db.delete(authAdmin).where(eq(authAdmin.id, admin.id));
    }
  });

  it('rejects an Admin-owned account on a non-credential provider', async () => {
    const [admin] = await db
      .insert(authAdmin)
      .values({ email: `${randomUUID()}@example.com`, firstName: 'Google', lastName: 'Admin' })
      .returning({ id: authAdmin.id });

    try {
      const error = await db
        .insert(authAccount)
        .values({ accountId: randomUUID(), providerId: 'google', adminId: admin.id })
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as { cause?: { code?: string; constraint_name?: string } }).cause).toMatchObject({
        code: '23514',
        constraint_name: 'auth_account_check1',
      });
    } finally {
      await db.delete(authAdmin).where(eq(authAdmin.id, admin.id));
    }
  });
});
