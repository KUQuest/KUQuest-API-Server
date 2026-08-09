import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  getAcademicOptions,
  getOnboardingData,
  updateOnboardingInfo,
} from '@/modules/onboarding/onboarding.service';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';

const studentA = `test-onboarding-a-${randomUUID()}`;
const studentB = `test-onboarding-b-${randomUUID()}`;
const studentC = `test-onboarding-c-${randomUUID()}`;
const studentD = `test-onboarding-d-${randomUUID()}`;
const studentAId = `65${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const studentBId = `66${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

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
      studentId: studentAId,
    },
    {
      id: studentB,
      email: `${studentB}@ku.th`,
      firstName: 'Student',
      lastName: 'Two',
      studentId: studentBId,
    },
    {
      id: studentC,
      email: `${studentC}@ku.th`,
      firstName: 'Student',
      lastName: 'Three',
    },
    {
      id: studentD,
      email: `${studentD}@ku.th`,
      firstName: 'Student',
      lastName: 'Four',
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(authUser)
    .where(inArray(authUser.id, [studentA, studentB, studentC, studentD]));
});

describe('onboarding academic options', () => {
  it('groups the seeded Sriracha Engineering programs under their faculty', async () => {
    const options = await getAcademicOptions();

    expect(options.find(({ name }) => name === 'Engineering at Sriracha')).toMatchObject({
      name: 'Engineering at Sriracha',
      departments: [
        { name: 'Automotive Engineering' },
        { name: 'Digital Manufacturing System Engineering' },
        { name: 'Robotic and Automation Systems Engineering' },
      ],
    });

    expect(options.find(({ name }) => name === 'Engineering')?.departments).toContainEqual({
      id: expect.any(String),
      name: 'Engineering',
    });
  });
});

describe('updating onboarding information', () => {
  it('persists a partial update and returns all collected fields', async () => {
    const options = await getAcademicOptions();
    const departmentId = options
      .find(({ name }) => name === 'Engineering at Sriracha')
      ?.departments.find(({ name }) => name === 'Automotive Engineering')?.id;

    expect(departmentId).toBeDefined();
    expect(
      await updateOnboardingInfo(studentA, {
        academicYear: 2026,
        departmentId: departmentId!,
        telephone: '080-000-0000',
      }),
    ).toBe('ok');

    expect(await getOnboardingData(studentA)).toMatchObject({
      academicYear: 2026,
      departmentId,
      studentId: studentAId,
      telephone: '080-000-0000',
    });
  });

  it('rejects a student ID already held by another Student', async () => {
    expect(await updateOnboardingInfo(studentA, { studentId: studentBId })).toBe(
      'STUDENT_ID_ALREADY_EXISTS',
    );
  });

  it('does not require a Student to complete every onboarding field', async () => {
    expect(await updateOnboardingInfo(studentB, { academicYear: 2026 })).toBe('ok');
    expect(await getOnboardingData(studentB)).toMatchObject({
      academicYear: 2026,
      departmentId: null,
      telephone: null,
    });
  });

  it('leaves every omitted field untouched', async () => {
    const departmentId = (await getAcademicOptions())
      .find(({ departments }) => departments.length > 0)
      ?.departments[0]?.id;

    expect(departmentId).toBeDefined();
    expect(
      await updateOnboardingInfo(studentA, {
        academicYear: 2026,
        departmentId: departmentId!,
        telephone: '080-000-0000',
      }),
    ).toBe('ok');

    expect(await updateOnboardingInfo(studentA, { academicYear: 2027 })).toBe('ok');

    expect(await getOnboardingData(studentA)).toMatchObject({
      academicYear: 2027,
      departmentId,
      studentId: studentAId,
      telephone: '080-000-0000',
    });
  });

  it('replaces stored non-null values with other valid values', async () => {
    const departments = (await getAcademicOptions()).flatMap(({ departments }) => departments);
    const replacementDepartmentId = departments[1]?.id;

    expect(replacementDepartmentId).toBeDefined();
    expect(
      await updateOnboardingInfo(studentA, {
        departmentId: replacementDepartmentId!,
        telephone: '090-111-2222',
      }),
    ).toBe('ok');

    expect(await getOnboardingData(studentA)).toMatchObject({
      departmentId: replacementDepartmentId,
      telephone: '090-111-2222',
    });
  });

  it('rejects a department that does not exist', async () => {
    expect(await updateOnboardingInfo(studentA, { departmentId: randomUUID() })).toBe(
      'DEPARTMENT_NOT_FOUND',
    );
  });

  it('reports a missing Student record rather than creating one', async () => {
    expect(await updateOnboardingInfo(`missing-${randomUUID()}`, { academicYear: 2026 })).toBe(
      'USER_NOT_FOUND',
    );
  });

  // Both claims are issued together, but the pool serialises them, so the pre-check catches
  // the loser and the database index is never reached. The index itself is pinned in
  // tests/database/auth-schema.test.ts instead.
  it('lets only one of two parallel claims take the same student ID', async () => {
    const contestedId = `67${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

    const results = await Promise.all([
      updateOnboardingInfo(studentC, { studentId: contestedId }),
      updateOnboardingInfo(studentD, { studentId: contestedId }),
    ]);

    expect([...results].sort()).toEqual(['STUDENT_ID_ALREADY_EXISTS', 'ok']);

    const stored = await Promise.all([
      getOnboardingData(studentC),
      getOnboardingData(studentD),
    ]);

    expect(new Set(stored.map((student) => student?.studentId))).toEqual(
      new Set([contestedId, null]),
    );
  });
});
