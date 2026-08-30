import { resolve } from 'node:path';

import { Elysia } from 'elysia';

const authTestPage = Bun.file(resolve(process.cwd(), 'public/index.html'));

export const authTestRoute = new Elysia({
  name: 'auth-test-route',
}).get('/', () => authTestPage, {
  detail: {
    tags: ['General'],
    summary: 'Quest and finance test bench',
    description: 'Serves a browser page for testing the default Member, Quest, and finance flows.',
    operationId: 'getApiRoot',
  },
});
