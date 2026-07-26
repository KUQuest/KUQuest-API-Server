import { eq } from 'drizzle-orm';

import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';

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
    data: { telephone: string; majorId: string; studentId: string },
) => {
    await db
        .update(authUser)
        .set(data)
        .where(eq(authUser.id, userId));
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
