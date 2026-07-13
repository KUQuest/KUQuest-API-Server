import { cors } from '@elysiajs/cors';

import { env } from '@/config/env';

export const corsPlugin = cors({
  origin: env.cmsOrigin || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Idempotency-Key'],
});
