import { db } from '@/database/client';
import { department, faculty } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';

import { and, asc, eq, ne } from 'drizzle-orm';

import type { Static } from 'elysia';

import type { onboardingSchema } from './onboarding.schema';

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

export const getOnboardingStatusFields = async (userId: string) => {
    const [currentUser] = await db.select({
        telephone: authUser.telephone,
        departmentId: authUser.departmentId,
        studentId: authUser.studentId,
    }).from(authUser).where(eq(authUser.id, userId)).limit(1);

    return currentUser;
};

export const updateOnboardingInfo = async (
    userId: string,
    data: Static<typeof onboardingSchema>,
): Promise<'ok' | 'USER_NOT_FOUND' | 'DEPARTMENT_NOT_FOUND' | 'STUDENT_ID_ALREADY_EXISTS'> => {
    const [currentUser] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.id, userId))
        .limit(1);

    if (!currentUser) return 'USER_NOT_FOUND';

    if (data.departmentId !== undefined) {
        const [currentDepartment] = await db
            .select({ id: department.id })
            .from(department)
            .where(eq(department.id, data.departmentId))
            .limit(1);

        if (!currentDepartment) return 'DEPARTMENT_NOT_FOUND';
    }

    if (data.studentId !== undefined) {
        const [existingStudent] = await db
            .select({ id: authUser.id })
            .from(authUser)
            .where(and(eq(authUser.studentId, data.studentId), ne(authUser.id, userId)))
            .limit(1);

        if (existingStudent) return 'STUDENT_ID_ALREADY_EXISTS';
    }

    try {
        await db
            .update(authUser)
            .set(data)
            .where(eq(authUser.id, userId));
    } catch (error) {
        if (isStudentIdUniquenessViolation(error)) {
            return 'STUDENT_ID_ALREADY_EXISTS';
        }

        throw error;
    }

    return 'ok';
};

export const getOnboardingData = async (userId: string) => {
    const [currentUser] = await db.select({
        firstName: authUser.firstName,
        lastName: authUser.lastName,
        email: authUser.email,
        telephone: authUser.telephone,
        departmentId: authUser.departmentId,
        studentId: authUser.studentId,
        academicYear: authUser.academicYear,
    })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);

    return currentUser;
};

export const getAcademicOptions = async () => {
    const rows = await db
        .select({
            facultyId: faculty.id,
            facultyName: faculty.name,
            departmentId: department.id,
            departmentName: department.name,
        })
        .from(faculty)
        .leftJoin(department, eq(department.facultyId, faculty.id))
        .orderBy(asc(faculty.name), asc(department.name));

    const options = new Map<string, {
        id: string;
        name: string;
        departments: { id: string; name: string }[];
    }>();

    for (const row of rows) {
        const option = options.get(row.facultyId) ?? {
            id: row.facultyId,
            name: row.facultyName,
            departments: [],
        };

        if (row.departmentId && row.departmentName) {
            option.departments.push({ id: row.departmentId, name: row.departmentName });
        }

        options.set(row.facultyId, option);
    }

    return [...options.values()];
};
