import { Elysia } from 'elysia';

import { responses } from '@/shared/api-response.schema';

import { healthResponseSchema } from './health.schema';

const healthResponse = () => ({
  success: true as const,
  data: {
    status: 'ok' as const,
    service: 'kuquest-api-server',
    timestamp: new Date().toISOString(),
  },
});

export const healthRoute = new Elysia({
  name: 'health-route',
})
  .get('/health', healthResponse, {
    detail: {
      tags: ['Health'],
      summary: 'Check API health',
      description: 'Checks whether the KUQuest API server is available.',
      operationId: 'getHealth',
    },
    response: responses(healthResponseSchema),
  })
  .ws('/health/ws', {
    open(ws) {
      ws.send(JSON.stringify(healthResponse()));
      ws.close(1000, 'Health check complete');
    },
    detail: {
      tags: ['Health'],
      summary: 'Check WebSocket health',
      description: 'Upgrades a WebSocket connection and returns API health status.',
      operationId: 'getWebSocketHealth',
    },
  });
