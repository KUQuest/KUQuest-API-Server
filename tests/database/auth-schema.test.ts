import { db, sql } from '@/database/client';
import {
  authAccount,
  authAdmin,
  authSession,
  authUser,
} from '@/database/schema/auth.schema';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, getTableColumns, inArray } from 'drizzle-orm';

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

const holder = randomUUID();
const claimant = randomUUID();
const unonboardedA = randomUUID();
const unonboardedB = randomUUID();
const heldStudentId = `65${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

const seedUser = (id: string, studentId?: string) => ({
  id,
  email: `${id}@ku.th`,
  firstName: 'Student',
  lastName: 'Schema',
  ...(studentId ? { studentId } : {}),
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

  it('leaves every onboarding field nullable, so no Student is forced to complete them', () => {
    const columns = getTableColumns(authUser);

    expect(columns.studentId.notNull).toBe(false);
    expect(columns.telephone.notNull).toBe(false);
    expect(columns.departmentId.notNull).toBe(false);
    expect(columns.academicYear.notNull).toBe(false);
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

describe('auth_session ownership (QA-36)', () => {
  it('rejects a session row owned by neither a Student nor an Admin', async () => {
    const error = await db
      .insert(authSession)
      .values({ token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as { cause?: { code?: string; constraint_name?: string } }).cause).toMatchObject({
      code: '23514',
      constraint_name: 'auth_session_check',
    });
  });

  it('rejects a session row owned by both a Student and an Admin', async () => {
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
        .insert(authSession)
        .values({
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
          userId: student.id,
          adminId: admin.id,
        })
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as { cause?: { code?: string; constraint_name?: string } }).cause).toMatchObject({
        code: '23514',
        constraint_name: 'auth_session_check',
      });
    } finally {
      await db.delete(authUser).where(eq(authUser.id, student.id));
      await db.delete(authAdmin).where(eq(authAdmin.id, admin.id));
    }
  });
});

describe('student ID uniqueness', () => {
  beforeAll(async () => {
    try {
      await sql`select 1`;
    } catch (cause) {
      throw new Error(
        'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
        { cause },
      );
    }

    await db.insert(authUser).values(seedUser(holder, heldStudentId));
  });

  afterAll(async () => {
    await db
      .delete(authUser)
      .where(inArray(authUser.id, [holder, claimant, unonboardedA, unonboardedB]));
  });

  // onboarding.service.ts matches this exact code and constraint name to turn a lost race
  // into STUDENT_ID_ALREADY_EXISTS; renaming the index there would silently break it.
  it('raises 23505 on auth_user_student_id_uidx for a duplicate student ID', async () => {
    const error = await db
      .insert(authUser)
      .values(seedUser(claimant, heldStudentId))
      .then(() => undefined)
      .catch((cause: unknown) => cause);

    // Drizzle wraps the driver error, so the code and constraint sit one level down in
    // `cause` — the level onboarding.service.ts walks to. postgres.js reports the name as
    // `constraint_name`, which is why that service reads both spellings.
    const driverError = (error as { cause?: { code?: string; constraint_name?: string } })?.cause;

    expect(driverError?.code).toBe('23505');
    expect(driverError?.constraint_name).toBe('auth_user_student_id_uidx');
  });

  it('exempts unonboarded Students, so many rows may hold a null student ID', async () => {
    await db.insert(authUser).values([seedUser(unonboardedA), seedUser(unonboardedB)]);

    const stored = await db
      .select({ id: authUser.id, studentId: authUser.studentId })
      .from(authUser)
      .where(inArray(authUser.id, [unonboardedA, unonboardedB]));

    expect(stored).toHaveLength(2);
    expect(stored.every(({ studentId }) => studentId === null)).toBe(true);
  });
});
