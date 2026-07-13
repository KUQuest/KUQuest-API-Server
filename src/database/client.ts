import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '@/config/env';
import * as schema from '@/database/schema/auth.schema';

const connectionString =
  env.databaseUrl ||
  'postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest';

export const sql = postgres(connectionString, {
  max: 10,
  prepare: false,
});

export const db = drizzle(sql, { schema });
