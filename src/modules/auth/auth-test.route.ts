import { resolve } from 'node:path';

import { Elysia } from 'elysia';

const authTestPagePath = resolve(process.cwd(), 'public/index.html');

export const authTestRoute = new Elysia({
  name: 'auth-test-route',
}).get('/', () => Bun.file(authTestPagePath), {
  detail: {
    tags: ['General'],
    summary: 'Quest and finance test bench',
    description: 'Serves a browser page for testing the default Member, Quest, and finance flows.',
    operationId: 'getApiRoot',
  },
})
  .get('/test-bench/styles.css', () => Bun.file(resolve(process.cwd(), 'public/test-bench/styles.css')), {
    detail: { hide: true },
  })
  .get('/test-bench/app.js', () => Bun.file(resolve(process.cwd(), 'public/test-bench/app.js')), {
    detail: { hide: true },
  });
