import { relations } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { bigint, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { authUser } from './auth.schema';

export const file = pgTable(
  'file',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    uploadedByUserId: text('uploaded_by_user_id').references((): AnyPgColumn => authUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
