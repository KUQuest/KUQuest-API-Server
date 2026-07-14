import { Elysia } from 'elysia';

import { apiSuccess } from '@/http/api-response';

import { healthResponseSchema } from './health.schema';

export const healthRoute = new Elysia({
  name: 'health-route',
}).get(
  '/health',
  ({ request }) =>
    apiSuccess(
      {
      status: 'ok' as const,
      service: 'kuquest-api-server',
      timestamp: new Date().toISOString(),
      },
      request,
    ),
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
