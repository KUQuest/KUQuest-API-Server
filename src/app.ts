import { Elysia } from 'elysia';
import { authPlugin, authTestRoute } from './modules/auth';
import { healthRoute } from './modules/health/health.route';
import { onboardingRoute } from './modules/onboarding/onboarding.route';

import { corsPlugin } from './plugins/cors';
import { openapiPlugin } from './plugins/openapi';

export const app = new Elysia({
  name: 'kuquest-api',
})
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

