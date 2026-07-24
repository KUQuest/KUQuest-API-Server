import { auth} from '@/modules/auth/auth.config';
import { apiError, apiSuccess } from '@/shared/api-response';

import { Elysia } from 'elysia';

import { getOnboardingData, getOnboardingStatusFields, updateOnboardingInfo } from './onboarding.service';


import { onboardingSchema, onboardingResponseSchema, onboardingUpdateSchema, onboardingDataResponseSchema, onboardingErrorSchema } from './onboarding.schema';

export const onboardingRoute =  new Elysia({
    name : 'onboarding-route',
    prefix: '/api/onboarding',
})
    .get( '/status',
        async ({ request: req , status}) => {
            const session = await auth.api.getSession({
                headers: req.headers,
            });
            if (!session) {
                return status(401, apiError('UNAUTHORIZED', 'Unauthorized'));

            }
            const currentUser = await getOnboardingStatusFields(session.user.id);

            if (!currentUser) {
                return status(404, apiError('USER_NOT_FOUND', 'User not found'));
            }

            const completed = Boolean(currentUser.telephone && currentUser.faculty && currentUser.studentId);
            return apiSuccess({ completed });
        },
        {
            response: {
                200: onboardingResponseSchema,
                401: onboardingErrorSchema,
                404: onboardingErrorSchema,
            },
            detail: {
                tags: ['Onboarding'],
                summary: 'Get onboarding status',
                description: 'Get the onboarding status of the current user',
                operationId: 'getOnboardingStatus',
                security: [
                    {
                        betterAuthSession: [],
                    },
                ],

            }
        }
        
    )
    .patch( '/update',
        async ({ request: req , body ,status}) => {
            const session = await auth.api.getSession({
                headers: req.headers,
            });
            if (!session) {
                return status(401, apiError('UNAUTHORIZED', 'Unauthorized'));

            }
            await updateOnboardingInfo(session.user.id, body);
            return apiSuccess();
        },
        {
            body: onboardingSchema,
            response: {
                200: onboardingUpdateSchema,
                401: onboardingErrorSchema,
                400: onboardingErrorSchema,
            },
            detail: {
                tags: ['Onboarding'],
                summary: 'Update onboarding information',
                description: 'Update the onboarding information of the current user',
                operationId: 'updateOnboardingInfo',
                security: [
                    {
                        betterAuthSession: [],
                    },
                ],
            }
        }
    )
    .get( '/get-data' ,
        async ({ request: req , status}) => {
            const session = await auth.api.getSession({
                headers: req.headers,
            });
            if (!session) {
                return status(401, apiError('UNAUTHORIZED', 'Unauthorized'));

            }
            const currentUser = await getOnboardingData(session.user.id);

            if (!currentUser) {
                return status(404, apiError('USER_NOT_FOUND', 'User not found'));
            }

            return apiSuccess({ currentUser });

        },
        {
            response: {
                200: onboardingDataResponseSchema,
                401: onboardingErrorSchema,
                404: onboardingErrorSchema,
            },
            detail: {
                tags: ['Onboarding'],
                summary: 'Get onboarding information',
                description: 'Get the onboarding information of the current user',
                operationId: 'getOnboardingData',
                security: [
                    {
                        betterAuthSession: [],
                    },
                ],
            },
        }
    )
