import { defaultLocalDatabaseUrl } from '@/config/default-database-url';
import { db, sql } from '@/database/client';
import { authAccount, authAdmin } from '@/database/schema/auth.schema';

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { eq, or } from 'drizzle-orm';

const adminSeedScript = join(import.meta.dir, '../../scripts/seed-admin.ts');

test('Admin seed creates the configured Admin when a different Admin already exists', async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'This test needs PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause }
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
        DATABASE_URL: process.env.DATABASE_URL ?? defaultLocalDatabaseUrl,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(0);
    expect(output).toContain(`Created Admin ${candidateEmail}`);

    const admins = await db
      .select({
        id: authAdmin.id,
        email: authAdmin.email,
        firstName: authAdmin.firstName,
        lastName: authAdmin.lastName,
      })
      .from(authAdmin)
      .where(or(eq(authAdmin.email, existingAdminEmail), eq(authAdmin.email, candidateEmail)));

    expect(admins).toHaveLength(2);
    expect(admins).toContainEqual({
      id: existingAdminId,
      email: existingAdminEmail,
      firstName: 'Existing',
      lastName: 'Admin',
    });
    expect(admins.find((admin) => admin.email === candidateEmail)).toMatchObject({
      email: candidateEmail,
      firstName: 'Candidate',
      lastName: 'Admin',
    });
  } finally {
    await db
      .delete(authAdmin)
      .where(or(eq(authAdmin.id, existingAdminId), eq(authAdmin.email, candidateEmail)));
  }
});

test('Admin seed leaves the configured Admin unchanged on repeat runs', async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'This test needs PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause }
    );
  }

  const existingAdminId = randomUUID();
  const existingAdminEmail = `${existingAdminId}@example.com`;

  try {
    const initialResult = Bun.spawnSync(['bun', adminSeedScript], {
      env: {
        ...process.env,
        ADMIN_BETTER_AUTH_SECRET: 'admin-bootstrap-test-secret-at-least-32-characters',
        ADMIN_EMAIL: existingAdminEmail,
        ADMIN_FIRST_NAME: 'Existing',
        ADMIN_LAST_NAME: 'Admin',
        ADMIN_PASSWORD: 'AdminPass1!',
        DATABASE_URL: process.env.DATABASE_URL ?? defaultLocalDatabaseUrl,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const initialOutput = `${initialResult.stdout.toString()}${initialResult.stderr.toString()}`;

    expect(initialResult.exitCode).toBe(0);
    expect(initialOutput).toContain(`Created Admin ${existingAdminEmail}`);

    const [createdAdmin] = await db
      .select({ id: authAdmin.id, email: authAdmin.email })
      .from(authAdmin)
      .where(eq(authAdmin.email, existingAdminEmail));
    const [initialAccount] = await db
      .select({ password: authAccount.password })
      .from(authAccount)
      .where(eq(authAccount.adminId, createdAdmin.id));

    expect(initialAccount?.password).toBeTruthy();

    const result = Bun.spawnSync(['bun', adminSeedScript], {
      env: {
        ...process.env,
        ADMIN_BETTER_AUTH_SECRET: 'admin-bootstrap-test-secret-at-least-32-characters',
        ADMIN_EMAIL: existingAdminEmail,
        ADMIN_FIRST_NAME: 'Changed',
        ADMIN_LAST_NAME: 'Name',
        ADMIN_PASSWORD: 'ChangedPass2!',
        DATABASE_URL: process.env.DATABASE_URL ?? defaultLocalDatabaseUrl,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(0);
    expect(output).toContain('already exists; no changes were made');

    const admins = await db
      .select({
        id: authAdmin.id,
        email: authAdmin.email,
        firstName: authAdmin.firstName,
        lastName: authAdmin.lastName,
      })
      .from(authAdmin)
      .where(eq(authAdmin.email, existingAdminEmail));
    const [repeatedAccount] = await db
      .select({ password: authAccount.password })
      .from(authAccount)
      .where(eq(authAccount.adminId, createdAdmin.id));

    expect(admins).toEqual([
      {
        id: createdAdmin.id,
        email: existingAdminEmail,
        firstName: 'Existing',
        lastName: 'Admin',
      },
    ]);
    expect(repeatedAccount?.password).toBe(initialAccount.password);
  } finally {
    await db.delete(authAdmin).where(eq(authAdmin.email, existingAdminEmail));
  }
});
