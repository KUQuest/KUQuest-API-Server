import { resolve } from 'node:path';

import { Elysia } from 'elysia';

const authTestPage = Bun.file(resolve(process.cwd(), 'public/index.html'));
const appStyles = Bun.file(resolve(process.cwd(), 'public/app.css'));
const appScript = Bun.file(resolve(process.cwd(), 'public/app.js'));

export const authTestRoute = new Elysia({
  name: 'auth-test-route',
})
  .get('/app.css', () => appStyles, {
    detail: { hide: true },
  })
  .get('/app.js', () => appScript, {
    detail: { hide: true },
  })
  .get('/', () => authTestPage, {
  detail: {
    tags: ['General'],
    summary: 'Authentication test page',
    description: 'Serves a browser page for testing Google authentication.',
    operationId: 'getApiRoot',
  },
  });
