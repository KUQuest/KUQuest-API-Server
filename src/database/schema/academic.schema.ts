import { relations } from 'drizzle-orm';
import { boolean, pgTable, text, uuid, unique } from 'drizzle-orm/pg-core';

export const faculty = pgTable(
  'faculty',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
  },
  (table) => [unique('faculty_name_key').on(table.name)],
);

export const department = pgTable(
  'department',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    facultyId: uuid('faculty_id')
      .notNull()
      .references(() => faculty.id),
    name: text('name').notNull(),
  },
  (table) => [unique('department_faculty_id_name_key').on(table.facultyId, table.name)],
);

export const occupation = pgTable(
  'occupation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    // Drives whether Academic Registration requires a Student ID for this Occupation,
    // instead of the server hardcoding a name comparison.
    requiresStudentId: boolean('requires_student_id').notNull(),
  },
  (table) => [unique('occupation_name_key').on(table.name)],
);

export const facultyRelations = relations(faculty, ({ many }) => ({
  departments: many(department),
}));

export const departmentRelations = relations(department, ({ one }) => ({
  faculty: one(faculty, {
    fields: [department.facultyId],
    references: [faculty.id],
  }),
}));
