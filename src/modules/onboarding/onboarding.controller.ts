import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import type { AuthenticatedSession } from '@/modules/auth';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import {
    getAcademicOptions,
    getOnboardingData,
    getOnboardingStatusFields,
    updateOnboardingInfo,
} from './onboarding.service';
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

    const completed = Boolean(currentUser.telephone && currentUser.majorId && currentUser.studentId);
    return apiSuccess({ completed });
};

export const updateOnboarding = async ({
    session,
    set,
    body,
}: AuthedContext & { body: Static<typeof onboardingSchema> }): Promise<ApiResponse> => {
    const result = await updateOnboardingInfo(session.user.id, body);

    if (result === 'USER_NOT_FOUND') {
        set.status = 404;
        return apiError('USER_NOT_FOUND', 'User not found');
    }

    if (result === 'MAJOR_NOT_FOUND') {
        set.status = 400;
        return apiError('MAJOR_NOT_FOUND', 'Major not found');
    }

    if (result === 'STUDENT_ID_ALREADY_EXISTS') {
        set.status = 409;
        return apiError('STUDENT_ID_ALREADY_EXISTS', 'Student ID already exists');
    }

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

export const getAcademicOptionsController = async (): Promise<
    ApiResponse<Awaited<ReturnType<typeof getAcademicOptions>>>
> => apiSuccess(await getAcademicOptions());
