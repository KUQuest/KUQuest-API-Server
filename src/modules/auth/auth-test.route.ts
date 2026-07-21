import { resolve } from 'node:path';

import { Elysia } from 'elysia';

const authTestPage = Bun.file(resolve(process.cwd(), 'public/index.html'));

export const authTestRoute = new Elysia({
  name: 'auth-test-route',
}).get('/', () => authTestPage, {
  detail: {
    tags: ['General'],
    summary: 'Authentication test page',
    description: 'Serves a browser page for testing Google authentication.',
    operationId: 'getApiRoot',
  },
});
