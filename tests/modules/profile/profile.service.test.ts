import { db, sql } from '@/database/client';
import { faculty, major } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  getProfile,
  replaceStudentAvatar,
  updateProfile,
} from '@/modules/profile/profile.service';

import { randomUUID } from 'node:crypto';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

const studentA = `test-profile-a-${randomUUID()}`;
const studentB = `test-profile-b-${randomUUID()}`;

let facultyId: string;
let majorId: string;
let facultyName: string;
let avatarFileId: string;
let tombstonedFileId: string;

const avatarObject = { bucket: 'kuquest-test', objectKey: `avatars/${studentA}/current.png` };

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
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
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

  [{ id: avatarFileId }] = await db
    .insert(file)
    .values({
      ...avatarObject,
      contentType: 'image/png',
      sizeBytes: 1024,
      uploadedByUserId: studentA,
    })
    .returning({ id: file.id });

  [{ id: tombstonedFileId }] = await db
    .insert(file)
    .values({
      bucket: avatarObject.bucket,
      objectKey: `avatars/${studentA}/deleted.png`,
      contentType: 'image/png',
      sizeBytes: 1024,
      uploadedByUserId: studentA,
      deletedAt: new Date(),
    })
    .returning({ id: file.id });
});

beforeEach(async () => {
  await db
    .update(authUser)
    .set({ ...startingState[studentA]!, imageFileId: null })
    .where(eq(authUser.id, studentA));
  await db
    .update(authUser)
    .set({ ...startingState[studentB]!, imageFileId: null })
    .where(eq(authUser.id, studentB));
});

afterAll(async () => {
  // The student points at the file and the file points back at the student, so the
  // pointer has to go before either row can.
  await db
    .update(authUser)
    .set({ imageFileId: null })
    .where(inArray(authUser.id, [studentA, studentB]));
  await db.delete(file).where(inArray(file.id, [avatarFileId, tombstonedFileId]));
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

describe('reading the avatar', () => {
  it('returns the stored reference when the student has an avatar', async () => {
    await db
      .update(authUser)
      .set({ imageFileId: avatarFileId })
      .where(eq(authUser.id, studentA));

    const profile = await getProfile(studentA);

    expect(profile?.avatar).toEqual({ fileId: avatarFileId, ...avatarObject });
  });

  it('reports no avatar when the student has none', async () => {
    const profile = await getProfile(studentB);

    expect(profile?.avatar).toBeNull();
  });

  it('treats a deleted avatar as no avatar at all', async () => {
    await db
      .update(authUser)
      .set({ imageFileId: tombstonedFileId })
      .where(eq(authUser.id, studentA));

    const profile = await getProfile(studentA);

    expect(profile?.avatar).toBeNull();
  });

  it('never exposes another student avatar', async () => {
    await db
      .update(authUser)
      .set({ imageFileId: avatarFileId })
      .where(eq(authUser.id, studentA));

    expect((await getProfile(studentB))?.avatar).toBeNull();
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

  it('leaves the avatar alone', async () => {
    await db
      .update(authUser)
      .set({ imageFileId: avatarFileId })
      .where(eq(authUser.id, studentA));

    await updateProfile(studentA, { bio: 'a new bio' });

    expect((await getProfile(studentA))?.avatar).toEqual({
      fileId: avatarFileId,
      ...avatarObject,
    });
  });

  it('changes nothing when asked to change nothing', async () => {
    const before = await getProfile(studentA);

    await updateProfile(studentA, {});

    expect(await getProfile(studentA)).toEqual(before!);
  });

  it('reports the student was found when something changed', async () => {
    expect(await updateProfile(studentA, { bio: 'changed' })).toBe('updated');
  });

  it('reports the student was found even when nothing changed', async () => {
    expect(await updateProfile(studentA, {})).toBe('updated');
  });

  it('refuses to call a write that matched nobody a success', async () => {
    expect(await updateProfile(randomUUID(), { bio: 'nobody' })).toBe('student-not-found');
  });

  it('refuses an empty update against a student that does not exist', async () => {
    expect(await updateProfile(randomUUID(), {})).toBe('student-not-found');
  });
});

describe('choosing a major', () => {
  it('accepts a major that exists', async () => {
    expect(await updateProfile(studentB, { majorId })).toBe('updated');
    expect((await getProfile(studentB))?.major?.id).toBe(majorId);
  });

  it('refuses a major that does not exist, without leaving the profile changed', async () => {
    const before = await getProfile(studentA);

    expect(await updateProfile(studentA, { bio: 'new', majorId: randomUUID() })).toBe(
      'major-not-found',
    );
    expect(await getProfile(studentA)).toEqual(before!);
  });
});

describe('profile avatar persistence', () => {
  afterEach(() => {
    mock.restore();
  });

  it('creates file metadata and updates only the Student file pointer', async () => {
    const insertValues = mock((_value: unknown) => ({
      returning: mock(async () => [{ fileId: '018f47a7-1c7d-7c98-9a11-690d7e83430c' }]),
    }));
    const updateValues = mock(() => ({
      where: mock(async () => undefined),
    }));
    const transaction = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(() => ({
              for: mock(async () => [{ id: 'student-1', previousFileId: null }]),
            })),
          })),
        })),
      })),
      insert: mock(() => ({ values: insertValues })),
      update: mock(() => ({ set: updateValues })),
    };
    spyOn(db, 'transaction').mockImplementation(
      (async (callback: (value: unknown) => Promise<unknown>) =>
        callback(transaction)) as never,
    );

    const result = await replaceStudentAvatar('student-1', {
      bucket: 'kuquest',
      objectKey: 'avatars/student-1/new.png',
      contentType: 'image/png',
      sizeBytes: 123,
    });

    expect(result).toEqual({
      fileId: '018f47a7-1c7d-7c98-9a11-690d7e83430c',
      previousFileId: null,
    });
    expect(insertValues).toHaveBeenCalledWith({
      bucket: 'kuquest',
      objectKey: 'avatars/student-1/new.png',
      contentType: 'image/png',
      sizeBytes: 123,
      uploadedByUserId: 'student-1',
    });
    expect(updateValues).toHaveBeenCalledWith({
      imageFileId: '018f47a7-1c7d-7c98-9a11-690d7e83430c',
    });
  });
});
