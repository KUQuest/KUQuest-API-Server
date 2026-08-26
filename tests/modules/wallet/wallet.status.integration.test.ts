import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import {
  walletStatusHistory,
  walletWallet,
  type WalletStatus,
} from '@/database/schema/wallet.schema';
import {
  assertWalletOperationAllowed,
  changeWalletStatus,
  changeWalletStatusInTransaction,
  listWalletStatusHistory,
  MoneyDomainError,
  type MoneyDomainErrorCode,
  type WalletOperation,
} from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql as drizzleSql } from 'drizzle-orm';

const createStudentWallet = async (prefix: string) => {
  const userId = `${prefix}-${crypto.randomUUID()}`;
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'Wallet',
    lastName: 'Status',
  });
  const [wallet] = await db.insert(walletWallet).values({ userId }).returning();
  if (!wallet) throw new Error('Test Wallet could not be created.');
  await db.insert(walletStatusHistory).values({
    walletId: wallet.id,
    toStatus: 'ACTIVE',
    reason: 'Test Wallet provisioned',
  });
  return { userId, wallet };
};

const createAdmin = async () => {
  const id = `be112-admin-${crypto.randomUUID()}`;
  await db.insert(authAdmin).values({
    id,
    email: `${id}@example.com`,
    firstName: 'Wallet',
    lastName: 'Admin',
  });
  return id;
};

const expectDomainErrorCode = (callback: () => void, code: MoneyDomainErrorCode) => {
  try {
    callback();
    throw new Error('Expected a domain error.');
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyDomainError);
    expect((error as MoneyDomainError).code).toBe(code);
  }
};

beforeAll(async () => {
  await sql`select 1`;
});

describe('Wallet status service', () => {
  it('allows Student money commands only for an Active Wallet', () => {
    const studentCommands: WalletOperation[] = [
      'TOP_UP',
      'EARNINGS_CONVERSION',
      'FUNDING_RESERVATION',
      'PAYOUT',
    ];
    const obligationOperations: WalletOperation[] = [
      'CONFIRMED_INBOUND_CREDIT',
      'EARNINGS_SETTLEMENT',
      'FUNDING_RELEASE',
      'PAYOUT_FAILURE_RELEASE',
      'PROVIDER_PROCESSING',
      'RECONCILIATION',
    ];

    for (const operation of studentCommands) {
      expect(() => assertWalletOperationAllowed('ACTIVE', operation)).not.toThrow();
      for (const status of ['FROZEN', 'SUSPENDED', 'CLOSED'] as const) {
        expectDomainErrorCode(
          () => assertWalletOperationAllowed(status, operation),
          'WALLET_NOT_ACTIVE',
        );
      }
    }

    for (const operation of obligationOperations) {
      for (const status of ['ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED'] as const) {
        expect(() => assertWalletOperationAllowed(status, operation)).not.toThrow();
      }
    }
  });

  it('records the actor, previous status, new status, reason, and timestamp', async () => {
    const { wallet } = await createStudentWallet('be112-history');
    const adminId = await createAdmin();

    const changed = await changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'FROZEN',
      actorAdminId: adminId,
      reason: 'Administrative review',
    });

    expect(changed).toMatchObject({
      wallet: { id: wallet.id, walletStatus: 'FROZEN' },
      history: {
        walletId: wallet.id,
        fromStatus: 'ACTIVE',
        toStatus: 'FROZEN',
        actorAdminId: adminId,
        reason: 'Administrative review',
      },
    });
    expect(changed.history.occurredAt).toBeInstanceOf(Date);
  });

  it('keeps Closed terminal and refuses a same-status transition', async () => {
    const { wallet } = await createStudentWallet('be112-closed');
    const adminId = await createAdmin();

    await changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'CLOSED',
      actorAdminId: adminId,
      reason: 'Wallet closed',
    });

    await expect(changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'ACTIVE',
      actorAdminId: adminId,
      reason: 'Reopen attempt',
    })).rejects.toMatchObject({ code: 'WALLET_STATUS_CLOSED' });

    await expect(changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'CLOSED',
      actorAdminId: adminId,
      reason: 'Duplicate close',
    })).rejects.toMatchObject({ code: 'WALLET_STATUS_UNCHANGED' });
  });

  it('serializes concurrent changes into one coherent history', async () => {
    const { wallet } = await createStudentWallet('be112-concurrent');
    const adminId = await createAdmin();

    const results = await Promise.all([
      changeWalletStatus({
        walletId: wallet.id,
        toStatus: 'FROZEN',
        actorAdminId: adminId,
        reason: 'Freeze Wallet',
      }),
      changeWalletStatus({
        walletId: wallet.id,
        toStatus: 'SUSPENDED',
        actorAdminId: adminId,
        reason: 'Suspend Wallet',
      }),
    ]);

    expect(results.map(({ wallet: changedWallet }) => changedWallet.walletStatus).sort()).toEqual([
      'FROZEN',
      'SUSPENDED',
    ]);
    const history = await listWalletStatusHistory(wallet.id);
    expect(history).toHaveLength(3);
    expect(history.slice(1).map(({ fromStatus }) => fromStatus)).toEqual([
      history[0]?.toStatus,
      history[1]?.toStatus,
    ]);
    expect(new Set(history.slice(1).map(({ toStatus }) => toStatus))).toEqual(
      new Set<WalletStatus>(['FROZEN', 'SUSPENDED']),
    );
  });

  it('orders history by the serialized transition time', async () => {
    const { wallet } = await createStudentWallet('be112-ordering');
    const adminId = await createAdmin();
    let delayedTransactionStarted!: () => void;
    const delayedTransactionReady = new Promise<void>((resolve) => {
      delayedTransactionStarted = resolve;
    });

    const delayedChange = db.transaction(async (transaction) => {
      await transaction.execute(drizzleSql`select 1`);
      delayedTransactionStarted();
      await Bun.sleep(50);
      return changeWalletStatusInTransaction(transaction, {
        walletId: wallet.id,
        toStatus: 'FROZEN',
        actorAdminId: adminId,
        reason: 'Delayed freeze',
      });
    });
    await delayedTransactionReady;

    const immediateChange = changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'SUSPENDED',
      actorAdminId: adminId,
      reason: 'Immediate suspension',
    });
    await Promise.all([delayedChange, immediateChange]);

    const history = await listWalletStatusHistory(wallet.id);
    expect(history.slice(1).map(({ fromStatus }) => fromStatus)).toEqual([
      history[0]?.toStatus,
      history[1]?.toStatus,
    ]);
  });

  it('rolls back the status change when the actor reference fails', async () => {
    const { wallet } = await createStudentWallet('be112-atomicity');
    const historyBefore = await listWalletStatusHistory(wallet.id);

    await expect(changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'FROZEN',
      actorAdminId: crypto.randomUUID(),
      reason: 'Invalid actor',
    })).rejects.toThrow();

    const [unchangedWallet] = await db
      .select()
      .from(walletWallet)
      .where(eq(walletWallet.id, wallet.id));
    expect(unchangedWallet?.walletStatus).toBe('ACTIVE');
    expect(await listWalletStatusHistory(wallet.id)).toEqual(historyBefore);
  });

  it('rejects updates and deletes against retained status history', async () => {
    const { wallet } = await createStudentWallet('be112-append-only');
    const [history] = await db
      .select()
      .from(walletStatusHistory)
      .where(eq(walletStatusHistory.walletId, wallet.id));
    if (!history) throw new Error('Test status history could not be created.');

    await expect(db
      .update(walletStatusHistory)
      .set({ reason: 'Tampered history' })
      .where(eq(walletStatusHistory.id, history.id))
      .execute()).rejects.toThrow();
    await expect(db
      .delete(walletStatusHistory)
      .where(eq(walletStatusHistory.id, history.id))
      .execute()).rejects.toThrow();
  });
});
