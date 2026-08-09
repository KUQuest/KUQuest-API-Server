import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { updateOnboarding } from '@/modules/onboarding/onboarding.controller';
import { getAcademicOptions } from '@/modules/onboarding/onboarding.service';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';

const studentA = `test-onboarding-controller-a-${randomUUID()}`;
const studentB = `test-onboarding-controller-b-${randomUUID()}`;
const takenStudentId = `65${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

const invokeUpdate = (userId: string, body: Parameters<typeof updateOnboarding>[0]['body']) => {
  const set: { status?: number | string } = {};

  return {
    result: updateOnboarding({
      body,
      session: { user: { id: userId } } as never,
      set: set as never,
    }),
    set,
  };
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }

  await db.insert(authUser).values([
    {
      id: studentA,
      email: `${studentA}@ku.th`,
      firstName: 'Student',
      lastName: 'One',
      studentId: takenStudentId,
    },
    {
      id: studentB,
      email: `${studentB}@ku.th`,
      firstName: 'Student',
      lastName: 'Two',
    },
  ]);
});

afterAll(async () => {
  await db.delete(authUser).where(inArray(authUser.id, [studentA, studentB]));
});

describe('updateOnboarding', () => {
  it('answers a successful update with the bare success envelope', async () => {
    const { result, set } = invokeUpdate(studentB, { academicYear: 2026 });

    expect(await result).toEqual({ success: true });
    expect(set.status).toBeUndefined();
  });

  it('answers a missing user with 404', async () => {
    const { result, set } = invokeUpdate(`missing-${randomUUID()}`, { academicYear: 2026 });

    expect(await result).toEqual({
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    });
    expect(set.status).toBe(404);
  });

  it('answers an unknown department with 400', async () => {
    const { result, set } = invokeUpdate(studentB, { departmentId: randomUUID() });

    expect(await result).toEqual({
      success: false,
      error: { code: 'DEPARTMENT_NOT_FOUND', message: 'Department not found' },
    });
    expect(set.status).toBe(400);
  });

  it('answers a student ID held by another Student with 409', async () => {
    const { result, set } = invokeUpdate(studentB, { studentId: takenStudentId });

    expect(await result).toEqual({
      success: false,
      error: { code: 'STUDENT_ID_ALREADY_EXISTS', message: 'Student ID already exists' },
    });
    expect(set.status).toBe(409);
  });

  it('accepts a department that exists', async () => {
    const departmentId = (await getAcademicOptions())
      .find(({ departments }) => departments.length > 0)
      ?.departments[0]?.id;

    expect(departmentId).toBeDefined();

    const { result, set } = invokeUpdate(studentB, { departmentId: departmentId! });

    expect(await result).toEqual({ success: true });
    expect(set.status).toBeUndefined();
  });
});
