import { db, sql } from '@/database/client';
import { authAdmin } from '@/database/schema/auth.schema';

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { eq, or } from 'drizzle-orm';

const adminSeedScript = join(import.meta.dir, '../../scripts/seed-admin.ts');

test('Admin seed refuses to create a second Admin', async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'This test needs PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }

  const existingAdminId = randomUUID();
  const existingAdminEmail = `${existingAdminId}@example.com`;
  const candidateEmail = `candidate-${randomUUID()}@example.com`;

  await db.insert(authAdmin).values({
    id: existingAdminId,
    email: existingAdminEmail,
    firstName: 'Existing',
    lastName: 'Admin',
  });

  try {
    const result = Bun.spawnSync(['bun', adminSeedScript], {
      env: {
        ...process.env,
        ADMIN_BETTER_AUTH_SECRET: 'admin-bootstrap-test-secret-at-least-32-characters',
        ADMIN_EMAIL: candidateEmail,
        ADMIN_FIRST_NAME: 'Candidate',
        ADMIN_LAST_NAME: 'Admin',
        ADMIN_PASSWORD: 'AdminPass1!',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('An Admin already exists');

    const admins = await db
      .select({ email: authAdmin.email })
      .from(authAdmin)
      .where(or(eq(authAdmin.email, existingAdminEmail), eq(authAdmin.email, candidateEmail)));

    expect(admins).toEqual([{ email: existingAdminEmail }]);
  } finally {
    await db
      .delete(authAdmin)
      .where(or(eq(authAdmin.id, existingAdminId), eq(authAdmin.email, candidateEmail)));
  }
});
