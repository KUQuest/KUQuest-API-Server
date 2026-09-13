import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import {
  completeMoneyCommand,
  MoneyDomainError,
  runMoneyCommand,
  type MoneyCommandHooks,
} from '@/modules/wallet';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq, like } from 'drizzle-orm';

type TestCommandResult = {
  resourceId: string | null;
  label: string;
};

const createUser = async (prefix: string) => {
  const id = crypto.randomUUID();
  const email = `mc-${prefix}-${id}@ku.th`;
  await db.insert(authUser).values({ id, email, firstName: 'Money', lastName: 'Command' });
  return { id, email };
};

// Caller-side hook policy under test: `execute` inserts one resource row, so the
// row count proves how many times the work ran. `replay` reads the pointer, or
// returns the no-op result for a completed row without one (release shape).
const commandHooks = (
  resourceEmail: string,
  options: { failFirstExecution?: boolean } = {}
): MoneyCommandHooks<TestCommandResult> => {
  let firstExecution = true;
  return {
    execute: async (transaction) => {
      if (options.failFirstExecution && firstExecution) {
        firstExecution = false;
        throw new MoneyDomainError(
          'FUNDING_RESERVATION_OPERATION_FAILED',
          'The caller operation failed.'
        );
      }
      firstExecution = false;
      const resourceId = crypto.randomUUID();
      await transaction.insert(authUser).values({
        id: resourceId,
        email: resourceEmail,
        firstName: 'Resource',
        lastName: 'Command',
      });
      return { resourceId, label: resourceEmail };
    },
    replay: async (transaction, keyRow) => {
      if (!keyRow.resourceId) {
        return { resourceId: null, label: 'released' };
      }
      const [resource] = await transaction
        .select({ id: authUser.id, email: authUser.email })
        .from(authUser)
        .where(eq(authUser.id, keyRow.resourceId));
      if (!resource) {
        throw new MoneyDomainError(
          'IDEMPOTENCY_UNAVAILABLE',
          'The resource behind the idempotency pointer is missing.'
        );
      }
      return { resourceId: resource.id, label: resource.email };
    },
  };
};

const seedKeyRow = async (values: {
  principalUserId: string;
  scope: string;
  key: string;
  requestHash: string;
  processingStatus: 'PROCESSING' | 'COMPLETED';
  resourceId: string | null;
}) => {
  const [row] = await db
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: values.principalUserId,
      operationScope: values.scope,
      key: values.key,
      requestHash: values.requestHash,
      resourceType: values.resourceId === null ? null : 'wallet.test-resource',
      resourceId: values.resourceId,
      processingStatus: values.processingStatus,
      completedAt: values.processingStatus === 'COMPLETED' ? new Date() : null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();
  return row;
};

const resourceCount = async (email: string) => {
  const rows = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
  return rows.length;
};

const keyRowCount = async (principalUserId: string, scope: string, key: string) => {
  const rows = await db
    .select({ id: walletIdempotencyKey.id })
    .from(walletIdempotencyKey)
    .where(
      and(
        eq(walletIdempotencyKey.principalUserId, principalUserId),
        eq(walletIdempotencyKey.operationScope, scope),
        eq(walletIdempotencyKey.key, key)
      )
    );
  return rows.length;
};

beforeAll(async () => {
  await sql`select 1`;
});

afterAll(async () => {
  await db.delete(walletIdempotencyKey).where(like(walletIdempotencyKey.key, 'mc-%'));
  await db.delete(authUser).where(like(authUser.email, 'mc-%'));
});

describe('Money Command service', () => {
  it('replays a completed command through its resource pointer', async () => {
    const principal = await createUser('case1');
    const email = `mc-case1-resource-${crypto.randomUUID()}@ku.th`;
    const ref = {
      principalUserId: principal.id,
      scope: 'wallet.test.case1',
      key: `mc-case1-${crypto.randomUUID()}`,
      requestHash: `hash-${crypto.randomUUID()}`,
    };

    const first = await db.transaction(async (transaction) => {
      const outcome = await runMoneyCommand(transaction, ref, commandHooks(email));
      await completeMoneyCommand(
        transaction,
        outcome.keyId,
        'wallet.test-resource',
        outcome.result.resourceId
      );
      return outcome;
    });
    const replay = await db.transaction((transaction) =>
      runMoneyCommand(transaction, ref, commandHooks(email))
    );

    expect(replay.keyId).toBe(first.keyId);
    expect(replay.result).toEqual(first.result);
    expect(await resourceCount(email)).toBe(1);
  });

  it('rejects the same key with a different request hash', async () => {
    const principal = await createUser('case2');
    const email = `mc-case2-resource-${crypto.randomUUID()}@ku.th`;
    const ref = {
      principalUserId: principal.id,
      scope: 'wallet.test.case2',
      key: `mc-case2-${crypto.randomUUID()}`,
      requestHash: 'hash-a',
    };

    const first = await db.transaction(async (transaction) => {
      const outcome = await runMoneyCommand(transaction, ref, commandHooks(email));
      await completeMoneyCommand(
        transaction,
        outcome.keyId,
        'wallet.test-resource',
        outcome.result.resourceId
      );
      return outcome;
    });

    await expect(
      db.transaction((transaction) =>
        runMoneyCommand(transaction, { ...ref, requestHash: 'hash-b' }, commandHooks(email))
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await resourceCount(email)).toBe(1);
    expect(first.result.label).toBe(email);
  });

  it('runs one execution for concurrent commands with the same key', async () => {
    const principal = await createUser('case3');
    const email = `mc-case3-resource-${crypto.randomUUID()}@ku.th`;
    const ref = {
      principalUserId: principal.id,
      scope: 'wallet.test.case3',
      key: `mc-case3-${crypto.randomUUID()}`,
      requestHash: `hash-${crypto.randomUUID()}`,
    };
    const run = () =>
      db.transaction(async (transaction) => {
        const outcome = await runMoneyCommand(transaction, ref, commandHooks(email));
        await completeMoneyCommand(
          transaction,
          outcome.keyId,
          'wallet.test-resource',
          outcome.result.resourceId
        );
        return outcome;
      });

    const [first, second] = await Promise.all([run(), run()]);

    expect(second.keyId).toBe(first.keyId);
    expect(second.result).toEqual(first.result);
    expect(await resourceCount(email)).toBe(1);
  });

  it('erases the key row when execution rejects and re-executes on retry', async () => {
    const principal = await createUser('case4');
    const email = `mc-case4-resource-${crypto.randomUUID()}@ku.th`;
    const ref = {
      principalUserId: principal.id,
      scope: 'wallet.test.case4',
      key: `mc-case4-${crypto.randomUUID()}`,
      requestHash: `hash-${crypto.randomUUID()}`,
    };

    await expect(
      db.transaction((transaction) =>
        runMoneyCommand(transaction, ref, commandHooks(email, { failFirstExecution: true }))
      )
    ).rejects.toMatchObject({ code: 'FUNDING_RESERVATION_OPERATION_FAILED' });
    expect(await keyRowCount(ref.principalUserId, ref.scope, ref.key)).toBe(0);

    const retry = await db.transaction(async (transaction) => {
      const outcome = await runMoneyCommand(transaction, ref, commandHooks(email));
      await completeMoneyCommand(
        transaction,
        outcome.keyId,
        'wallet.test-resource',
        outcome.result.resourceId
      );
      return outcome;
    });

    expect(retry.result.label).toBe(email);
    expect(await resourceCount(email)).toBe(1);
  });

  it('lets the waiting command acquire the key after the first execution rolls back', async () => {
    const principal = await createUser('case5');
    const email = `mc-case5-resource-${crypto.randomUUID()}@ku.th`;
    const ref = {
      principalUserId: principal.id,
      scope: 'wallet.test.case5',
      key: `mc-case5-${crypto.randomUUID()}`,
      requestHash: `hash-${crypto.randomUUID()}`,
    };
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rejectingHooks: MoneyCommandHooks<TestCommandResult> = {
      execute: async () => {
        parked.resolve();
        await release.promise;
        throw new MoneyDomainError(
          'FUNDING_RESERVATION_OPERATION_FAILED',
          'The caller operation failed.'
        );
      },
      replay: async () => {
        throw new Error('The rejected command must not replay.');
      },
    };

    const firstRun = db.transaction((transaction) =>
      runMoneyCommand(transaction, ref, rejectingHooks)
    );
    await parked.promise;
    const secondRun = db.transaction(async (transaction) => {
      const outcome = await runMoneyCommand(transaction, ref, commandHooks(email));
      await completeMoneyCommand(
        transaction,
        outcome.keyId,
        'wallet.test-resource',
        outcome.result.resourceId
      );
      return outcome;
    });
    release.resolve();

    const [firstFailure, secondOutcome] = await Promise.all([
      firstRun.then(
        () => null,
        (error: unknown) => error
      ),
      secondRun,
    ]);

    expect(firstFailure).toBeInstanceOf(MoneyDomainError);
    expect(secondOutcome.result.label).toBe(email);
    expect(await resourceCount(email)).toBe(1);
    expect(await keyRowCount(ref.principalUserId, ref.scope, ref.key)).toBe(1);
  });

  it('replays seeded legacy key rows of every shape', async () => {
    const principal = await createUser('case6');
    const scope = 'wallet.test.case6';
    const resourceA = await createUser('case6-resource-a');
    const resourceB = await createUser('case6-resource-b');
    const rowA = await seedKeyRow({
      principalUserId: principal.id,
      scope,
      key: `mc-case6-a-${crypto.randomUUID()}`,
      requestHash: 'hash-a',
      processingStatus: 'COMPLETED',
      resourceId: resourceA.id,
    });
    const rowB = await seedKeyRow({
      principalUserId: principal.id,
      scope,
      key: `mc-case6-b-${crypto.randomUUID()}`,
      requestHash: 'hash-b',
      processingStatus: 'PROCESSING',
      resourceId: resourceB.id,
    });
    const rowC = await seedKeyRow({
      principalUserId: principal.id,
      scope,
      key: `mc-case6-c-${crypto.randomUUID()}`,
      requestHash: 'hash-c',
      processingStatus: 'COMPLETED',
      resourceId: null,
    });

    const replayA = await db.transaction((transaction) =>
      runMoneyCommand(
        transaction,
        {
          principalUserId: principal.id,
          scope,
          key: rowA.key,
          requestHash: 'hash-a',
        },
        commandHooks('unused-a')
      )
    );
    const replayB = await db.transaction((transaction) =>
      runMoneyCommand(
        transaction,
        {
          principalUserId: principal.id,
          scope,
          key: rowB.key,
          requestHash: 'hash-b',
        },
        commandHooks('unused-b')
      )
    );
    const replayC = await db.transaction((transaction) =>
      runMoneyCommand(
        transaction,
        {
          principalUserId: principal.id,
          scope,
          key: rowC.key,
          requestHash: 'hash-c',
        },
        commandHooks('unused-c')
      )
    );

    expect(replayA.keyId).toBe(rowA.id);
    expect(replayA.result).toEqual({ resourceId: resourceA.id, label: resourceA.email });
    expect(replayB.keyId).toBe(rowB.id);
    expect(replayB.result).toEqual({ resourceId: resourceB.id, label: resourceB.email });
    expect(replayC.keyId).toBe(rowC.id);
    expect(replayC.result).toEqual({ resourceId: null, label: 'released' });
  });

  it('reports a pointerless processing row as in progress', async () => {
    const principal = await createUser('case7');
    const row = await seedKeyRow({
      principalUserId: principal.id,
      scope: 'wallet.test.case7',
      key: `mc-case7-${crypto.randomUUID()}`,
      requestHash: 'hash-a',
      processingStatus: 'PROCESSING',
      resourceId: null,
    });

    await expect(
      db.transaction((transaction) =>
        runMoneyCommand(
          transaction,
          {
            principalUserId: principal.id,
            scope: 'wallet.test.case7',
            key: row.key,
            requestHash: 'hash-a',
          },
          commandHooks('unused-case7')
        )
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
  });

  it('completes a deferred command in a later transaction', async () => {
    const principal = await createUser('case8');
    const email = `mc-case8-resource-${crypto.randomUUID()}@ku.th`;
    const ref = {
      principalUserId: principal.id,
      scope: 'wallet.test.case8',
      key: `mc-case8-${crypto.randomUUID()}`,
      requestHash: `hash-${crypto.randomUUID()}`,
    };

    const first = await db.transaction((transaction) =>
      runMoneyCommand(transaction, ref, commandHooks(email))
    );
    await db.transaction((transaction) =>
      completeMoneyCommand(
        transaction,
        first.keyId,
        'wallet.test-resource',
        first.result.resourceId
      )
    );

    const [row] = await db
      .select()
      .from(walletIdempotencyKey)
      .where(eq(walletIdempotencyKey.id, first.keyId));
    expect(row).toMatchObject({
      resourceType: 'wallet.test-resource',
      resourceId: first.result.resourceId,
      processingStatus: 'COMPLETED',
    });
    expect(row.completedAt).toBeInstanceOf(Date);

    const replay = await db.transaction((transaction) =>
      runMoneyCommand(transaction, ref, commandHooks(email))
    );
    expect(replay.keyId).toBe(first.keyId);
    expect(replay.result).toEqual(first.result);
  });

  it('keeps the same key independent under two scopes', async () => {
    const principal = await createUser('case9');
    const emailA = `mc-case9-resource-a-${crypto.randomUUID()}@ku.th`;
    const emailB = `mc-case9-resource-b-${crypto.randomUUID()}@ku.th`;
    const key = `mc-case9-${crypto.randomUUID()}`;
    const refA = {
      principalUserId: principal.id,
      scope: 'wallet.test.case9-a',
      key,
      requestHash: 'hash-a',
    };
    const refB = {
      principalUserId: principal.id,
      scope: 'wallet.test.case9-b',
      key,
      requestHash: 'hash-a',
    };

    const runFor = (ref: typeof refA, email: string) =>
      db.transaction(async (transaction) => {
        const outcome = await runMoneyCommand(transaction, ref, commandHooks(email));
        await completeMoneyCommand(
          transaction,
          outcome.keyId,
          'wallet.test-resource',
          outcome.result.resourceId
        );
        return outcome;
      });
    const firstA = await runFor(refA, emailA);
    const firstB = await runFor(refB, emailB);
    const replayA = await db.transaction((transaction) =>
      runMoneyCommand(transaction, refA, commandHooks(emailA))
    );

    expect(firstB.keyId).not.toBe(firstA.keyId);
    expect(replayA.keyId).toBe(firstA.keyId);
    expect(replayA.result).toEqual(firstA.result);
    expect(await keyRowCount(principal.id, 'wallet.test.case9-a', key)).toBe(1);
    expect(await keyRowCount(principal.id, 'wallet.test.case9-b', key)).toBe(1);
  });

  it('returns a result without a first-run indicator', async () => {
    const principal = await createUser('case10');
    const email = `mc-case10-resource-${crypto.randomUUID()}@ku.th`;
    const ref = {
      principalUserId: principal.id,
      scope: 'wallet.test.case10',
      key: `mc-case10-${crypto.randomUUID()}`,
      requestHash: `hash-${crypto.randomUUID()}`,
    };

    const first = await db.transaction(async (transaction) => {
      const outcome = await runMoneyCommand(transaction, ref, commandHooks(email));
      await completeMoneyCommand(
        transaction,
        outcome.keyId,
        'wallet.test-resource',
        outcome.result.resourceId
      );
      return outcome;
    });
    const replay = await db.transaction((transaction) =>
      runMoneyCommand(transaction, ref, commandHooks(email))
    );

    expect(replay).toEqual(first);
    expect(Object.keys(replay).sort()).toEqual(['keyId', 'result']);
  });
});
