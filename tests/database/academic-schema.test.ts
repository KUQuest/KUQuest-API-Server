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
