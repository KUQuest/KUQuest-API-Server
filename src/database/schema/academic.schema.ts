import { relations, sql } from 'drizzle-orm';
import { boolean, check, pgTable, uuid, unique, varchar } from 'drizzle-orm/pg-core';

export const faculty = pgTable(
  'faculty',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
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
    name: varchar('name', { length: 100 }).notNull(),
  },
  (table) => [unique('department_faculty_id_name_key').on(table.facultyId, table.name)],
);

export const occupation = pgTable(
  'occupation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    requiresStudentId: boolean('requires_student_id').notNull(),
  },
  (table) => [
    unique('occupation_name_key').on(table.name),
    check(
      'occupation_name_check',
      sql`${table.name} IN ('Staff', 'Lecturer', 'Student')`,
    ),
  ],
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
