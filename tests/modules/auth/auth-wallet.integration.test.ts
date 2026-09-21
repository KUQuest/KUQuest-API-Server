import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  walletLedgerAccount,
  walletStatusHistory,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { createStudentAuth } from '@/modules/auth/auth.config';
import { getWallet } from '@/modules/wallet';

import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

describe('Member authentication wallet provisioning', () => {
  const testAuth = createStudentAuth({
    emailAndPasswordEnabled: true,
    allowEmailSignUp: true,
    autoSignIn: false,
  });

  it('automatically registers a Wallet when a Member signs up', async () => {
    const email = `signup-wallet-${crypto.randomUUID()}@ku.th`;
    const password = 'TestStudent1!';

    const signUpResult = await testAuth.api.signUpEmail({
      body: {
        email,
        password,
        name: 'Signup Wallet Tester',
        firstName: 'Signup',
        lastName: 'Tester',
      },
    });

    expect(signUpResult).toBeDefined();
    expect(signUpResult.user).toBeDefined();
    const userId = signUpResult.user.id;

    const [walletRow] = await db
      .select()
      .from(walletWallet)
      .where(eq(walletWallet.userId, userId))
      .limit(1);

    expect(walletRow).toBeDefined();
    expect(walletRow.walletStatus).toBe('ACTIVE');
    expect(walletRow.spendingBalanceSatang).toBe(0);
    expect(walletRow.earningsBalanceSatang).toBe(0);
    expect(walletRow.fundingReservedSatang).toBe(0);
    expect(walletRow.reservedForPayoutsSatang).toBe(0);

    const accounts = await db
      .select({ type: walletLedgerAccount.type })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.walletId, walletRow.id));

    expect(accounts.map(({ type }) => type).sort()).toEqual([
      'EARNINGS',
      'FUNDING_RESERVED',
      'RESERVED_FOR_PAYOUTS',
      'SPENDING',
    ]);

    const historyRows = await db
      .select()
      .from(walletStatusHistory)
      .where(eq(walletStatusHistory.walletId, walletRow.id));

    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].toStatus).toBe('ACTIVE');
    expect(historyRows[0].reason).toBe('Wallet provisioned');

    const walletFromService = await getWallet(userId);
    expect(walletFromService.id).toBe(walletRow.id);
  });

  it('reuses the existing Wallet on sign-in without duplicate status history', async () => {
    const email = `signin-wallet-${crypto.randomUUID()}@ku.th`;
    const password = 'TestStudent2!';

    const signUpResult = await testAuth.api.signUpEmail({
      body: {
        email,
        password,
        name: 'Signin Wallet Tester',
        firstName: 'Signin',
        lastName: 'Tester',
      },
    });

    const userId = signUpResult.user.id;
    const initialWallet = await getWallet(userId);

    const signInResult = await testAuth.api.signInEmail({
      body: {
        email,
        password,
      },
    });

    expect(signInResult).toBeDefined();
    expect(signInResult.user.id).toBe(userId);

    const walletAfterSignIn = await getWallet(userId);
    expect(walletAfterSignIn.id).toBe(initialWallet.id);

    const historyRows = await db
      .select()
      .from(walletStatusHistory)
      .where(eq(walletStatusHistory.walletId, initialWallet.id));

    expect(historyRows).toHaveLength(1);
  });

  it('provisions a Wallet on sign-in for a legacy Member who lacked one', async () => {
    // Simulate a legacy Member whose wallet does not exist by inserting directly without wallet
    const legacyEmail = `legacy-direct-${crypto.randomUUID()}@ku.th`;
    const legacyUserId = crypto.randomUUID();

    await db.insert(authUser).values({
      id: legacyUserId,
      email: legacyEmail,
      firstName: 'Direct',
      lastName: 'Legacy',
    });

    const [existingWalletBefore] = await db
      .select()
      .from(walletWallet)
      .where(eq(walletWallet.userId, legacyUserId));
    expect(existingWalletBefore).toBeUndefined();

    // Emulate session creation / signin hook triggering
    const hook = testAuth.options.databaseHooks?.session?.create?.after;
    expect(hook).toBeDefined();
    if (hook) {
      await hook({ userId: legacyUserId } as never);
    }

    const [walletAfterHook] = await db
      .select()
      .from(walletWallet)
      .where(eq(walletWallet.userId, legacyUserId));

    expect(walletAfterHook).toBeDefined();
    expect(walletAfterHook.walletStatus).toBe('ACTIVE');
    expect(walletAfterHook.spendingBalanceSatang).toBe(0);
  });
});
