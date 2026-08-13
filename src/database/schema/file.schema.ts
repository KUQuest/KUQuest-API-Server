import { relations } from 'drizzle-orm';
import {
  bigint,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { authUser } from './auth.schema';

export const file = pgTable(
  'file',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bucket: varchar('bucket', { length: 63 }).notNull(),
    objectKey: varchar('object_key', { length: 1024 }).notNull(),
    contentType: varchar('content_type', { length: 255 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => authUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('file_bucket_object_key_key').on(table.bucket, table.objectKey),
    index('file_uploaded_by_user_id_idx').on(table.uploadedByUserId),
  ],
);

export const fileRelations = relations(file, ({ one }) => ({
  uploadedByUser: one(authUser, {
    fields: [file.uploadedByUserId],
    references: [authUser.id],
  }),
}));
