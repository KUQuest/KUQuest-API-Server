import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  getAcademicRegistrationOptions,
  getAcademicRegistrationStatus,
  updateAcademicRegistration,
} from '@/modules/academic-registration/academic-registration.service';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';

const studentA = `test-academic-registration-a-${randomUUID()}`;
const studentB = `test-academic-registration-b-${randomUUID()}`;
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
  ]);
});

afterAll(async () => {
  await db.delete(authUser).where(inArray(authUser.id, [studentA, studentB]));
});

describe('academic registration options', () => {
  it('lists the seeded occupations with their studentId requirement', async () => {
    const options = await getAcademicRegistrationOptions();

    expect(options.occupations).toContainEqual({
      id: expect.any(String),
      name: 'Student',
      requiresStudentId: true,
    });
    expect(options.occupations).toContainEqual({
      id: expect.any(String),
      name: 'Teacher',
      requiresStudentId: false,
    });
  });

  it('groups the seeded Sriracha Engineering programs under their faculty', async () => {
    const options = await getAcademicRegistrationOptions();

    expect(
      options.faculties.find(({ name }) => name === 'Engineering at Sriracha'),
    ).toMatchObject({
      name: 'Engineering at Sriracha',
      departments: [
        { name: 'Automotive Engineering' },
        { name: 'Digital Manufacturing System Engineering' },
        { name: 'Robotic and Automation Systems Engineering' },
      ],
    });
  });
});

describe('updating academic registration', () => {
  it('persists a partial update and stamps terms acceptance server-side', async () => {
    const options = await getAcademicRegistrationOptions();
    const departmentId = options.faculties
      .find(({ name }) => name === 'Engineering at Sriracha')
      ?.departments.find(({ name }) => name === 'Automotive Engineering')?.id;
    const occupationId = options.occupations.find(({ name }) => name === 'Student')?.id;

    expect(departmentId).toBeDefined();
    expect(occupationId).toBeDefined();

    const before = Date.now();
    expect(
      await updateAcademicRegistration(studentA, {
        telephone: '0800000000',
        departmentId: departmentId!,
        occupationId: occupationId!,
        termsVersion: '2026-01-01',
      }),
    ).toBe('updated');

    const status = await getAcademicRegistrationStatus(studentA);
    expect(status).toMatchObject({
      telephone: '0800000000',
      departmentId,
      occupationId,
      studentId: studentAId,
      termsVersion: '2026-01-01',
      completed: true,
    });
    expect(status?.termsAcceptedAt).toBeInstanceOf(Date);
    expect(status!.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does not require every field to be set at once', async () => {
    expect(await updateAcademicRegistration(studentB, { telephone: '0800000001' })).toBe(
      'updated',
    );

    const status = await getAcademicRegistrationStatus(studentB);
    expect(status).toMatchObject({
      telephone: '0800000001',
      departmentId: null,
      occupationId: null,
      completed: false,
    });
  });

  it('rejects an unknown department', async () => {
    expect(
      await updateAcademicRegistration(studentB, { departmentId: randomUUID() }),
    ).toBe('department-not-found');
  });

  it('rejects an unknown occupation', async () => {
    expect(
      await updateAcademicRegistration(studentB, { occupationId: randomUUID() }),
    ).toBe('occupation-not-found');
  });

  it('rejects a student ID already held by another Student', async () => {
    expect(
      await updateAcademicRegistration(studentB, { studentId: studentAId }),
    ).toBe('student-id-already-exists');
  });

  it('reports not found for a missing Student', async () => {
    expect(
      await updateAcademicRegistration(randomUUID(), { telephone: '0800000002' }),
    ).toBe('student-not-found');
  });
});

describe('academic registration completeness', () => {
  it('is not completed when the chosen Occupation requires a Student ID that is missing', async () => {
    const options = await getAcademicRegistrationOptions();
    const departmentId = options.faculties
      .find(({ name }) => name === 'Engineering at Sriracha')
      ?.departments.find(({ name }) => name === 'Automotive Engineering')?.id;
    const studentOccupationId = options.occupations.find(({ name }) => name === 'Student')?.id;
    const teacherOccupationId = options.occupations.find(({ name }) => name === 'Teacher')?.id;

    const teacher = `test-academic-registration-teacher-${randomUUID()}`;
    await db.insert(authUser).values({
      id: teacher,
      email: `${teacher}@ku.th`,
      firstName: 'Teacher',
      lastName: 'One',
    });

    try {
      await updateAcademicRegistration(teacher, {
        telephone: '0800000003',
        departmentId: departmentId!,
        occupationId: studentOccupationId!,
        termsVersion: '2026-01-01',
      });
      expect((await getAcademicRegistrationStatus(teacher))?.completed).toBe(false);

      await updateAcademicRegistration(teacher, { occupationId: teacherOccupationId! });
      expect((await getAcademicRegistrationStatus(teacher))?.completed).toBe(true);
    } finally {
      await db.delete(authUser).where(inArray(authUser.id, [teacher]));
    }
  });
});
