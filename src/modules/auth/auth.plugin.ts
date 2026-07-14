import { Elysia } from 'elysia';

import { auth } from './auth.config';

export const authPlugin = new Elysia({
  name: 'auth-plugin',
}).all('/api/auth/*', ({ request }) => auth.handler(request));
