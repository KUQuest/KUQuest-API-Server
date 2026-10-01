import { db, sql } from '@/database/client';
import { authAdmin } from '@/database/schema/auth.schema';
import { seedAcademicOptions } from '@/modules/academic-registration/academic-registration.service';
import { seedQuestTags } from '@/modules/tag/tag.service';

import { eq } from 'drizzle-orm';

import { assertDemoSeedEnvironment, demoPassword } from './demo-seed';
import { seedDemoMembers } from './seed-demo-users';
import { seedDemoQuests } from './seed-demo-quests';

const main = async (): Promise<void> => {
  assertDemoSeedEnvironment();
  demoPassword();
  await seedAcademicOptions();
  console.log('1/4: Quest Tags');
  await seedQuestTags();
  console.log('2/4: Admin');
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('ADMIN_EMAIL is required for the complete seed flow.');
  const [admin] = await db
    .select({ id: authAdmin.id })
    .from(authAdmin)
    .where(eq(authAdmin.email, email))
    .limit(1);
  if (!admin) {
    const child = Bun.spawn(['bun', 'scripts/seed-admin.ts'], {
      env: process.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await child.exited) !== 0) throw new Error('Admin seed failed.');
  }
  console.log('3/4: 10 demo Members and complete Profiles');
  await seedDemoMembers();
  console.log('4/4: 10 funded Published Quests');
  await seedDemoQuests();
  console.log('Demo flow complete. Each new Member has 1,000 Baht available after Quest funding.');
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
