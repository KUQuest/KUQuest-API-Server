import { db, sql } from '@/database/client';
import { authAccount, authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questImage } from '@/database/schema/quest.schema';
import { getAcademicRegistrationStatus } from '@/modules/academic-registration/academic-registration.service';
import { getWallet, verifyWalletProjection } from '@/modules/wallet';
import { demoMembers } from '@/shared/demo-members';

import { and, eq } from 'drizzle-orm';

import { demoQuests } from './demo-quests';
import { demoStarterSpendingSatang } from './seed-demo-quests';

const main = async (): Promise<void> => {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('ADMIN_EMAIL is required for staging seed verification.');
  const [admin] = await db
    .select({ id: authAdmin.id })
    .from(authAdmin)
    .where(eq(authAdmin.email, email));
  if (!admin) throw new Error('Admin seed verification failed.');
  await Promise.all(
    demoMembers.map(async (member, index) => {
      const [user] = await db.select().from(authUser).where(eq(authUser.email, member.email));
      if (!user || !user.imageFileId) throw new Error(`Incomplete demo Member: ${member.email}`);
      const registration = await getAcademicRegistrationStatus(user.id);
      if (!registration?.completed)
        throw new Error(`Incomplete Academic Registration: ${member.email}`);
      const [credential] = await db
        .select()
        .from(authAccount)
        .where(and(eq(authAccount.userId, user.id), eq(authAccount.providerId, 'credential')));
      if (!credential?.password) throw new Error(`Missing demo login credentials: ${member.email}`);
      const rows = await db
        .select()
        .from(quest)
        .where(
          and(
            eq(quest.hirerId, user.id),
            eq(quest.apiVersion, 'v2'),
            eq(quest.title, demoQuests[index]!.title)
          )
        );
      const seeded = rows[0];
      if (
        rows.length !== 1 ||
        !seeded ||
        seeded.questStatus !== 'QUEST_OPEN' ||
        !seeded.fundingReservationId ||
        !seeded.dueAt ||
        seeded.startTime <= new Date()
      ) {
        throw new Error(`Demo Published Quest verification failed: ${member.email}`);
      }
      const [image] = await db.select().from(questImage).where(eq(questImage.questId, seeded.id));
      if (!image) throw new Error(`Missing demo Quest picture: ${member.email}`);
      const wallet = await getWallet(user.id);
      if (
        Number(wallet.spendingBalanceSatang) !== demoStarterSpendingSatang ||
        Number(wallet.fundingReservedSatang) !== seeded.questEscrowSatang
      ) {
        throw new Error(
          `Demo Wallet must have 1,000 Baht available after Quest funding: ${member.email}`
        );
      }
      const projection = await verifyWalletProjection(wallet.id);
      if (!projection.matches)
        throw new Error(`Demo Wallet does not match its ledger: ${member.email}`);
    })
  );
  console.log(
    'Verified Admin, 10 complete demo Members, login credentials, pictures, funded Published Quests, and Wallet ledgers.'
  );
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
