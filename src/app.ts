import { Elysia } from 'elysia';
import { authPlugin, authTestRoute } from './modules/auth';
import { healthRoute } from './modules/health/health.route';

import { corsPlugin } from './plugins/cors';
import { openapiPlugin } from './plugins/openapi';

export const app = new Elysia({
  name: 'kuquest-api',
})
  .use(corsPlugin)
  .use(authPlugin)
  .use(openapiPlugin)
  .use(authTestRoute)
  .use(healthRoute);
