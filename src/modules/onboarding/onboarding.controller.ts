import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import type { AuthenticatedSession } from '@/modules/auth';

import { getOnboardingData, getOnboardingStatusFields, updateOnboardingInfo } from './onboarding.service';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';
import type { onboardingSchema } from './onboarding.schema';

type AuthedContext = { session: AuthenticatedSession; set: { status?: number | keyof StatusMap } };

export const getOnboardingStatus = async ({
    session,
    set,
}: AuthedContext): Promise<ApiResponse<{ completed: boolean }>> => {
    const currentUser = await getOnboardingStatusFields(session.user.id);

    if (!currentUser) {
        set.status = 404;
        return apiError('USER_NOT_FOUND', 'User not found');
    }

    const completed = Boolean(currentUser.telephone && currentUser.faculty && currentUser.studentId);
    return apiSuccess({ completed });
};

export const updateOnboarding = async ({
    session,
    body,
}: AuthedContext & { body: Static<typeof onboardingSchema> }): Promise<ApiResponse> => {
    await updateOnboardingInfo(session.user.id, body);
    return apiSuccess();
};

export const getOnboardingInfo = async ({
    session,
    set,
}: AuthedContext): Promise<ApiResponse<{ currentUser: Awaited<ReturnType<typeof getOnboardingData>> }>> => {
    const currentUser = await getOnboardingData(session.user.id);

    if (!currentUser) {
        set.status = 404;
        return apiError('USER_NOT_FOUND', 'User not found');
    }

    return apiSuccess({ currentUser });
};
