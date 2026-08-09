import { db, sql } from '@/database/client';
import { department, faculty, occupation } from '@/database/schema/academic.schema';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq, getTableColumns } from 'drizzle-orm';

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }
});

describe('academic database schema', () => {
  it('renamed the major table to department', () => {
    const columns = getTableColumns(department);

    expect(columns.id.name).toBe('id');
    expect(columns.facultyId.name).toBe('faculty_id');
    expect(columns.name.name).toBe('name');
  });

  it('stores an Occupation as a lookup row with a Student ID requirement flag', () => {
    const columns = getTableColumns(occupation);

    expect(columns.id.name).toBe('id');
    expect(columns.name.name).toBe('name');
    expect(columns.requiresStudentId.name).toBe('requires_student_id');
  });
});

describe('seeded occupation options', () => {
  it('seeds Student as requiring a Student ID', async () => {
    const [student] = await db
      .select({ requiresStudentId: occupation.requiresStudentId })
      .from(occupation)
      .where(eq(occupation.name, 'Student'))
      .limit(1);

    expect(student?.requiresStudentId).toBe(true);
  });

  it('seeds Teacher as not requiring a Student ID', async () => {
    const [teacher] = await db
      .select({ requiresStudentId: occupation.requiresStudentId })
      .from(occupation)
      .where(eq(occupation.name, 'Teacher'))
      .limit(1);

    expect(teacher?.requiresStudentId).toBe(false);
  });
});

describe('seeded academic options', () => {
  it('seeds the KU faculty catalog the onboarding form reads from', async () => {
    const rows = await db.select({ name: faculty.name }).from(faculty);
    const names = rows.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        'Agriculture',
        'Business Administration',
        'Economics',
        'Engineering',
        'Humanities',
        'Science',
        'Social Sciences',
        'Veterinary Medicine',
      ]),
    );
  });

  it('seeds each faculty with the departments it offers', async () => {
    const rows = await db
      .select({ name: department.name })
      .from(department)
      .innerJoin(faculty, eq(department.facultyId, faculty.id))
      .where(eq(faculty.name, 'Engineering'));
    const names = rows.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        'Electrical Engineering',
        'Industrial Engineering',
        'Mechanical Engineering',
      ]),
    );
  });
});

describe('catalog seed idempotency', () => {
  const countCatalog = async () => {
    const [counts] = await sql`
      select
        (select count(*) from faculty) as faculties,
        (select count(*) from department) as departments
    `;

    return counts;
  };

  it('adds no rows when the catalog seed is applied a second time', async () => {
    const before = await countCatalog();

    // The same two statements 0005_seed_academic_options.sql applies, against the
    // post-rename table. Their ON CONFLICT clauses only hold while the unique
    // constraints they name exist.
    await sql`
      insert into faculty (name) values ('Engineering')
      on conflict (name) do nothing
    `;
    await sql`
      insert into department (faculty_id, name)
      select faculty.id, 'Mechanical Engineering'
      from faculty
      where faculty.name = 'Engineering'
      on conflict (faculty_id, name) do nothing
    `;

    expect(await countCatalog()).toEqual(before);
  });
});

describe('faculty to department relationship', () => {
  it('still relates a department to its faculty after the rename', async () => {
    const [row] = await db
      .select({ facultyName: faculty.name, departmentName: department.name })
      .from(department)
      .innerJoin(faculty, eq(department.facultyId, faculty.id))
      .limit(1);

    expect(row).toBeDefined();
  });
});
