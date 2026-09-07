import { pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';

export const tag = pgTable(
  'tag',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
  },
  (table) => [unique('tag_name_key').on(table.name)],
);
