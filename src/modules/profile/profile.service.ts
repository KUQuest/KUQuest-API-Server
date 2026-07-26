import { db } from '@/database/client';
import { faculty, major } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';

import { eq } from 'drizzle-orm';

type ProfileUpdate = {
  firstName?: string;
  lastName?: string;
  bio?: string;
  telephone?: string;
  majorId?: string;
};

export const majorExists = async (majorId: string) => {
  const [row] = await db
    .select({ id: major.id })
    .from(major)
    .where(eq(major.id, majorId))
    .limit(1);

  return Boolean(row);
};

export const updateProfile = async (userId: string, data: ProfileUpdate) => {
  // A request that changes nothing is a no-op; Drizzle rejects an empty update.
  if (Object.keys(data).length === 0) return;

  await db.update(authUser).set(data).where(eq(authUser.id, userId));
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
      facultyId: faculty.id,
      facultyName: faculty.name,
    })
    .from(authUser)
    .leftJoin(major, eq(authUser.majorId, major.id))
    .leftJoin(faculty, eq(major.facultyId, faculty.id))
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!row) return undefined;

  const { majorId, majorName, facultyId, facultyName, ...profile } = row;

  return {
    ...profile,
    // A major always belongs to a faculty, so the joins either all resolve or none do.
    major:
      majorId && majorName && facultyId && facultyName
        ? { id: majorId, name: majorName, faculty: { id: facultyId, name: facultyName } }
        : null,
  };
};
