import { sql } from '@/database/client';
import { seedAcademicOptions } from '@/modules/academic-registration/academic-registration.service';

const main = async (): Promise<void> => {
  const result = await seedAcademicOptions();
  console.log(
    `Seeded academic options: ${result.faculties} faculties, ${result.departments} departments.`
  );
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Academic options seed failed.');
  process.exitCode = 1;
} finally {
  await sql.end();
}
