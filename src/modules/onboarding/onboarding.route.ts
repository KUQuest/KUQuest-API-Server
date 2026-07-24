import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { getOnboardingStatus, updateOnboarding, getOnboardingInfo } from './onboarding.controller';
import {
  onboardingSchema,
  onboardingResponseSchema,
  onboardingUpdateSchema,
  onboardingDataResponseSchema,
} from './onboarding.schema';

export const onboardingRoute = new Elysia({
    name: 'onboarding-route',
    prefix: `${API_V1_PREFIX}/onboarding`,
})
    .use(authGuard)
    .get('/status', getOnboardingStatus, {
        response: responses(onboardingResponseSchema, 401, 404),
        detail: {
            tags: ['Onboarding'],
            summary: 'Get onboarding status',
            description: 'Get the onboarding status of the current user',
            operationId: 'getOnboardingStatus',
            security: betterAuthSecurity,
        },
    })
    .patch('/update', updateOnboarding, {
        body: onboardingSchema,
        response: responses(onboardingUpdateSchema, 401, 400),
        detail: {
            tags: ['Onboarding'],
            summary: 'Update onboarding information',
            description: 'Update the onboarding information of the current user',
            operationId: 'updateOnboardingInfo',
            security: betterAuthSecurity,
        },
    })
    .get('/get-data', getOnboardingInfo, {
        response: responses(onboardingDataResponseSchema, 401, 404),
        detail: {
            tags: ['Onboarding'],
            summary: 'Get onboarding information',
            description: 'Get the onboarding information of the current user',
            operationId: 'getOnboardingData',
            security: betterAuthSecurity,
        },
    });
