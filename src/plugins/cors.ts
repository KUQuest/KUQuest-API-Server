import { cors } from '@elysiajs/cors';

import { env } from '@/config/env';

export const corsPlugin = cors({
  origin: env.cmsOrigin || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  exposeHeaders: ['X-Request-ID'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match'],
});
