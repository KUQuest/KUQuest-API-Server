import { db } from '@/database/client';
import { department, faculty, occupation } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';

import type { Static } from 'elysia';
import { and, asc, eq, ne } from 'drizzle-orm';

import type { academicRegistrationUpdateSchema } from './academic-registration.schema';

type AcademicRegistrationUpdate = Static<typeof academicRegistrationUpdateSchema>;

export type AcademicRegistrationUpdateOutcome =
  | 'updated'
  | 'student-not-found'
  | 'department-not-found'
  | 'occupation-not-found'
  | 'student-id-already-exists';

const isStudentIdUniquenessViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;

  const databaseError = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    cause?: unknown;
  };
  const constraint = databaseError.constraint ?? databaseError.constraint_name;

  return (
    (databaseError.code === '23505' && constraint === 'auth_user_student_id_uidx') ||
    isStudentIdUniquenessViolation(databaseError.cause)
  );
};

export const updateAcademicRegistration = async (
  userId: string,
  data: AcademicRegistrationUpdate,
): Promise<AcademicRegistrationUpdateOutcome> => {
  const [student] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!student) return 'student-not-found';

  if (data.departmentId !== undefined) {
    const [currentDepartment] = await db
      .select({ id: department.id })
      .from(department)
      .where(eq(department.id, data.departmentId))
      .limit(1);

    if (!currentDepartment) return 'department-not-found';
  }

  if (data.occupationId !== undefined) {
    const [currentOccupation] = await db
      .select({ id: occupation.id })
      .from(occupation)
      .where(eq(occupation.id, data.occupationId))
      .limit(1);

    if (!currentOccupation) return 'occupation-not-found';
  }

  if (data.studentId !== undefined) {
    const [existingStudent] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(and(eq(authUser.studentId, data.studentId), ne(authUser.id, userId)))
      .limit(1);

    if (existingStudent) return 'student-id-already-exists';
  }

  const { termsVersion, ...fields } = data;
  const update: Partial<typeof authUser.$inferInsert> = { ...fields };
  if (termsVersion !== undefined) {
    update.termsVersion = termsVersion;
    update.termsAcceptedAt = new Date();
  }

  try {
    await db.update(authUser).set(update).where(eq(authUser.id, userId));
  } catch (error) {
    if (isStudentIdUniquenessViolation(error)) return 'student-id-already-exists';

    throw error;
  }

  return 'updated';
};

export const getAcademicRegistrationStatus = async (userId: string) => {
  const [row] = await db
    .select({
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      telephone: authUser.telephone,
      occupationId: authUser.occupationId,
      requiresStudentId: occupation.requiresStudentId,
      studentId: authUser.studentId,
      departmentId: authUser.departmentId,
      termsAcceptedAt: authUser.termsAcceptedAt,
      termsVersion: authUser.termsVersion,
    })
    .from(authUser)
    .leftJoin(occupation, eq(authUser.occupationId, occupation.id))
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!row) return undefined;

  const { requiresStudentId, ...fields } = row;
  const completed = Boolean(
    fields.telephone &&
    fields.occupationId &&
    fields.departmentId &&
    fields.termsAcceptedAt &&
    fields.termsVersion &&
    (requiresStudentId ? fields.studentId : true),
  );

  return { ...fields, completed };
};

export const getAcademicRegistrationOptions = async () => {
  const occupationRows = await db
    .select({
      id: occupation.id,
      name: occupation.name,
      requiresStudentId: occupation.requiresStudentId,
    })
    .from(occupation)
    .orderBy(asc(occupation.name));

  const facultyRows = await db
    .select({
      facultyId: faculty.id,
      facultyName: faculty.name,
      departmentId: department.id,
      departmentName: department.name,
    })
    .from(faculty)
    .leftJoin(department, eq(department.facultyId, faculty.id))
    .orderBy(asc(faculty.name), asc(department.name));

  const faculties = new Map<string, {
    id: string;
    name: string;
    departments: { id: string; name: string }[];
  }>();

  for (const row of facultyRows) {
    const currentFaculty = faculties.get(row.facultyId) ?? {
      id: row.facultyId,
      name: row.facultyName,
      departments: [],
    };

    if (row.departmentId && row.departmentName) {
      currentFaculty.departments.push({ id: row.departmentId, name: row.departmentName });
    }

    faculties.set(row.facultyId, currentFaculty);
  }

  return {
    occupations: occupationRows,
    faculties: [...faculties.values()],
  };
};
