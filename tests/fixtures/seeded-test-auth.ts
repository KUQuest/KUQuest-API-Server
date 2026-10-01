import { createStudentAuth } from '@/modules/auth';
import { createStagingTestAuthRoute as createReadOnlyTestAuthRoute } from '@/modules/auth/staging-test-auth.route';

import { Elysia } from 'elysia';

const fixtureAuth = createStudentAuth({
  emailAndPasswordEnabled: true,
  allowEmailSignUp: true,
  autoSignIn: false,
});
const fixtures = new Map<string, Promise<unknown>>();

export const createStagingTestAuthRoute = (
  options: Parameters<typeof createReadOnlyTestAuthRoute>[0]
) => {
  const accounts =
    options?.enabled && options.deploymentEnv === 'staging'
      ? [options, ...(options.account2?.email ? [options.account2] : [])]
      : [];
  const ready = Promise.all(
    accounts.map((account) => {
      if (!account.email) return Promise.resolve();
      let existing = fixtures.get(account.email);
      if (!existing) {
        existing = fixtureAuth.api.signUpEmail({
          body: {
            email: account.email,
            password: account.password!,
            name: account.firstName!,
            firstName: account.firstName!,
            lastName: account.lastName!,
          },
        });
        fixtures.set(account.email, existing);
      }
      return existing;
    })
  );
  return new Elysia({ name: `seeded-test-auth-${options?.email}` })
    .onRequest(async () => {
      await ready;
    })
    .use(createReadOnlyTestAuthRoute(options));
};
