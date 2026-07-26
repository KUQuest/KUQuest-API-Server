import { db } from '@/database/client';
import { faculty, major } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';

import { eq } from 'drizzle-orm';

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
