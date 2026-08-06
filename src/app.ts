import { Elysia } from 'elysia';

import { academicRegistrationRoute } from './modules/academic-registration';
import { authPlugin, authTestRoute } from './modules/auth';
import { certificateRoute } from './modules/certificate';
import { healthRoute } from './modules/health';
import { onboardingRoute } from './modules/onboarding';
import { portfolioRoute } from './modules/portfolio';
import { profileRoute } from './modules/profile';
import { corsPlugin } from './plugins/cors';
import { errorHandlerPlugin } from './plugins/error-handler';
import { openapiPlugin } from './plugins/openapi';

export const app = new Elysia({
  name: 'kuquest-api',
})
  .use(errorHandlerPlugin)
  .use(corsPlugin)
  .use(authPlugin)
  .use(openapiPlugin)
  .get('/', () => 'Hello Elysia', {
    detail: {
      tags: ['General'],
      summary: 'API root',
      description: 'Returns a basic response from the KUQuest API.',
      operationId: 'getApiRoot',
    },
  })
  .use(authTestRoute)
  .use(healthRoute)
  .use(onboardingRoute)
  .use(academicRegistrationRoute)
  .use(profileRoute)
  .use(certificateRoute)
  .use(portfolioRoute)
