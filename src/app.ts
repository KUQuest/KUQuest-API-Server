import { Elysia } from 'elysia';

import { authPlugin, authTestRoute } from './modules/auth';
import { healthRoute } from './modules/health';
import { onboardingRoute } from './modules/onboarding';
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
  .use(onboardingRoute);
