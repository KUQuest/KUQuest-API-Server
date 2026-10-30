import { app, createApp } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('health integration', () => {
  it('returns service health status over HTTP', async () => {
    const response = await app.handle(new Request('http://localhost/health'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.service).toBe('kuquest-api-server');
    expect(body.data.timestamp).toEqual(expect.any(String));
  });

  it('returns service health status over WebSocket', async () => {
    const healthApp = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = healthApp.server?.port;
    if (port === undefined) throw new Error('WebSocket health server did not start');
    try {
      const body = await new Promise<{
        success: boolean;
        data: { status: string; service: string; timestamp: string };
      }>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/health/ws`);

        socket.addEventListener('message', (event) => {
          socket.close();
          resolve(JSON.parse(event.data as string));
        });
        socket.addEventListener('error', () => {
          reject(new Error('WebSocket health check failed'));
        });
      });

      expect(body).toEqual({
        success: true,
        data: {
          status: 'ok',
          service: 'kuquest-api-server',
          timestamp: expect.any(String),
        },
      });
    } finally {
      await healthApp.stop();
    }
  });
});
