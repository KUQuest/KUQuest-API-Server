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

describe('onboarding academic options', () => {
  it('groups the seeded Sriracha Engineering programs under their faculty', async () => {
    const options = await getAcademicOptions();

    expect(options.find(({ name }) => name === 'Engineering at Sriracha')).toMatchObject({
      name: 'Engineering at Sriracha',
      majors: [
        { name: 'Automotive Engineering' },
        { name: 'Digital Manufacturing System Engineering' },
        { name: 'Robotic and Automation Systems Engineering' },
      ],
    });

    expect(options.find(({ name }) => name === 'Engineering')?.majors).toContainEqual({
      id: expect.any(String),
      name: 'Engineering',
    });
  });
});

describe('updating onboarding information', () => {
  it('persists a partial update and returns all collected fields', async () => {
    const options = await getAcademicOptions();
    const majorId = options
      .find(({ name }) => name === 'Engineering at Sriracha')
      ?.majors.find(({ name }) => name === 'Automotive Engineering')?.id;

    expect(majorId).toBeDefined();
    expect(
      await updateOnboardingInfo(studentA, {
        academicYear: 2026,
        majorId: majorId!,
        telephone: '080-000-0000',
      }),
    ).toBe('ok');

    expect(await getOnboardingData(studentA)).toMatchObject({
      academicYear: 2026,
      majorId,
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
      majorId: null,
      telephone: null,
    });
  });
});
