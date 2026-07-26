import { db } from '@/database/client';
import { faculty, major } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';

import type { Static } from 'elysia';
import { eq } from 'drizzle-orm';

import type { profileUpdateSchema } from './profile.schema';

type ProfileUpdate = Static<typeof profileUpdateSchema>;

export const majorExists = async (majorId: string) => {
  const [row] = await db
    .select({ id: major.id })
    .from(major)
    .where(eq(major.id, majorId))
    .limit(1);

  return Boolean(row);
};

const studentExists = async (userId: string) => {
  const [row] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);

  return Boolean(row);
};

/** Reports whether the student was found; a write that matched nobody is not a success. */
export const updateProfile = async (userId: string, data: ProfileUpdate) => {
  // A request that changes nothing still has to say whether the student is there, and
  // Drizzle rejects an empty update, so ask the row directly.
  if (Object.keys(data).length === 0) return studentExists(userId);

  const updated = await db
    .update(authUser)
    .set(data)
    .where(eq(authUser.id, userId))
    .returning({ id: authUser.id });

  return updated.length > 0;
};

export const getProfile = async (userId: string) => {
  const [row] = await db
    .select({
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      bio: authUser.bio,
      telephone: authUser.telephone,
      studentId: authUser.studentId,
      academicYear: authUser.academicYear,
      majorId: major.id,
      majorName: major.name,
      facultyName: faculty.name,
    })
    .from(authUser)
    .leftJoin(major, eq(authUser.majorId, major.id))
    .leftJoin(faculty, eq(major.facultyId, faculty.id))
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!row) return undefined;

  const { majorId, majorName, facultyName, ...profile } = row;

  return {
    ...profile,
    // A major always belongs to a faculty, so the joins either all resolve or none do.
    major:
      majorId && majorName && facultyName
        ? { id: majorId, name: majorName, faculty: { name: facultyName } }
        : null,
  };
};
