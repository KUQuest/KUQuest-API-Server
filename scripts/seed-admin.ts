import { assertAuthSecretLength } from '@/config/env';
import { db, sql } from '@/database/client';
import { authAdmin } from '@/database/schema/auth.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { isValidAdminPassword } from '@/modules/auth/admin-auth.policy';

import { sql as drizzleSql } from 'drizzle-orm';

const adminSeedLockName = 'kuquest:admin-seed';

const readRequiredEnv = (name: string, trim = true): string => {
  const rawValue = process.env[name];
  const value = trim ? rawValue?.trim() : rawValue;

  if (!value || (trim && !value.trim())) throw new Error(`${name} is required`);

  return value;
};

const main = async (): Promise<void> => {
  const adminSecret = readRequiredEnv('ADMIN_BETTER_AUTH_SECRET');
  const email = readRequiredEnv('ADMIN_EMAIL').toLowerCase();
  const password = readRequiredEnv('ADMIN_PASSWORD', false);
  const firstName = readRequiredEnv('ADMIN_FIRST_NAME');
  const lastName = readRequiredEnv('ADMIN_LAST_NAME');

  assertAuthSecretLength('ADMIN_BETTER_AUTH_SECRET', adminSecret);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('ADMIN_EMAIL must be a valid email address');
  }

  if (!isValidAdminPassword(password)) {
    throw new Error(
      'ADMIN_PASSWORD must be 8-25 characters with uppercase, lowercase, number, and special character, without whitespace'
    );
  }

  // Keep this transaction open for the full awaited critical section. Better Auth
  // uses its own pooled connection, so this transaction provides the advisory
  // lock only; Better Auth owns write atomicity.
  const result = await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(
      hashtextextended(${adminSeedLockName}, 0)
    )`;

    const [configuredAdmin] = await db
      .select({ email: authAdmin.email })
      .from(authAdmin)
      .where(drizzleSql`lower(${authAdmin.email}) = ${email}`)
      .limit(1);

    if (configuredAdmin) return null;

    const seedAuth = createAdminAuth({
      allowSignUp: true,
      autoSignIn: false,
      markEmailVerified: true,
    });

    return seedAuth.api.signUpEmail({
      body: {
        email,
        password,
        name: firstName,
        firstName,
        lastName,
      },
    });
  });

  if (!result) {
    console.log(`Admin ${email} already exists; no changes were made`);
    return;
  }

  if (!result.user) throw new Error('Better Auth did not create the Admin user');

  console.log(`Created Admin ${result.user.email}`);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Admin seed failed.');
  process.exitCode = 1;
} finally {
  await sql.end();
}
