import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '@/config/env';
import * as academicSchema from '@/database/schema/academic.schema';
import * as authSchema from '@/database/schema/auth.schema';
import * as fileSchema from '@/database/schema/file.schema';
import * as profileSchema from '@/database/schema/profile.schema';

const schema = { ...academicSchema, ...authSchema, ...fileSchema, ...profileSchema };

const connectionString =
  env.databaseUrl ||
  'postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest';

export const sql = postgres(connectionString, {
  max: 10,
  prepare: false,
});

export const db = drizzle(sql, { schema });
