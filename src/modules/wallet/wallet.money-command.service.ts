import { walletIdempotencyKey } from '@/database/schema/wallet.schema';

import { and, eq } from 'drizzle-orm';

import { MoneyDomainError } from './wallet.money';
import type { WalletTransaction } from './wallet.service';

const idempotencyExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

export type MoneyCommandKeyRow = typeof walletIdempotencyKey.$inferSelect;

export type MoneyCommandRef = {
  principalUserId: string;
  scope: string;
  key: string;
  requestHash: string;
};

export type MoneyCommandHooks<R> = {
  execute(transaction: WalletTransaction, keyId: string): Promise<R>;
  replay(transaction: WalletTransaction, keyRow: MoneyCommandKeyRow): Promise<R>;
};

/**
 * Runs one money command under one idempotency key. The command that inserts
 * the key row runs `execute`. A later caller with the same key gets `replay`.
 * The result does not say whether this run did the work or replayed it. This
 * function locks only the key row. The caller keeps its own lock order for
 * the domain rows.
 */
export const runMoneyCommand = async <R>(
  transaction: WalletTransaction,
  ref: MoneyCommandRef,
  hooks: MoneyCommandHooks<R>
): Promise<{ keyId: string; result: R }> => {
  const [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: ref.principalUserId,
      operationScope: ref.scope,
      key: ref.key,
      requestHash: ref.requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    return { keyId: created.id, result: await hooks.execute(transaction, created.id) };
  }

  const [keyRow] = await transaction
    .select()
    .from(walletIdempotencyKey)
    .where(
      and(
        eq(walletIdempotencyKey.principalUserId, ref.principalUserId),
        eq(walletIdempotencyKey.operationScope, ref.scope),
        eq(walletIdempotencyKey.key, ref.key)
      )
    )
    .for('update');

  if (!keyRow) {
    throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key could not be acquired.');
  }
  if (keyRow.requestHash !== ref.requestHash) {
    throw new MoneyDomainError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was used with a different request.'
    );
  }
  // A row with a pointer replays in any status. A completed row without a
  // pointer is the release shape. Every other lost row is still processing.
  if (keyRow.resourceId || keyRow.processingStatus === 'COMPLETED') {
    return { keyId: keyRow.id, result: await hooks.replay(transaction, keyRow) };
  }
  throw new MoneyDomainError(
    'IDEMPOTENCY_IN_PROGRESS',
    'An operation with this idempotency key is still processing.'
  );
};

/**
 * Stamps the resource pointer and completes the key row. The caller calls
 * this in the same transaction as `execute`, or in a later one.
 */
export const completeMoneyCommand = async (
  transaction: WalletTransaction,
  keyId: string,
  resourceType: string | null,
  resourceId: string | null
): Promise<void> => {
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType,
      resourceId,
      processingStatus: 'COMPLETED',
      completedAt: new Date(),
    })
    .where(eq(walletIdempotencyKey.id, keyId));
};
