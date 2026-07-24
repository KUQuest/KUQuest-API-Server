import { eq } from 'drizzle-orm';

import { db } from '@/database/client';
import { user } from '@/database/schema/auth.schema';

export const getOnboardingStatusFields = async (userId: string) => {
    const [currentUser] = await db.select({
        telephone: user.telephone,
        faculty: user.faculty,
        studentId: user.studentId,
    }).from(user).where(eq(user.id, userId)).limit(1);

    return currentUser;
};

export const updateOnboardingInfo = async (
    userId: string,
    data: { telephone: string; faculty: string; studentId: string },
) => {
    await db
        .update(user)
        .set(data)
        .where(eq(user.id, userId));
};

export const getOnboardingData = async (userId: string) => {
    const [currentUser] = await db.select({
        name: user.name,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        telephone: user.telephone,
        faculty: user.faculty,
        studentId: user.studentId,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

    return currentUser;
};
