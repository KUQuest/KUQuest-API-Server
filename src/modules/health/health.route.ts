import { Elysia } from 'elysia';

import { healthResponseSchema } from './health.schema';

export const healthRoute = new Elysia({
  name: 'health-route',
}).get(
  '/health',
  () => ({
    success: true as const,
    data: {
      status: 'ok' as const,
      service: 'kuquest-api-server',
      timestamp: new Date().toISOString(),
    },
  }),
  {
    detail: {
      tags: ['Health'],
      summary: 'Check API health',
      description: 'Checks whether the KUQuest API server is available.',
      operationId: 'getHealth',
    },
    response: {
      200: healthResponseSchema,
    },
  },
);