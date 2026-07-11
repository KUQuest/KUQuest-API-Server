import { Elysia } from 'elysia';
import { healthRoute } from './modules/health/health.route';

import { openapiPlugin } from './plugins/openapi';

export const app = new Elysia({
  name: 'kuquest-api',
})
  .use(openapiPlugin)
  .get('/', () => 'Hello Elysia', {
    detail: {
      tags: ['General'],
      summary: 'API root',
      description: 'Returns a basic response from the KUQuest API.',
      operationId: 'getApiRoot',
    },
  })
  .use(healthRoute);