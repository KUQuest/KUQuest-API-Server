import { db, sql } from '@/database/client';
import { department, faculty } from '@/database/schema/academic.schema';
import {
  academicCatalog,
  seedAcademicOptions,
} from '@/modules/academic-registration/academic-registration.service';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause }
    );
  }
});

describe('academic catalog seed', () => {
  it('seeds all faculties and departments idempotently', async () => {
    const firstRun = await seedAcademicOptions();
    expect(firstRun.faculties).toBeGreaterThanOrEqual(academicCatalog.length);
    expect(firstRun.departments).toBeGreaterThanOrEqual(100);

    const secondRun = await seedAcademicOptions();
    expect(secondRun.faculties).toBe(firstRun.faculties);
    expect(secondRun.departments).toBe(firstRun.departments);
  });

  it('contains expected departments for Engineering', async () => {
    const rows = await db
      .select({ name: department.name })
      .from(department)
      .innerJoin(faculty, eq(department.facultyId, faculty.id))
      .where(eq(faculty.name, 'Engineering'));

    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Aerospace Engineering',
        'Chemical Engineering',
        'Civil Engineering',
        'Computer Engineering',
        'Electrical Engineering',
        'Environmental Engineering',
        'Industrial Engineering',
        'Materials Engineering',
        'Mechanical Engineering',
        'Water Resources Engineering',
      ])
    );
  });

  it('contains expected departments for Science', async () => {
    const rows = await db
      .select({ name: department.name })
      .from(department)
      .innerJoin(faculty, eq(department.facultyId, faculty.id))
      .where(eq(faculty.name, 'Science'));

    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Biochemistry',
        'Botany',
        'Chemistry',
        'Computer Science',
        'Genetics',
        'Mathematics',
        'Microbiology',
        'Physics',
        'Statistics',
        'Zoology',
      ])
    );
  });

  it('contains expected departments for Agriculture', async () => {
    const rows = await db
      .select({ name: department.name })
      .from(department)
      .innerJoin(faculty, eq(department.facultyId, faculty.id))
      .where(eq(faculty.name, 'Agriculture'));

    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Agronomy',
        'Animal Science',
        'Entomology',
        'Horticulture',
        'Plant Pathology',
        'Soil Science',
      ])
    );
  });
});
