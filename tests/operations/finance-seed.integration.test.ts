/* eslint-disable no-await-in-loop -- Run seed steps and session assertions in order. */
import { db } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questImage } from '@/database/schema/quest.schema';
import { walletLedgerTransaction } from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth/staging-test-auth.route';
import { getAcademicRegistrationStatus } from '@/modules/academic-registration/academic-registration.service';
import { getWallet, verifyWalletProjection } from '@/modules/wallet';
import { demoMembers } from '@/shared/demo-members';

import { describe, expect, test } from 'bun:test';
import { and, eq, like } from 'drizzle-orm';

import { demoQuests } from '../../scripts/demo-quests';

const runSeed = async (script: string, overrides: Record<string, string>) => {
  const child = Bun.spawn(['bun', script], {
    env: { ...process.env, ...overrides },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: stdout + stderr };
};

describe('unified demo seed safety', () => {
  for (const script of [
    'scripts/seed-demo-users.ts',
    'scripts/seed-demo-quests.ts',
    'scripts/seed-staging.ts',
  ]) {
    test(`${script} refuses a production deployment`, async () => {
      const result = await runSeed(script, {
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        'allowed only in development/development or production/staging'
      );
    });
    test(`${script} refuses a configured production provider key`, async () => {
      const result = await runSeed(script, {
        NODE_ENV: 'development',
        DEPLOYMENT_ENV: 'development',
        XENDIT_SECRET_KEY: 'xnd_production_test-only',
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Xendit Development API key');
    });
  }
});

test('one flow creates ten login-ready Members and funded v2 Quests without repeated credit', async () => {
  const objects = new Map<string, Uint8Array>();
  // Exercise actual signed S3 uploads over HTTP without writing demo files to a shared bucket.
  const storage = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === 'PUT') {
        objects.set(new URL(request.url).pathname, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200, headers: { etag: '"demo-test"' } });
      }
      return new Response(null, { status: 404 });
    },
  });
  const password = process.env.STAGING_TEST_AUTH_PASSWORD ?? 'DemoPassword1!';
  const [admin] = await db.select({ email: authAdmin.email }).from(authAdmin).limit(1);
  const settings = {
    NODE_ENV: 'development',
    DEPLOYMENT_ENV: 'development',
    XENDIT_SECRET_KEY: 'xnd_development_test-only',
    STAGING_TEST_AUTH_PASSWORD: password,
    S3_ENDPOINT: `http://127.0.0.1:${storage.port}`,
    S3_BUCKET: 'demo-seed-test',
    S3_ACCESS_KEY_ID: 'demo-only',
    S3_SECRET_ACCESS_KEY: 'demo-only',
    S3_REGION: 'us-east-1',
    ADMIN_EMAIL: admin?.email ?? 'demo-bootstrap@ku.th',
    ADMIN_PASSWORD: 'DemoAdminPassword1!',
    ADMIN_FIRST_NAME: 'Demo',
    ADMIN_LAST_NAME: 'Operator',
    ADMIN_BETTER_AUTH_SECRET: 'demo-admin-secret-at-least-32-characters',
  };
  try {
    const flow = await runSeed('scripts/seed-staging.ts', settings);
    expect(flow.exitCode, flow.output).toBe(0);
    expect(flow.output).toContain('4/4: 10 funded Published Quests');
    const verification = await runSeed('scripts/verify-staging-seed.ts', settings);
    expect(verification.exitCode, verification.output).toBe(0);
    const loginApp = createStagingTestAuthRoute({
      enabled: true,
      deploymentEnv: 'staging',
      password,
    });
    const ids: string[] = [];
    const questIds: string[] = [];
    const dates: number[] = [];
    for (const [index, member] of demoMembers.entries()) {
      const [user] = await db.select().from(authUser).where(eq(authUser.email, member.email));
      expect(user).toBeDefined();
      expect(user!.telephone).toBe(member.telephone);
      expect(user!.imageFileId).toBeTruthy();
      expect((await getAcademicRegistrationStatus(user!.id))?.completed).toBe(true);
      const response = await loginApp.handle(
        new Request(`http://localhost/api/staging/test-auth/sign-in/${member.key}`, {
          method: 'POST',
        })
      );
      expect(response.status).toBe(200);
      const login = (await response.json()) as { user: { id: string; email: string } };
      expect(login.user.id).toBe(user!.id);
      expect(login.user.email).toBe(member.email);
      const rows = await db
        .select()
        .from(quest)
        .where(and(eq(quest.hirerId, user!.id), eq(quest.title, demoQuests[index]!.title)));
      expect(rows).toHaveLength(1);
      const seeded = rows[0]!;
      expect(seeded.apiVersion).toBe('v2');
      expect(seeded.questStatus).toBe('QUEST_OPEN');
      expect(seeded.fundingReservationId).toBeTruthy();
      expect(seeded.questEscrowSatang).toBe(demoQuests[index]!.fundingBaht * 100);
      expect(seeded.startTime.getTime()).toBeGreaterThan(
        seeded.createdAt.getTime() + 29 * 86_400_000
      );
      expect(seeded.dueAt!.getTime()).toBeGreaterThan(seeded.startTime.getTime());
      const images = await db.select().from(questImage).where(eq(questImage.questId, seeded.id));
      expect(images).toHaveLength(1);
      const wallet = await getWallet(user!.id);
      expect(Number(wallet.spendingBalanceSatang)).toBe(100_000);
      expect(Number(wallet.fundingReservedSatang)).toBe(seeded.questEscrowSatang!);
      expect((await verifyWalletProjection(wallet.id)).matches).toBe(true);
      ids.push(user!.id);
      questIds.push(seeded.id);
      dates.push(seeded.dueAt!.getTime());
    }
    expect(new Set(ids).size).toBe(10);
    expect(new Set(dates).size).toBe(10);
    const before = await db
      .select({ id: walletLedgerTransaction.id })
      .from(walletLedgerTransaction)
      .where(like(walletLedgerTransaction.businessReference, 'seed:demo:%:starter:v2'));
    const flowRetry = await runSeed('scripts/seed-staging.ts', settings);
    expect(flowRetry.exitCode, flowRetry.output).toBe(0);
    const memberRetry = await runSeed('scripts/seed-demo-users.ts', settings);
    expect(memberRetry.exitCode, memberRetry.output).toBe(0);
    const questRetry = await runSeed('scripts/seed-demo-quests.ts', settings);
    expect(questRetry.exitCode, questRetry.output).toBe(0);
    const after = await db
      .select({ id: walletLedgerTransaction.id })
      .from(walletLedgerTransaction)
      .where(like(walletLedgerTransaction.businessReference, 'seed:demo:%:starter:v2'));
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
    for (const [index, userId] of ids.entries()) {
      const [seeded] = await db.select().from(quest).where(eq(quest.id, questIds[index]!));
      expect(seeded!.dueAt!.getTime()).toBe(dates[index]!);
      expect(Number((await getWallet(userId)).spendingBalanceSatang)).toBe(100_000);
    }
  } finally {
    storage.stop(true);
  }
}, 120_000);

test('debug login never creates an unseeded Member', async () => {
  const email = `unseeded-${crypto.randomUUID()}@ku.th`;
  const route = createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email,
    password: 'DemoPassword1!',
    firstName: 'Missing',
    lastName: 'Member',
  });
  const response = await route.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/account-1', { method: 'POST' })
  );
  expect(response.status).toBe(401);
  expect(
    await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email))
  ).toHaveLength(0);
  const signUp = await route.handle(
    new Request('http://localhost/api/staging/test-auth/sign-up/email', { method: 'POST' })
  );
  expect(signUp.status).toBe(404);
});
