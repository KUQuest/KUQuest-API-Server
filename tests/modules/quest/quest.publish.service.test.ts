import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  walletFundingReservation,
  walletLedgerAccount,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  createQuest,
  getQuestPublishCheck,
  publishQuest,
} from '@/modules/quest/quest.service';
import type { QuestCreateInput } from '@/modules/quest/quest.schema';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  signedSatang,
} from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

const hirerId = randomUUID();
const otherMemberId = randomUUID();
const tagId = randomUUID();
let questIds: string[] = [];

const baseInput: QuestCreateInput = {
  title: 'A Quest for publishing',
  description: 'A description',
  condition: 'A completed result',
  mode: 'NO_CANDIDATE',
  participation: 'SOLO',
  reward: 500,
  headcount: 1,
  startTime: '2030-08-27T10:00:00.000Z',
  dueAt: '2030-08-27T12:00:00.000Z',
  tagId,
  proofRequired: true,
  locations: [],
};

const fundHirer = async (amountSatang: number) => {
  const wallet = await ensureWallet(hirerId);
  const [spendingAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(
      eq(walletLedgerAccount.walletId, wallet.id),
      eq(walletLedgerAccount.type, 'SPENDING'),
    ));
  const [suspenseAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  if (!spendingAccount || !suspenseAccount) throw new Error('Missing funding accounts');

  await createSealedLedgerTransaction({
    businessReference: `quest-publish-funding-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spendingAccount.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspenseAccount.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const createFixture = async (input: Partial<QuestCreateInput> = {}) => {
  await fundHirer(100_000);
  const result = await createQuest(hirerId, { ...baseInput, ...input });
  if ('outcome' in result) throw new Error(`Fixture creation failed: ${result.outcome}`);

  questIds.push(result.id);
  return result.id;
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error('These tests need PostgreSQL. Start the local database first.', { cause });
  }

  await db.insert(authUser).values([
    {
      id: hirerId,
      email: `${hirerId}@ku.th`,
      firstName: 'Publish',
      lastName: 'Hirer',
    },
    {
      id: otherMemberId,
      email: `${otherMemberId}@ku.th`,
      firstName: 'Other',
      lastName: 'Member',
    },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Publish test ${tagId}` });
  await ensureInitialMoneyPolicy();
});

beforeEach(async () => {
  if (questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds = [];
  }
});

afterAll(async () => {
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest publishing service', () => {
  it('returns the publish preview for the Hirer', async () => {
    const questId = await createFixture();

    expect(await getQuestPublishCheck(hirerId, questId)).toEqual({
      blockingReasons: [],
      warnings: [
        {
          code: 'QUEST_IMAGES_MISSING',
          message: 'Quest has no images',
        },
        {
          code: 'QUEST_LOCATIONS_MISSING',
          message: 'Quest has no locations',
        },
      ],
      escrowRequirement: 510,
      canPublish: true,
    });
  });

  it('returns the first blocking reason and leaves the Quest as Draft', async () => {
    const questId = await createFixture({ tagId: null, dueAt: null });
    const [before] = await db
      .select({ status: quest.questStatus, updatedAt: quest.updatedAt })
      .from(quest)
      .where(eq(quest.id, questId));

    const result = await publishQuest(hirerId, questId);

    expect(result).toMatchObject({
      outcome: 'blocked',
      check: {
        blockingReasons: [
          {
            code: 'QUEST_TAG_REQUIRED',
            message: 'Quest requires a Tag',
          },
          {
            code: 'QUEST_DURATION_REQUIRED',
            message: 'Quest requires an estimated duration',
          },
        ],
      },
    });

    const [after] = await db
      .select({ status: quest.questStatus, updatedAt: quest.updatedAt })
      .from(quest)
      .where(eq(quest.id, questId));
    expect(after).toEqual(before);
  });

  it('reserves Quest Escrow before changing a valid Draft to Open', async () => {
    const questId = await createFixture();
    const [beforeWallet] = await db
      .select({ spending: walletWallet.spendingBalanceSatang, reserved: walletWallet.fundingReservedSatang })
      .from(walletWallet)
      .where(eq(walletWallet.userId, hirerId));
    const preview = await getQuestPublishCheck(hirerId, questId);

    expect(await publishQuest(hirerId, questId)).toEqual({ outcome: 'published' });

    const [reservation] = await db
      .select()
      .from(walletFundingReservation)
      .where(and(
        eq(walletFundingReservation.ownerUserId, hirerId),
        eq(walletFundingReservation.callerScope, 'quest'),
        eq(walletFundingReservation.callerReference, questId),
      ));
    expect(reservation).toMatchObject({
      totalReservedSatang: 51_000,
      remainingSatang: 51_000,
      status: 'ACTIVE',
    });
    if (!preview || 'outcome' in preview) throw new Error('Missing publish preview');
    expect(preview).toMatchObject({ escrowRequirement: 510, canPublish: true });
    expect(preview.escrowRequirement * 100).toBe(reservation?.totalReservedSatang);
    const [wallet] = await db
      .select({ spending: walletWallet.spendingBalanceSatang, reserved: walletWallet.fundingReservedSatang })
      .from(walletWallet)
      .where(eq(walletWallet.userId, hirerId));
    expect(wallet).toEqual({
      spending: (beforeWallet?.spending ?? 0) - 51_000,
      reserved: (beforeWallet?.reserved ?? 0) + 51_000,
    });

    const [stored] = await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(stored?.status).toBe('QUEST_OPEN');
  });

  it('keeps the Draft and Wallet unchanged when Escrow cannot be funded', async () => {
    const questId = await createFixture({ reward: 600_000 });
    const [beforeWallet] = await db
      .select({ spending: walletWallet.spendingBalanceSatang, reserved: walletWallet.fundingReservedSatang })
      .from(walletWallet)
      .where(eq(walletWallet.userId, hirerId));

    await expect(publishQuest(hirerId, questId)).rejects.toMatchObject({
      code: 'INSUFFICIENT_SPENDING_BALANCE',
    });

    const [stored] = await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    const [afterWallet] = await db
      .select({ spending: walletWallet.spendingBalanceSatang, reserved: walletWallet.fundingReservedSatang })
      .from(walletWallet)
      .where(eq(walletWallet.userId, hirerId));
    expect(stored?.status).toBe('QUEST_DRAFT');
    expect(afterWallet).toEqual(beforeWallet);
    expect(await db
      .select()
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.callerReference, questId))).toHaveLength(0);
  });

  it('does not expose another Member\'s Quest and rejects a non-Draft', async () => {
    const questId = await createFixture();

    expect(await getQuestPublishCheck(otherMemberId, questId)).toBeUndefined();

    await publishQuest(hirerId, questId);

    expect(await getQuestPublishCheck(hirerId, questId)).toEqual({ outcome: 'not-draft' });
    expect(await publishQuest(hirerId, questId)).toEqual({ outcome: 'not-draft' });
  });

  it('allows only one concurrent publish to win', async () => {
    const questId = await createFixture();

    const results = await Promise.all([
      publishQuest(hirerId, questId),
      publishQuest(hirerId, questId),
    ]);

    expect(results.filter((result) => result?.outcome === 'published')).toHaveLength(1);
    expect(results.filter((result) => result?.outcome === 'not-draft')).toHaveLength(1);
    expect(await db
      .select()
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.callerReference, questId))).toHaveLength(1);
  });
});
