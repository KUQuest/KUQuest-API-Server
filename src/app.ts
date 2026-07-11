import { Elysia } from 'elysia';

export const app = new Elysia({ name: 'kuquest-api' })
  .get('/', () => 'Hello Elysia')
  .get('/health', () => ({
    success: true,
    data: {
      status: 'ok',
      service: 'kuquest-api-server',
      timestamp: new Date().toISOString(),
    },
  }));
