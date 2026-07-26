import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { major } from '@/database/schema/academic.schema';

import { and, eq, ne } from 'drizzle-orm';

import type { Static } from 'elysia';

import type { onboardingSchema } from './onboarding.schema';

export const getOnboardingStatusFields = async (userId: string) => {
    const [currentUser] = await db.select({
        telephone: authUser.telephone,
        majorId: authUser.majorId,
        studentId: authUser.studentId,
    }).from(authUser).where(eq(authUser.id, userId)).limit(1);

    return currentUser;
};

export const updateOnboardingInfo = async (
    userId: string,
    data: Static<typeof onboardingSchema>,
): Promise<'ok' | 'USER_NOT_FOUND' | 'MAJOR_NOT_FOUND' | 'STUDENT_ID_ALREADY_EXISTS'> => {
    const [currentUser] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.id, userId))
        .limit(1);

    if (!currentUser) return 'USER_NOT_FOUND';

    if (data.majorId !== undefined) {
        const [currentMajor] = await db
            .select({ id: major.id })
            .from(major)
            .where(eq(major.id, data.majorId))
            .limit(1);

        if (!currentMajor) return 'MAJOR_NOT_FOUND';
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
        const databaseError = error as { code?: string; constraint_name?: string };

        if (
            databaseError.code === '23505' &&
            databaseError.constraint_name === 'auth_user_student_id_uidx'
        ) {
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
        majorId: authUser.majorId,
        studentId: authUser.studentId,
    })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);

    return currentUser;
};
