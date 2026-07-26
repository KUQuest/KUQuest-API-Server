import { relations } from 'drizzle-orm';
import { pgTable, text, uuid, unique } from 'drizzle-orm/pg-core';

export const faculty = pgTable(
  'faculty',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
  },
  (table) => [unique('faculty_name_key').on(table.name)],
);

export const major = pgTable(
  'major',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    facultyId: uuid('faculty_id')
      .notNull()
      .references(() => faculty.id),
    name: text('name').notNull(),
  },
  (table) => [unique('major_faculty_id_name_key').on(table.facultyId, table.name)],
);

export const facultyRelations = relations(faculty, ({ many }) => ({
  majors: many(major),
}));

export const majorRelations = relations(major, ({ one }) => ({
  faculty: one(faculty, {
    fields: [major.facultyId],
    references: [faculty.id],
  }),
}));
