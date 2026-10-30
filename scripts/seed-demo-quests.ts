/* eslint-disable no-await-in-loop -- Run seed steps and session assertions in order. */
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questImage } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletLedgerAccount, walletLedgerTransaction } from '@/database/schema/wallet.schema';
import { createQuestV2, formatQuestV2ScheduleTime, publishQuestV2 } from '@/modules/quest/v2/core';
import {
  createSealedLedgerTransactionInTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  signedSatang,
} from '@/modules/wallet';
import { demoMembers } from '@/shared/demo-members';

import { and, eq, isNull, sql as drizzleSql } from 'drizzle-orm';

import { demoQuests } from './demo-quests';
import { assertDemoSeedEnvironment, storeDemoImage } from './demo-seed';

export const demoStarterSpendingSatang = 100_000;

const fundDemoQuest = async (userId: string, fundingSatang: number): Promise<void> => {
  const wallet = await ensureWallet(userId);
  await db.transaction(async (transaction) => {
    // Serialize the one-time adjustment; retries must not mint additional funds.
    await transaction.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtextextended(${`demo-wallet:${userId}`}, 0))`
    );
    const businessReference = `seed:demo:${userId}:starter:v2`;
    const [existing] = await transaction
      .select({ id: walletLedgerTransaction.id })
      .from(walletLedgerTransaction)
      .where(eq(walletLedgerTransaction.businessReference, businessReference))
      .limit(1);
    if (existing) return;
    const [spending] = await transaction
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(
        and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, 'SPENDING'))
      )
      .limit(1);
    const [suspense] = await transaction
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(
        and(isNull(walletLedgerAccount.walletId), eq(walletLedgerAccount.type, 'PLATFORM_SUSPENSE'))
      )
      .limit(1);
    if (!spending || !suspense) throw new Error('Demo Wallet Ledger Accounts are missing.');
    const amount = demoStarterSpendingSatang + fundingSatang;
    await createSealedLedgerTransactionInTransaction(transaction, {
      businessReference,
      eventType: 'ADJUSTMENT',
      createdByUserId: userId,
      description: 'Non-production demo: starter Spending Balance plus one Quest Funding Total',
      postings: [
        { accountId: spending.id, amountSatang: signedSatang(amount) },
        { accountId: suspense.id, amountSatang: signedSatang(-amount) },
      ],
    });
  });
};

export const seedDemoQuests = async (): Promise<void> => {
  assertDemoSeedEnvironment();
  await ensureInitialMoneyPolicy();
  const now = Date.now();
  for (const [index, member] of demoMembers.entries()) {
    const sample = demoQuests[index]!;
    const [user] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, member.email))
      .limit(1);
    if (!user)
      throw new Error(`Missing demo Member ${member.email}. Run db:seed-demo-users first.`);
    const [skill] = await db
      .select({ id: tag.id })
      .from(tag)
      .where(eq(tag.name, sample.tag))
      .limit(1);
    if (!skill) throw new Error(`Missing Quest Tag ${sample.tag}. Run db:seed-quest-tag first.`);
    // Stable identity and stored dates let partially completed runs resume safely.
    let [row] = await db
      .select()
      .from(quest)
      .where(
        and(eq(quest.hirerId, user.id), eq(quest.apiVersion, 'v2'), eq(quest.title, sample.title))
      )
      .limit(1);
    if (!row) {
      const created = await createQuestV2(
        user.id,
        {
          title: sample.title,
          description: sample.description,
          condition: { items: [...sample.conditions] },
          mode: 'CANDIDATE',
          participation: 'SINGLE',
          headcount: 1,
          questFundingTotal: sample.fundingBaht,
          tagId: skill.id,
          proofRequired: true,
          startTime: formatQuestV2ScheduleTime(new Date(now + sample.startDays * 86_400_000)),
          dueAt: formatQuestV2ScheduleTime(new Date(now + sample.dueDays * 86_400_000)),
          locations: [{ label: 'Kasetsart University, Bang Khen campus' }],
        },
        `demo-create-${member.key}-v2`
      );
      if (!('quest' in created))
        throw new Error(`Demo Quest creation failed: ${JSON.stringify(created)}`);
      [row] = await db.select().from(quest).where(eq(quest.id, created.quest.id)).limit(1);
    }
    if (!row) throw new Error('Demo Quest was not created.');
    if (row.questStatus === 'QUEST_DRAFT') {
      const imageId = await storeDemoImage(user.id, `demo/${user.id}/quest.jpg`, sample.imageAsset);
      await db
        .insert(questImage)
        .values({ questId: row.id, fileId: imageId, position: 0 })
        .onConflictDoNothing();
      await fundDemoQuest(user.id, row.questFundingTotalSatang!);
      const published = await publishQuestV2(user.id, row.id, `demo-publish-${member.key}-v2`);
      if (!published || !('quest' in published))
        throw new Error(`Demo Quest publish failed: ${JSON.stringify(published)}`);
    }
    // Preserve any real participation or terminal decision made after seeding.
    console.log(`Prepared Quest for ${member.firstName}: ${sample.title}`);
  }
};

if (import.meta.main) {
  try {
    await seedDemoQuests();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
