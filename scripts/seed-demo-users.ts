/* eslint-disable no-await-in-loop -- Run seed steps and session assertions in order. */
import { db, sql } from '@/database/client';
import { department, occupation } from '@/database/schema/academic.schema';
import { authAccount, authUser } from '@/database/schema/auth.schema';
import {
  profileCertificate,
  profilePortfolioItem,
  profilePortfolioItemImage,
  profileWorkExperience,
} from '@/database/schema/profile.schema';
import { ensureWallet } from '@/modules/wallet';
import { demoMembers } from '@/shared/demo-members';

import { hashPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';

import { assertDemoSeedEnvironment, demoPassword, storeDemoImage } from './demo-seed';
import { demoQuests } from './demo-quests';

export const seedDemoMembers = async (): Promise<void> => {
  assertDemoSeedEnvironment();
  const password = await hashPassword(demoPassword());
  const [student] = await db
    .select({ id: occupation.id })
    .from(occupation)
    .where(and(eq(occupation.name, 'Student'), eq(occupation.requiresStudentId, true)))
    .limit(1);
  if (!student) throw new Error('Run db:migrate before seeding demo Members.');
  const departments = await db.select().from(department);
  for (const [index, member] of demoMembers.entries()) {
    const academicDepartment = departments.find((row) => row.name === member.department);
    if (!academicDepartment) throw new Error(`Missing Department: ${member.department}`);
    const profile = {
      firstName: member.firstName,
      lastName: member.lastName,
      bio: member.bio,
      telephone: member.telephone,
      studentId: member.studentId,
      academicYear: member.academicYear,
      departmentId: academicDepartment.id,
      occupationId: student.id,
      emailVerified: true,
      termsAcceptedAt: new Date(),
      termsVersion: '1.0',
    };
    const [user] = await db
      .insert(authUser)
      .values({ email: member.email, ...profile })
      .onConflictDoUpdate({ target: authUser.email, set: profile })
      .returning({ id: authUser.id });
    if (!user) throw new Error(`Could not seed Member ${member.email}`);
    await db
      .insert(authAccount)
      .values({ userId: user.id, accountId: user.id, providerId: 'credential', password })
      .onConflictDoUpdate({
        target: [authAccount.providerId, authAccount.accountId],
        set: { password },
      });
    await ensureWallet(user.id);
    const avatarId = await storeDemoImage(
      user.id,
      `demo/${user.id}/avatar.jpg`,
      `avatar-${index + 1}.jpg`
    );
    await db.update(authUser).set({ imageFileId: avatarId }).where(eq(authUser.id, user.id));
    const sample = demoQuests[index]!;
    const portfolioTitle = sample.portfolio;
    let [portfolio] = await db
      .select({ id: profilePortfolioItem.id })
      .from(profilePortfolioItem)
      .where(
        and(
          eq(profilePortfolioItem.userId, user.id),
          eq(profilePortfolioItem.title, portfolioTitle)
        )
      )
      .limit(1);
    if (!portfolio)
      [portfolio] = await db
        .insert(profilePortfolioItem)
        .values({
          userId: user.id,
          title: portfolioTitle,
          description: sample.portfolioDescription,
        })
        .returning({ id: profilePortfolioItem.id });
    if (!portfolio) throw new Error('Demo Portfolio was not created.');
    const portfolioImageId = await storeDemoImage(
      user.id,
      `demo/${user.id}/portfolio.jpg`,
      sample.imageAsset
    );
    await db
      .insert(profilePortfolioItemImage)
      .values({ portfolioItemId: portfolio.id, fileId: portfolioImageId, position: 0 })
      .onConflictDoNothing();
    const [certificate] = await db
      .select({ id: profileCertificate.id })
      .from(profileCertificate)
      .where(
        and(eq(profileCertificate.userId, user.id), eq(profileCertificate.name, sample.certificate))
      )
      .limit(1);
    if (!certificate)
      await db.insert(profileCertificate).values({
        userId: user.id,
        name: sample.certificate,
        issuer: 'KU Student Skills Workshop',
        issuedAt: '2026-02-15',
      });
    const [experience] = await db
      .select({ id: profileWorkExperience.id })
      .from(profileWorkExperience)
      .where(
        and(
          eq(profileWorkExperience.userId, user.id),
          eq(profileWorkExperience.title, sample.experience)
        )
      )
      .limit(1);
    if (!experience)
      await db.insert(profileWorkExperience).values({
        userId: user.id,
        title: sample.experience,
        employmentType: 'VOLUNTEER',
        org: 'Kasetsart University Student Community',
        description: sample.portfolioDescription,
        startedAt: '2025-06-01',
        endedAt: null,
      });
    console.log(`Prepared ${member.key}: ${member.firstName} ${member.lastName} <${member.email}>`);
  }
};

if (import.meta.main) {
  try {
    await seedDemoMembers();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
