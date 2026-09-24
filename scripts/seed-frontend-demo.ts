import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { department, occupation } from '@/database/schema/academic.schema';
import { adminDisputeCase, disputeCaseStatus } from '@/database/schema/admin.schema';
import {
  profileCertificate,
  profilePortfolioItem,
  profileWorkExperience,
} from '@/database/schema/profile.schema';
import { tag } from '@/database/schema/tag.schema';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';
import { walletLedgerAccount, walletLedgerTransaction } from '@/database/schema/wallet.schema';
import {
  assignmentStatus,
  questMode,
  questParticipation,
  questStatus,
} from '@/modules/quest/shared';
import {
  createSealedLedgerTransactionInTransaction,
  ensureInitialMoneyPolicy,
  ensureWalletInTransaction,
  positiveSatang,
  reserveSpending,
  signedSatang,
  type WalletTransaction,
} from '@/modules/wallet';
import { fixedTagNames, type FixedTagName } from '@/shared/tag';

import { and, eq, inArray, isNull, like, ne } from 'drizzle-orm';

export const frontendDemoDisputeQuestTitle = '[Demo] Failed Dispute Quest';
export const frontendDemoDisputeAmountSatang = 50_000;
export const frontendDemoDisputeReservationReference = 'frontend-demo-dispute-quest-v1';
const DEMO_USERS = [
  {
    firstName: 'Nattapong',
    lastName: 'Srisawat',
    department: 'Software and Knowledge Engineering',
  },
  { firstName: 'Warisara', lastName: 'Boonmee', department: 'Marketing' },
  { firstName: 'Thanakrit', lastName: 'Chaiyasit', department: 'Economics' },
  { firstName: 'Supitcha', lastName: 'Wongsakul', department: 'Bachelor of Accountancy' },
  { firstName: 'Kritchapon', lastName: 'Phromma', department: 'Tropical Agriculture' },
  { firstName: 'Aphinya', lastName: 'Sukjai', department: 'Integrated Tourism Management' },
  { firstName: 'Pattarapon', lastName: 'Ruangrit', department: 'Business Administration' },
  {
    firstName: 'Chutimon',
    lastName: 'Thepsuriya',
    department: 'Communicative Thai Language for Foreigners',
  },
  { firstName: 'Ekkapop', lastName: 'Wattana', department: 'Entrepreneurial Economics' },
  { firstName: 'Nichakan', lastName: 'Kaewmanee', department: 'Marketing' },
] as const;

const demoEmails = DEMO_USERS.map(
  ({ firstName, lastName }) => `${firstName.toLowerCase()}.${lastName.toLowerCase()}@ku.th`
);

const getOrCreateTag = async (name: string): Promise<string> => {
  const [existing] = await db.select({ id: tag.id }).from(tag).where(eq(tag.name, name)).limit(1);
  if (existing) return existing.id;

  const [created] = await db.insert(tag).values({ name }).returning({ id: tag.id });
  if (!created) throw new Error(`Failed to create tag ${name}`);
  return created.id;
};

const ensureAdminDisputeCaseInTransaction = async (
  transaction: WalletTransaction,
  questId: string,
  filerUserId: string
): Promise<{ id: string }> => {
  const [existingCase] = await transaction
    .select({
      id: adminDisputeCase.id,
    })
    .from(adminDisputeCase)
    .where(
      and(eq(adminDisputeCase.questId, questId), eq(adminDisputeCase.filerUserId, filerUserId))
    )
    .for('update');

  if (existingCase) {
    return { id: existingCase.id };
  }

  const [targetQuest] = await transaction
    .select({
      id: quest.id,
      questStatus: quest.questStatus,
      fundingReservationId: quest.fundingReservationId,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .for('update');

  if (!targetQuest) {
    throw new Error('The Quest for the Dispute Case does not exist.');
  }
  if (targetQuest.questStatus !== questStatus.failed) {
    throw new Error('The frontend demo Dispute Quest is not failed.');
  }
  if (!targetQuest.fundingReservationId) {
    throw new Error('The frontend demo Dispute Quest has no Funding Reservation.');
  }

  const [created] = await transaction
    .insert(adminDisputeCase)
    .values({
      questId,
      filerUserId,
      status: disputeCaseStatus.pending,
    })
    .onConflictDoNothing({
      target: [adminDisputeCase.questId, adminDisputeCase.filerUserId],
    })
    .returning({ id: adminDisputeCase.id });

  if (created) {
    return { id: created.id };
  }

  const [reloaded] = await transaction
    .select({ id: adminDisputeCase.id })
    .from(adminDisputeCase)
    .where(
      and(eq(adminDisputeCase.questId, questId), eq(adminDisputeCase.filerUserId, filerUserId))
    )
    .limit(1);

  if (!reloaded) {
    throw new Error('The frontend demo Dispute Case could not be created.');
  }

  return { id: reloaded.id };
};

const getSpendingWalletAccountIdInTransaction = async (
  transaction: WalletTransaction,
  userId: string
): Promise<string> => {
  const wallet = await ensureWalletInTransaction(transaction, userId);
  const [account] = await transaction
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(
      and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, 'SPENDING'))
    )
    .limit(1);
  if (!account) throw new Error('The demo SPENDING Ledger Account is missing.');
  return account.id;
};

const getPlatformSuspenseAccountIdInTransaction = async (
  transaction: WalletTransaction
): Promise<string> => {
  const [account] = await transaction
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(
      and(eq(walletLedgerAccount.type, 'PLATFORM_SUSPENSE'), isNull(walletLedgerAccount.walletId))
    )
    .limit(1);
  if (!account) throw new Error('The platform suspense Ledger Account is missing.');
  return account.id;
};

const seedDemoHirerSpendingInTransaction = async (
  transaction: WalletTransaction,
  userId: string
): Promise<void> => {
  const businessReference = `seed:frontend-demo:${userId}:spending:v1`;
  const [existing] = await transaction
    .select({ id: walletLedgerTransaction.id })
    .from(walletLedgerTransaction)
    .where(eq(walletLedgerTransaction.businessReference, businessReference))
    .limit(1);
  if (existing) return;

  const walletAccountId = await getSpendingWalletAccountIdInTransaction(transaction, userId);
  const suspenseAccountId = await getPlatformSuspenseAccountIdInTransaction(transaction);
  await createSealedLedgerTransactionInTransaction(transaction, {
    businessReference,
    eventType: 'ADJUSTMENT',
    createdByUserId: userId,
    description: 'Non-production frontend demo seed',
    postings: [
      {
        accountId: walletAccountId,
        amountSatang: signedSatang(frontendDemoDisputeAmountSatang),
      },
      {
        accountId: suspenseAccountId,
        amountSatang: signedSatang(-frontendDemoDisputeAmountSatang),
      },
    ],
  });
};

export const ensureFrontendDemoDisputeQuest = async (
  hirerId: string,
  workerId: string,
  tagId: string
): Promise<{ questId: string; disputeCaseId: string }> => {
  await ensureInitialMoneyPolicy();
  return db.transaction(async (transaction) => {
    await ensureWalletInTransaction(transaction, hirerId);
    await seedDemoHirerSpendingInTransaction(transaction, hirerId);

    const [existing] = await transaction
      .select({
        id: quest.id,
        fundingReservationId: quest.fundingReservationId,
        questStatus: quest.questStatus,
      })
      .from(quest)
      .where(and(eq(quest.hirerId, hirerId), eq(quest.title, frontendDemoDisputeQuestTitle)))
      .for('update');

    if (existing) {
      if (existing.questStatus !== questStatus.failed) {
        throw new Error('The frontend demo Dispute Quest is not failed.');
      }
      if (!existing.fundingReservationId) {
        throw new Error('The frontend demo Dispute Quest has no Funding Reservation.');
      }
      const [assignment] = await transaction
        .select({ id: questAssignment.id })
        .from(questAssignment)
        .where(
          and(eq(questAssignment.questId, existing.id), eq(questAssignment.workerId, workerId))
        )
        .limit(1);
      if (!assignment) {
        await transaction.insert(questAssignment).values({
          questId: existing.id,
          workerId,
          assignmentStatus: assignmentStatus.incomplete,
        });
      }
      const disputeCase = await ensureAdminDisputeCaseInTransaction(
        transaction,
        existing.id,
        workerId
      );
      return { questId: existing.id, disputeCaseId: disputeCase.id };
    }

    const reservation = await reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: frontendDemoDisputeReservationReference,
      amountSatang: positiveSatang(frontendDemoDisputeAmountSatang),
    });

    const failedAt = new Date(Date.now() - 60 * 60 * 1000);
    const [created] = await transaction
      .insert(quest)
      .values({
        hirerId,
        title: frontendDemoDisputeQuestTitle,
        description: 'A failed Quest for Admin Dispute review.',
        condition: 'Review the seeded Dispute Case evidence.',
        mode: questMode.noCandidate,
        participation: questParticipation.solo,
        questStatus: questStatus.failed,
        version: 1,
        rewardSatang: positiveSatang(frontendDemoDisputeAmountSatang),
        questFundingTotalSatang: positiveSatang(frontendDemoDisputeAmountSatang),
        fundingReservationId: reservation.id,
        policyRevisionId: reservation.policyRevisionId,
        platformFeeBps: 0,
        platformFeePerWorkerSatang: 0,
        questEscrowSatang: positiveSatang(frontendDemoDisputeAmountSatang),
        tagId,
        headcount: 1,
        startTime: new Date(failedAt.getTime() - 2 * 60 * 60 * 1000),
        dueAt: new Date(failedAt.getTime() - 60 * 60 * 1000),
        failedAt,
        proofRequired: true,
        createdAt: new Date(failedAt.getTime() - 3 * 60 * 60 * 1000),
        updatedAt: failedAt,
      })
      .returning({ id: quest.id });
    if (!created) throw new Error('The frontend demo Dispute Quest could not be created.');

    const [assignment] = await transaction
      .insert(questAssignment)
      .values({
        questId: created.id,
        workerId,
        assignmentStatus: assignmentStatus.incomplete,
      })
      .returning({ id: questAssignment.id });
    if (!assignment)
      throw new Error('The frontend demo Dispute Quest Assignment could not be created.');

    const disputeCase = await ensureAdminDisputeCaseInTransaction(
      transaction,
      created.id,
      workerId
    );
    return { questId: created.id, disputeCaseId: disputeCase.id };
  });
};

const main = async (): Promise<void> => {
  const users = await db
    .select({
      id: authUser.id,
      email: authUser.email,
      departmentId: authUser.departmentId,
      occupationId: authUser.occupationId,
    })
    .from(authUser)
    .where(inArray(authUser.email, demoEmails));

  if (users.length !== DEMO_USERS.length) {
    throw new Error(
      `Expected ${DEMO_USERS.length} demo users. Run db:seed-demo-users first; found ${users.length}.`
    );
  }

  const studentOccupation =
    users.find(({ occupationId }) => occupationId)?.occupationId ??
    (
      await db
        .select({ id: occupation.id })
        .from(occupation)
        .where(eq(occupation.name, 'Student'))
        .limit(1)
    )[0]?.id;
  if (!studentOccupation) throw new Error('Student occupation is missing');

  const departments = await db
    .select({ id: department.id, name: department.name })
    .from(department);
  const usersByEmail = new Map(users.map((user) => [user.email, user]));
  const orderedUsers = DEMO_USERS.map(({ firstName, lastName }) => {
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@ku.th`;
    const user = usersByEmail.get(email);
    if (!user) throw new Error(`Missing demo user ${email}`);
    return user;
  });

  for (const [index, demo] of DEMO_USERS.entries()) {
    const user = orderedUsers[index];
    if (!user) continue;
    const userDepartment = departments.find(({ name }) => name === demo.department);

    await db
      .update(authUser)
      .set({
        bio: `Hi, I'm ${demo.firstName}. I enjoy helping KU students with ${demo.department.toLowerCase()} projects.`,
        telephone: `08${String(10000000 + index).padStart(8, '0')}`,
        studentId: `65${String(1000000 + index).padStart(8, '0')}`,
        departmentId: userDepartment?.id ?? user.departmentId,
        academicYear: 2565 + (index % 4),
        occupationId: user.occupationId ?? studentOccupation,
        termsAcceptedAt: new Date(),
        termsVersion: '1.0',
      })
      .where(eq(authUser.id, user.id));

    await db.delete(profileWorkExperience).where(eq(profileWorkExperience.userId, user.id));
    await db.insert(profileWorkExperience).values({
      userId: user.id,
      title: index % 2 === 0 ? 'Student Project Contributor' : 'Campus Activity Volunteer',
      employmentType: index % 2 === 0 ? 'PART_TIME' : 'VOLUNTEER',
      org: 'Kasetsart University Student Community',
      description: 'Worked with a student team to deliver a useful campus project.',
      startedAt: '2024-06-01',
      endedAt: null,
    });

    const portfolioTitle =
      index % 2 === 0 ? 'Campus Event Booking App' : 'Student Community Dashboard';
    const existingPortfolio = await db
      .select({ id: profilePortfolioItem.id })
      .from(profilePortfolioItem)
      .where(
        and(
          eq(profilePortfolioItem.userId, user.id),
          eq(profilePortfolioItem.title, portfolioTitle)
        )
      )
      .limit(1);
    if (existingPortfolio.length === 0) {
      await db.insert(profilePortfolioItem).values({
        userId: user.id,
        title: portfolioTitle,
        description: 'A demo project prepared for the KUQuest frontend showcase.',
      });
    }

    const certificateName = index % 2 === 0 ? 'Google Data Analytics' : 'Meta Front-End Developer';
    const existingCertificate = await db
      .select({ id: profileCertificate.id })
      .from(profileCertificate)
      .where(
        and(eq(profileCertificate.userId, user.id), eq(profileCertificate.name, certificateName))
      )
      .limit(1);
    if (existingCertificate.length === 0) {
      await db.insert(profileCertificate).values({
        userId: user.id,
        name: certificateName,
        issuer: index % 2 === 0 ? 'Google' : 'Meta',
        issuedAt: '2025-01-15',
      });
    }
  }

  const demoQuestRows = await db
    .select({ id: quest.id })
    .from(quest)
    .where(and(like(quest.title, '[Demo] %'), ne(quest.title, frontendDemoDisputeQuestTitle)));
  const demoQuestIds = demoQuestRows.map(({ id }) => id);
  if (demoQuestIds.length > 0) {
    await db.delete(review).where(inArray(review.questId, demoQuestIds));
    await db.delete(questAssignment).where(inArray(questAssignment.questId, demoQuestIds));
    await db.delete(quest).where(inArray(quest.id, demoQuestIds));
  }

  const tagIds = new Map<string, string>();
  for (const name of fixedTagNames) {
    tagIds.set(name, await getOrCreateTag(name));
  }

  const now = new Date();
  const demoDesignTagName: FixedTagName = 'ออกแบบ (Design)';
  const demoWorkTagName: FixedTagName = 'งานและการบ้าน (Work/Homework)';
  const openQuests = [
    ['Design a KU event poster', demoDesignTagName, 0, 50_000],
    ['Translate an event announcement', demoWorkTagName, 1, 35_000],
    ['Analyse student survey data', demoWorkTagName, 2, 80_000],
    ['Create a student club landing page', demoWorkTagName, 3, 120_000],
    ['Plan a campus activity campaign', demoWorkTagName, 4, 60_000],
  ] as const satisfies readonly (readonly [string, FixedTagName, number, number])[];

  const openRows = await db
    .insert(quest)
    .values(
      openQuests.map(([title, tagName, hirerIndex, rewardSatang]) => ({
        hirerId: orderedUsers[hirerIndex]!.id,
        title: `[Demo] ${title}`,
        description: `A demo Quest created by ${DEMO_USERS[hirerIndex]!.firstName} for the frontend showcase.`,
        condition: 'Deliver the requested work and provide a short explanation of the result.',
        mode: questMode.noCandidate,
        participation: questParticipation.solo,
        questStatus: questStatus.open,
        rewardSatang,
        tagId: tagIds.get(tagName)!,
        headcount: 1,
        startTime: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        dueAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
        proofRequired: true,
      }))
    )
    .returning({ id: quest.id });

  const completedQuests = [
    ['Build a student club landing page', demoWorkTagName, 0, 1, 120_000],
    ['Prepare an event budget report', demoWorkTagName, 1, 2, 90_000],
    ['Create a campus activity poster', demoDesignTagName, 2, 3, 70_000],
    ['Write a campus newsletter', demoWorkTagName, 3, 4, 45_000],
    ['Design a student club logo', demoDesignTagName, 4, 5, 55_000],
    ['Analyse a club member survey', demoWorkTagName, 5, 6, 65_000],
    ['Build a volunteer signup page', demoWorkTagName, 6, 7, 100_000],
    ['Translate a campus guide', demoWorkTagName, 7, 8, 40_000],
    ['Create a student event dashboard', demoWorkTagName, 8, 9, 110_000],
  ] as const satisfies readonly (readonly [string, FixedTagName, number, number, number])[];

  const completedRows = await db
    .insert(quest)
    .values(
      completedQuests.map(([title, tagName, hirerIndex, _workerIndex, rewardSatang]) => ({
        hirerId: orderedUsers[hirerIndex]!.id,
        title: `[Demo] ${title}`,
        description: 'A completed demo Quest for the Profile Reputation and Review showcase.',
        condition: 'The submitted work meets the agreed acceptance criteria.',
        mode: questMode.noCandidate,
        participation: questParticipation.solo,
        questStatus: questStatus.completed,
        rewardSatang,
        tagId: tagIds.get(tagName)!,
        headcount: 1,
        startTime: new Date('2025-06-01T09:00:00.000Z'),
        dueAt: new Date('2025-06-15T18:00:00.000Z'),
        proofRequired: true,
      }))
    )
    .returning({ id: quest.id });

  const assignments = await db
    .insert(questAssignment)
    .values(
      completedQuests.map(([, , , workerIndex], index) => ({
        questId: completedRows[index]!.id,
        workerId: orderedUsers[workerIndex]!.id,
        assignmentStatus: assignmentStatus.completed,
        startedAt: new Date('2025-06-02T09:00:00.000Z'),
      }))
    )
    .returning({
      id: questAssignment.id,
      questId: questAssignment.questId,
      workerId: questAssignment.workerId,
    });

  await db.insert(review).values(
    assignments.flatMap((assignment, index) => {
      const completed = completedQuests[index];
      if (!completed) return [];
      const hirer = orderedUsers[completed[2]]!;
      const worker = orderedUsers[completed[3]]!;
      return [
        {
          questId: assignment.questId,
          reviewerId: hirer.id,
          revieweeId: worker.id,
          rating: 5,
          comment: 'Great communication and high-quality work.',
        },
        {
          questId: assignment.questId,
          reviewerId: worker.id,
          revieweeId: hirer.id,
          rating: 5,
          comment: 'Clear requirements and helpful feedback throughout the Quest.',
        },
      ];
    })
  );

  const hirer = orderedUsers[0];
  if (!hirer) throw new Error('Hirer demo user (index 0) is missing.');
  const worker = orderedUsers[1];
  if (!worker) throw new Error('Worker demo user (index 1) is missing.');
  const designTagId = tagIds.get(demoDesignTagName);
  if (!designTagId) throw new Error('The Design Tag is missing for demo Dispute Quest.');

  const dispute = await ensureFrontendDemoDisputeQuest(hirer.id, worker.id, designTagId);

  console.log(`Prepared ${orderedUsers.length} demo Profiles.`);
  console.log(
    `Created ${openRows.length} OPEN Quests and ${completedRows.length} COMPLETED Quests.`
  );
  console.log(
    `Created ${assignments.length} completed Worker assignments and ${assignments.length * 2} Reviews.`
  );
  console.log(
    `Prepared pending Dispute Case ${dispute.disputeCaseId} on Quest ${dispute.questId}.`
  );
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Frontend demo seed failed.');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
