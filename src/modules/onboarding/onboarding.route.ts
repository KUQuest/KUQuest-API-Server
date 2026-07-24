import { db } from '@/database/client';
import { user } from '@/database/schema/auth.schema';
import { auth} from '@/modules/auth/auth.config';
import { apiError, apiSuccess } from '@/shared/api-response';

import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';


import { onboardingSchema, onboardingResponseSchema, onboardingUpdateSchema, onboardingDataResponseSchema, onboardingErrorSchema } from './onboarding.schema';

export const onboardingRoute =  new Elysia({
    name : 'onboarding-route',
})
    .get( '/api/onboarding/status',
        async ({ request: req , status}) => {
            const session = await auth.api.getSession({
                headers: req.headers,
            });
            if (!session) {
                return status(401, apiError('UNAUTHORIZED', 'Unauthorized'));

            }
            const [currentUser] = await db.select({
                telephone: user.telephone,
                faculty: user.faculty,
                studentId: user.studentId,
            }).from(user).where(eq(user.id, session.user.id)).limit(1);

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
    .patch( '/api/onboarding/update',
        async ({ request: req , body ,status}) => {
            const session = await auth.api.getSession({
                headers: req.headers,
            });
            if (!session) {
                return status(401, apiError('UNAUTHORIZED', 'Unauthorized'));

            }
            await db
                .update(user)
                .set({
                    telephone: body.telephone,
                    faculty: body.faculty,
                    studentId: body.studentId,

                 }).where(eq(user.id, session.user.id));
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
    .get( '/api/onboarding/get-data' , 
        async ({ request: req , status}) => {
            const session = await auth.api.getSession({
                headers: req.headers,
            });
            if (!session) {
                return status(401, apiError('UNAUTHORIZED', 'Unauthorized'));

            }
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
            .where(eq(user.id, session.user.id))
            .limit(1);

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
