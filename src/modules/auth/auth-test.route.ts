import { resolve } from 'node:path';

import { Elysia } from 'elysia';

const publicFile = (name: string) =>
  Bun.file(resolve(process.cwd(), 'public', name));

export const authTestRoute = new Elysia({
  name: 'auth-test-route',
})
  .get('/app.css', () => publicFile('app.css'), {
    detail: { hide: true },
  })
  .get('/app.js', () => publicFile('app.js'), {
    detail: { hide: true },
  })
  .get('/', () => publicFile('index.html'), {
  detail: {
    tags: ['General'],
    summary: 'Authentication test page',
    description: 'Serves a browser page for testing Google authentication.',
    operationId: 'getApiRoot',
  },
  });
