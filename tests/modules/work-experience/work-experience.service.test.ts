import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { profileWorkExperience } from '@/database/schema/profile.schema';
import {
  createWorkExperience,
  deleteWorkExperience,
  listWorkExperiences,
  updateWorkExperience,
} from '@/modules/work-experience/work-experience.service';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';

const studentA = `test-work-experience-a-${randomUUID()}`;
const studentB = `test-work-experience-b-${randomUUID()}`;

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
    { id: studentA, email: `${studentA}@ku.th`, firstName: 'Student', lastName: 'A' },
    { id: studentB, email: `${studentB}@ku.th`, firstName: 'Student', lastName: 'B' },
  ]);
});

beforeEach(async () => {
  await db
    .delete(profileWorkExperience)
    .where(inArray(profileWorkExperience.userId, [studentA, studentB]));
});

afterAll(async () => {
  await db
    .delete(profileWorkExperience)
    .where(inArray(profileWorkExperience.userId, [studentA, studentB]));
  await db.delete(authUser).where(inArray(authUser.id, [studentA, studentB]));
});

const experience = (overrides: Partial<Parameters<typeof createWorkExperience>[1]> = {}) => ({
  title: 'Frontend Developer Intern',
  employmentType: 'Internship',
  organization: 'Tech Startup Inc.',
  description: 'Developed responsive UI components.',
  startedAt: '2023-06-01',
  endedAt: '2023-08-31',
  ...overrides,
});

const createValidExperience = async (
  userId: string,
  data = experience(),
) => {
  const created = await createWorkExperience(userId, data);
  if ('outcome' in created) throw new Error(`Unexpected outcome: ${created.outcome}`);
  return created;
};

describe('work experience persistence', () => {
  it('creates and lists only the authenticated student entries', async () => {
    const created = await createValidExperience(studentA);

    expect(created).toMatchObject({
      title: 'Frontend Developer Intern',
      employmentType: 'Internship',
      organization: 'Tech Startup Inc.',
      startedAt: '2023-06-01',
      endedAt: '2023-08-31',
    });
    expect(created).not.toHaveProperty('userId');
    expect(await listWorkExperiences(studentB)).toEqual([]);
  });

  it('sorts by newest start date, then creation time, then id', async () => {
    await createValidExperience(studentA, experience({
      title: 'Older role',
      startedAt: '2022-01-01',
      endedAt: null,
    }));
    await createValidExperience(studentA, experience({
      title: 'Newer role',
      startedAt: '2024-01-01',
      endedAt: null,
    }));

    expect((await listWorkExperiences(studentA)).map(({ title }) => title)).toEqual([
      'Newer role',
      'Older role',
    ]);
  });

  it('updates only an owned entry and supports Present by clearing endedAt', async () => {
    const created = await createValidExperience(studentA);

    const updated = await updateWorkExperience(studentA, created!.id, {
      title: 'Senior Peer Tutor',
      endedAt: null,
    });

    expect(updated).toMatchObject({
      title: 'Senior Peer Tutor',
      organization: 'Tech Startup Inc.',
      endedAt: null,
    });
    expect(await updateWorkExperience(studentB, created!.id, { title: 'Hijacked' })).toBeUndefined();
  });

  it('deletes only an owned entry', async () => {
    const created = await createValidExperience(studentA);

    expect(await deleteWorkExperience(studentB, created!.id)).toBeUndefined();
    expect(await deleteWorkExperience(studentA, created!.id)).toEqual({ id: created!.id });
    expect(await listWorkExperiences(studentA)).toEqual([]);
  });

  it('rejects an ended date earlier than the start date before persistence', async () => {
    expect(await createWorkExperience(studentA, experience({
      startedAt: '2024-01-02',
      endedAt: '2024-01-01',
    }))).toEqual({ outcome: 'invalid-date-range' });
    expect(await listWorkExperiences(studentA)).toEqual([]);
  });

  it('accepts equal start and end dates and rejects an invalid PATCH range', async () => {
    const created = await createValidExperience(studentA, experience({
      startedAt: '2024-01-01',
      endedAt: '2024-01-01',
    }));

    expect(created.endedAt).toBe('2024-01-01');
    expect(await updateWorkExperience(studentA, created.id, {
      startedAt: '2025-01-02',
    })).toEqual({ outcome: 'invalid-date-range' });
    expect((await listWorkExperiences(studentA))[0]?.startedAt).toBe('2024-01-01');
  });
});
