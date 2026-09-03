import { env } from '@/config/env';
import * as academicSchema from '@/database/schema/academic.schema';
import * as adminSchema from '@/database/schema/admin.schema';
import * as auditSchema from '@/database/schema/audit.schema';
import * as authSchema from '@/database/schema/auth.schema';
import * as fileSchema from '@/database/schema/file.schema';
import * as paymentSchema from '@/database/schema/payment.schema';
import * as profileSchema from '@/database/schema/profile.schema';
import * as questSchema from '@/database/schema/quest.schema';
import * as tagSchema from '@/database/schema/tag.schema';
import * as walletSchema from '@/database/schema/wallet.schema';
import * as workChatSchema from '@/database/schema/work-chat.schema';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const schema = {
  ...academicSchema,
  ...adminSchema,
  ...auditSchema,
  ...authSchema,
  ...fileSchema,
  ...paymentSchema,
  ...profileSchema,
  ...questSchema,
  ...tagSchema,
  ...walletSchema,
  ...workChatSchema,
};

const connectionString =
  env.databaseUrl ||
  'postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest';

export const sql = postgres(connectionString, {
  max: 10,
  prepare: false,
});

export const db = drizzle(sql, { schema });
