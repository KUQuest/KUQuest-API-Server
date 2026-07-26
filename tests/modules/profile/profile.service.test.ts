import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { db, sql } from '@/database/client';
import { faculty, major } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { getProfile, majorExists, updateProfile } from '@/modules/profile/profile.service';

import { eq, inArray } from 'drizzle-orm';

const studentA = `test-profile-a-${randomUUID()}`;
const studentB = `test-profile-b-${randomUUID()}`;

let facultyId: string;
let majorId: string;
let facultyName: string;

// Every test starts from these values, so no test depends on what an earlier one wrote.
const startingState = {
  [studentA]: { firstName: 'Student', lastName: 'One', bio: 'first bio', telephone: '0800000001' },
  [studentB]: { firstName: 'Student', lastName: 'Two', bio: 'second bio', telephone: '0800000002' },
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }

  facultyName = `Test Faculty ${randomUUID()}`;

  [{ id: facultyId }] = await db
    .insert(faculty)
    .values({ name: facultyName })
    .returning({ id: faculty.id });

  [{ id: majorId }] = await db
    .insert(major)
    .values({ facultyId, name: 'Test Major' })
    .returning({ id: major.id });

  await db.insert(authUser).values([
    {
      id: studentA,
      email: `${studentA}@ku.th`,
      ...startingState[studentA]!,
      studentId: `65${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      majorId,
    },
    {
      id: studentB,
      email: `${studentB}@ku.th`,
      ...startingState[studentB]!,
    },
  ]);
});

beforeEach(async () => {
  await db.update(authUser).set(startingState[studentA]!).where(eq(authUser.id, studentA));
  await db.update(authUser).set(startingState[studentB]!).where(eq(authUser.id, studentB));
});

afterAll(async () => {
  await db.delete(authUser).where(inArray(authUser.id, [studentA, studentB]));
  await db.delete(major).where(eq(major.id, majorId));
  await db.delete(faculty).where(eq(faculty.id, facultyId));
});

describe('reading a profile', () => {
  it('returns only the requesting student, never another', async () => {
    const profile = await getProfile(studentA);

    expect(profile?.email).toBe(`${studentA}@ku.th`);
    expect(profile?.lastName).toBe('One');
    expect(profile?.telephone).toBe('0800000001');
  });

  it('resolves the major and its faculty to names', async () => {
    const profile = await getProfile(studentA);

    expect(profile?.major).toEqual({
      id: majorId,
      name: 'Test Major',
      faculty: { name: facultyName },
    });
  });

  it('reports no major rather than a hollow one when none is chosen', async () => {
    const profile = await getProfile(studentB);

    expect(profile?.major).toBeNull();
  });

  it('finds nothing for a student that does not exist', async () => {
    expect(await getProfile(randomUUID())).toBeUndefined();
  });
});

describe('updating a profile', () => {
  it('leaves every other student untouched', async () => {
    const before = await getProfile(studentB);

    await updateProfile(studentA, {
      firstName: 'Renamed',
      bio: 'rewritten',
      telephone: '0899999999',
    });

    expect(await getProfile(studentB)).toEqual(before!);
  });

  it('keeps the fields the request left out', async () => {
    await updateProfile(studentA, { bio: 'only the bio changes' });

    const profile = await getProfile(studentA);

    expect(profile?.bio).toBe('only the bio changes');
    expect(profile?.telephone).toBe(startingState[studentA]!.telephone);
    expect(profile?.firstName).toBe(startingState[studentA]!.firstName);
    expect(profile?.major?.id).toBe(majorId);
  });

  it('changes nothing when asked to change nothing', async () => {
    const before = await getProfile(studentA);

    await updateProfile(studentA, {});

    expect(await getProfile(studentA)).toEqual(before!);
  });

  it('reports the student was found when something changed', async () => {
    expect(await updateProfile(studentA, { bio: 'changed' })).toBe(true);
  });

  it('reports the student was found even when nothing changed', async () => {
    expect(await updateProfile(studentA, {})).toBe(true);
  });

  it('refuses to call a write that matched nobody a success', async () => {
    expect(await updateProfile(randomUUID(), { bio: 'nobody' })).toBe(false);
  });

  it('refuses an empty update against a student that does not exist', async () => {
    expect(await updateProfile(randomUUID(), {})).toBe(false);
  });
});

describe('checking a major', () => {
  it('recognises a major that exists', async () => {
    expect(await majorExists(majorId)).toBe(true);
  });

  it('rejects a major that does not exist', async () => {
    expect(await majorExists(randomUUID())).toBe(false);
  });
});
