/* eslint-disable no-await-in-loop -- Seed operations preserve workflow order and idempotent transitions. */

import { defaultLocalDatabaseUrl } from '@/config/default-database-url';
import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { department, occupation } from '@/database/schema/academic.schema';
import {
  adminConductReport,
  adminDisputeCase,
  adminReportCase,
  adminReporterEntry,
  conductReportReason,
  conductReportStatus,
  disputeCaseStatus,
  reportCaseStatus,
} from '@/database/schema/admin.schema';
import { authAccount, authAdmin, authUser } from '@/database/schema/auth.schema';
import { paymentPayouts, paymentTopUp } from '@/database/schema/payment.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { chatConversation, chatMessage } from '@/database/schema/work-chat.schema';
import {
  walletIdempotencyKey,
  walletLedgerAccount,
  walletLedgerTransaction,
  walletWallet,
  walletStatus,
} from '@/database/schema/wallet.schema';
import { decideAdminReport, decideAdminReportCase } from '@/modules/admin/admin-report.service';
import { seedAcademicOptions } from '@/modules/academic-registration/academic-registration.service';
import { cancelPayout } from '@/modules/payout/payout.admin.service';
import { initiatePayout, payoutOperationScope, quotePayout } from '@/modules/payout/payout.service';
import {
  createPayoutDestinationEncryption,
  getPayoutDestination,
  savePayoutDestination,
} from '@/modules/payout-destination';
import {
  cancelQuestV2,
  confirmQuestV2Completion,
  createQuestV2,
  editQuestV2,
  failQuestV2AtDueAt,
  formatQuestV2ScheduleTime,
  joinQuestV2,
  publishQuestV2,
  startQuestWork,
} from '@/modules/quest';
import {
  createAdminDisputeCase,
  resolveAdminDisputeCase,
} from '@/modules/quest/admin/quest-dispute-admin.service';
import { changeWalletStatusAdmin } from '@/modules/wallet/wallet.admin.service';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  signedSatang,
} from '@/modules/wallet';
import { seedQuestTags } from '@/modules/tag/tag.service';
import { sendWorkConversationMessage } from '@/modules/work-chat/work-chat.service';
import { submitMessageReport } from '@/modules/work-chat/message-report.service';
import { initiateTopUp, quoteTopUp, topUpOperationScope } from '@/modules/top-up';
import type {
  InboundPaymentProvider,
  InboundPaymentRequest,
  InboundPaymentResponse,
} from '@/modules/top-up';
import type { QuestV2CreateInput } from '@/modules/quest';
import { demoMembers } from '@/shared/demo-members';

import { hashPassword } from 'better-auth/crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { assertDemoSeedEnvironment, demoPassword, storeDemoImage } from './demo-seed';
import { demoQuests } from './demo-quests';
import { seedDemoMembers } from './seed-demo-users';
import { seedDemoQuests } from './seed-demo-quests';

const casesPerType = 5;
const disputeResolutionSatang = 3_000;
const payoutReceiptSatang = 5_000;
const additionalQuestFundingTotalBaht = 100;
const topUpCreditAmountsSatang = [5_000, 7_500, 10_000, 12_500, 15_000] as const;
const localDatabaseHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const topUpDemoProvider: InboundPaymentProvider = {
  async createPayment(input: InboundPaymentRequest): Promise<InboundPaymentResponse> {
    const reference = input.internalReference.replace(/[^a-zA-Z0-9-]/g, '-');
    return {
      providerReference: `DEMO-${reference}`,
      providerStatus: 'PENDING_DEMO',
      providerAmountSatang: input.paymentTotalSatang,
      providerApiVersion: 'ADMIN-DEMO-V1',
      providerChannelCode: 'PROMPTPAY_DEMO',
      qrPayload: `KUQUEST-DEMO:TOP-UP:${reference}`,
      qrExpiresAt: input.expiresAt,
    };
  },
};

const disputeStatusPool = [
  disputeCaseStatus.pending,
  disputeCaseStatus.dismissed,
  disputeCaseStatus.resolved,
] as const;
const reportStatusPool = [
  reportCaseStatus.pending,
  reportCaseStatus.dismissed,
  reportCaseStatus.hidden,
  reportCaseStatus.restored,
] as const;
const conductStatusPool = [
  conductReportStatus.pending,
  conductReportStatus.dismissed,
  conductReportStatus.upheld,
] as const;
const reportReasonPool = [
  'REPORT_ABUSIVE_OR_HARASSMENT',
  'REPORT_SPAM',
  'REPORT_INAPPROPRIATE_CONTENT',
  'REPORT_DANGER_OR_THREAT',
  'REPORT_OTHER',
] as const;

const reportExamples: Record<(typeof reportReasonPool)[number], { text: string; detail: string }> =
  {
    REPORT_ABUSIVE_OR_HARASSMENT: {
      text: 'This demo Message needs an Admin review for harassment.',
      detail: 'The Message uses hostile language toward another Member.',
    },
    REPORT_SPAM: {
      text: 'Demo message: repeated requests for the same event update.',
      detail: 'The Message repeats an unrelated request.',
    },
    REPORT_INAPPROPRIATE_CONTENT: {
      text: 'Please share the private contact list for the event attendees.',
      detail: 'The Message asks for private attendee information.',
    },
    REPORT_DANGER_OR_THREAT: {
      text: 'I will damage the event display if the plan does not change.',
      detail: 'The Message contains a threat about the event display.',
    },
    REPORT_OTHER: {
      text: 'This Message needs a review for a reason not listed above.',
      detail: 'The Reporter selected Other and added context for Admin review.',
    },
  };

const extraQuestWorkflowDefinitions = [
  { workflow: 'DRAFT', status: 'QUEST_DRAFT', count: 5 },
  { workflow: 'OPEN', status: 'QUEST_OPEN', count: 10 },
  { workflow: 'ASSIGNED', status: 'QUEST_ASSIGNED', count: 5 },
  { workflow: 'IN_PROGRESS', status: 'QUEST_IN_PROGRESS', count: 5 },
  { workflow: 'COMPLETED', status: 'QUEST_COMPLETED', count: 5 },
  { workflow: 'CANCELLED', status: 'QUEST_CANCELLED', count: 5 },
  { workflow: 'FAILED', status: 'QUEST_FAILED', count: 5 },
] as const;

type DemoQuestWorkflow = 'BASE' | (typeof extraQuestWorkflowDefinitions)[number]['workflow'];
type DemoQuestStatus = 'QUEST_OPEN' | (typeof extraQuestWorkflowDefinitions)[number]['status'];
type DemoQuestPlan = {
  key: string;
  workflow: DemoQuestWorkflow;
  status: DemoQuestStatus;
  sequence: number;
  templateIndex: number;
};
type DemoReportCasePlan = {
  index: number;
  status: (typeof reportStatusPool)[number];
  reason: (typeof reportReasonPool)[number];
};
type DemoConductReportPlan = {
  questIndex: number;
  reason: (typeof conductReportReason)[keyof typeof conductReportReason];
  status: (typeof conductStatusPool)[number];
  filerRole: 'hirer' | 'workerA' | 'workerB' | 'workerC';
  reportedRole: 'hirer' | 'workerA' | 'workerB' | 'workerC';
  assignmentRole: 'workerA' | 'workerB' | 'workerC';
};
type DemoDisputeCasePlan = {
  questIndex: number;
  status: (typeof disputeStatusPool)[number];
  filerRole: 'hirer' | 'workerA' | 'workerB' | 'workerC';
  resolvedWorkerRole: 'workerA' | 'workerB' | 'workerC';
};
export type DemoFrontendSeedPlan = {
  quests: DemoQuestPlan[];
  reportCases: DemoReportCasePlan[];
  conductReports: DemoConductReportPlan[];
  disputeCases: DemoDisputeCasePlan[];
  walletStatuses: Array<(typeof walletStatus)[keyof typeof walletStatus]>;
  occupations: Array<'Student' | 'Staff' | 'Lecturer'>;
};

export const createDemoFrontendSeedPlan = (): DemoFrontendSeedPlan => {
  const baseQuests: DemoQuestPlan[] = demoMembers.map((member, sequence) => ({
    key: `member-${member.key}`,
    workflow: 'BASE',
    status: 'QUEST_OPEN',
    sequence,
    templateIndex: sequence,
  }));
  const extraQuests: DemoQuestPlan[] = extraQuestWorkflowDefinitions.flatMap(
    ({ workflow, status, count }, workflowIndex) =>
      Array.from({ length: count }, (_, sequence) => ({
        key: `${workflow.toLowerCase()}-${String(sequence + 1).padStart(2, '0')}`,
        workflow,
        status,
        sequence,
        templateIndex: (workflowIndex * casesPerType + sequence) % demoQuests.length,
      }))
  );
  const reportCases: DemoReportCasePlan[] = Array.from(
    { length: casesPerType * reportStatusPool.length },
    (_, index) => ({
      index,
      status: reportStatusPool[Math.floor(index / casesPerType)]!,
      reason: reportReasonPool[index % reportReasonPool.length]!,
    })
  );
  const conductReports: DemoConductReportPlan[] = Array.from(
    { length: casesPerType },
    (_, questIndex) => [
      {
        questIndex,
        reason: conductReportReason.abandoned,
        status: conductReportStatus.pending,
        filerRole: 'hirer' as const,
        reportedRole: 'workerB' as const,
        assignmentRole: 'workerB' as const,
      },
      {
        questIndex,
        reason: conductReportReason.outOfScope,
        status: conductReportStatus.dismissed,
        filerRole: 'workerA' as const,
        reportedRole: 'hirer' as const,
        assignmentRole: 'workerA' as const,
      },
      {
        questIndex,
        reason: conductReportReason.noShow,
        status: conductReportStatus.upheld,
        filerRole: 'workerA' as const,
        reportedRole: 'workerC' as const,
        assignmentRole: 'workerC' as const,
      },
    ]
  ).flat();
  const disputeCases: DemoDisputeCasePlan[] = Array.from(
    { length: casesPerType },
    (_, questIndex) => [
      {
        questIndex,
        status: disputeCaseStatus.pending,
        filerRole: 'workerA' as const,
        resolvedWorkerRole: 'workerA' as const,
      },
      {
        questIndex,
        status: disputeCaseStatus.dismissed,
        filerRole: 'hirer' as const,
        resolvedWorkerRole: 'workerA' as const,
      },
      {
        questIndex,
        status: disputeCaseStatus.resolved,
        filerRole: 'workerB' as const,
        resolvedWorkerRole: 'workerC' as const,
      },
    ]
  ).flat();

  return {
    quests: [...baseQuests, ...extraQuests],
    reportCases,
    conductReports,
    disputeCases,
    walletStatuses: [
      walletStatus.active,
      walletStatus.frozen,
      walletStatus.suspended,
      walletStatus.closed,
    ],
    occupations: ['Student', 'Staff', 'Lecturer'],
  };
};
const assertLocalDevelopment = (): void => {
  const databaseUrl = new URL(env.databaseUrl ?? defaultLocalDatabaseUrl);
  if (
    env.nodeEnv !== 'development' ||
    env.deploymentEnv !== 'development' ||
    !localDatabaseHosts.has(databaseUrl.hostname)
  ) {
    throw new Error('This seed requires a local development database.');
  }
};

const loadDemoMembers = async (): Promise<DemoSeedMember[]> => {
  const rows = await db
    .select({ id: authUser.id, email: authUser.email })
    .from(authUser)
    .where(
      inArray(
        authUser.email,
        demoMembers.map(({ email }) => email)
      )
    );
  const byEmail = new Map(rows.map((row) => [row.email, row]));
  return demoMembers.map((member) => {
    const row = byEmail.get(member.email);
    if (!row) throw new Error(`Frontend demo Member ${member.email} was not seeded.`);
    return { ...member, id: row.id };
  });
};

const loadSeedReferences = async () => {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail) throw new Error('ADMIN_EMAIL is required.');
  const [admin] = await db
    .select({ id: authAdmin.id })
    .from(authAdmin)
    .where(eq(authAdmin.email, adminEmail))
    .limit(1);
  if (!admin) throw new Error(`Frontend demo Admin ${adminEmail} was not seeded.`);
  const [designTag] = await db
    .select({ id: tag.id })
    .from(tag)
    .where(eq(tag.name, 'Design'))
    .limit(1);
  if (!designTag) throw new Error('Quest Tag Design was not seeded.');
  return { adminId: admin.id, tagId: designTag.id };
};

const idempotentResourceId = async (input: {
  userId: string;
  scope: string;
  key: string;
}): Promise<string | null> => {
  const [entry] = await db
    .select({ resourceId: walletIdempotencyKey.resourceId })
    .from(walletIdempotencyKey)
    .where(
      and(
        eq(walletIdempotencyKey.principalUserId, input.userId),
        eq(walletIdempotencyKey.operationScope, input.scope),
        eq(walletIdempotencyKey.key, input.key)
      )
    )
    .limit(1);
  return entry?.resourceId ?? null;
};
const ensureAdminAccount = async (): Promise<void> => {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('ADMIN_EMAIL is required.');
  demoPassword();

  const [existing] = await db
    .select({ id: authAdmin.id, disabledAt: authAdmin.disabledAt })
    .from(authAdmin)
    .where(eq(authAdmin.email, email))
    .limit(1);
  if (existing) {
    if (existing.disabledAt) throw new Error(`Demo Admin ${email} is disabled.`);
    return;
  }

  const child = Bun.spawn(['bun', 'scripts/seed-admin.ts'], {
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) throw new Error('Admin seed failed.');
};

const occupationDemoMembers = [
  {
    email: 'frontend-demo.staff@ku.th',
    firstName: 'Ploy',
    lastName: 'Srisuk',
    occupation: 'Staff',
    telephone: '0890000010',
  },
  {
    email: 'frontend-demo.lecturer@ku.th',
    firstName: 'Kittipong',
    lastName: 'Rattanakul',
    occupation: 'Lecturer',
    telephone: '0890000011',
  },
] as const;

const ensureOccupationDemoMembers = async (): Promise<DemoOccupationMember[]> => {
  const academicDepartmentName = 'Software and Knowledge Engineering';
  const departments = await db.select().from(department);
  const academicDepartment = departments.find(({ name }) => name === academicDepartmentName);
  if (!academicDepartment) throw new Error(`Missing Department: ${academicDepartmentName}`);
  const occupations = await db.select().from(occupation);
  const password = await hashPassword(demoPassword());
  const seeded: DemoOccupationMember[] = [];

  for (const member of occupationDemoMembers) {
    const memberOccupation = occupations.find(({ name }) => name === member.occupation);
    if (!memberOccupation || memberOccupation.requiresStudentId) {
      throw new Error(`The demo ${member.occupation} Occupation is not configured.`);
    }
    let [user] = await db
      .select({
        id: authUser.id,
        occupationId: authUser.occupationId,
        imageFileId: authUser.imageFileId,
      })
      .from(authUser)
      .where(eq(authUser.email, member.email))
      .limit(1);
    if (user && user.occupationId !== memberOccupation.id) {
      throw new Error(`Demo Member ${member.email} has a different Occupation.`);
    }
    if (!user) {
      [user] = await db
        .insert(authUser)
        .values({
          email: member.email,
          firstName: member.firstName,
          lastName: member.lastName,
          emailVerified: true,
          telephone: member.telephone,
          studentId: null,
          departmentId: academicDepartment.id,
          occupationId: memberOccupation.id,
          termsAcceptedAt: new Date(),
          termsVersion: '1.0',
        })
        .returning({
          id: authUser.id,
          occupationId: authUser.occupationId,
          imageFileId: authUser.imageFileId,
        });
    }
    if (!user) throw new Error(`Could not seed ${member.occupation} Member ${member.email}.`);

    await db
      .insert(authAccount)
      .values({
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password,
      })
      .onConflictDoUpdate({
        target: [authAccount.providerId, authAccount.accountId],
        set: { password },
      });
    await ensureWallet(user.id);
    if (!user.imageFileId) {
      const avatarId = await storeDemoImage(user.id, `demo/${user.id}/avatar.jpg`, 'avatar-1.jpg');
      await db.update(authUser).set({ imageFileId: avatarId }).where(eq(authUser.id, user.id));
    }
    seeded.push({ id: user.id, ...member });
  }
  return seeded;
};

const seedTopUps = async (members: DemoSeedMember[]) => {
  const statuses: string[] = [];
  for (const [index, member] of members.slice(0, 5).entries()) {
    const key = `admin-demo-finance-v1:top-up:${index + 1}`;
    const existingId = await idempotentResourceId({
      userId: member.id,
      scope: topUpOperationScope,
      key,
    });
    if (existingId) {
      const [existing] = await db
        .select({ status: paymentTopUp.topUpStatus })
        .from(paymentTopUp)
        .where(eq(paymentTopUp.id, existingId))
        .limit(1);
      statuses.push(existing?.status ?? 'PENDING');
      continue;
    }

    const quote = await quoteTopUp({
      principalUserId: member.id,
      creditSatang: positiveSatang(topUpCreditAmountsSatang[index]!),
    });
    const topUp = await initiateTopUp(
      { principalUserId: member.id, quoteId: quote.id, idempotency: { key } },
      topUpDemoProvider
    );
    statuses.push(topUp.topUpStatus);
  }
  summarize('Top-ups', statuses);
};

const ensurePayoutEarnings = async (input: {
  memberId: string;
  index: number;
  requiredSatang: number;
}): Promise<void> => {
  const wallet = await ensureWallet(input.memberId);
  const businessReference = `admin-demo-payout-funding-v1:${input.index + 1}`;
  const [existingLedger] = await db
    .select({ id: walletLedgerTransaction.id })
    .from(walletLedgerTransaction)
    .where(eq(walletLedgerTransaction.businessReference, businessReference))
    .limit(1);
  if (existingLedger) return;

  const [earningsAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(
      and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, 'EARNINGS'))
    )
    .limit(1);
  const [suspenseAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'))
    .limit(1);
  if (!earningsAccount || !suspenseAccount) {
    throw new Error('Wallet Ledger accounts are missing for the Payout demo.');
  }

  const required = positiveSatang(input.requiredSatang);
  const shortfall = Math.max(0, required - wallet.earningsBalanceSatang);
  if (shortfall === 0) return;
  await createSealedLedgerTransaction({
    businessReference,
    eventType: 'ADJUSTMENT',
    description: 'Local Admin demo Payout fixture funding',
    postings: [
      { accountId: earningsAccount.id, amountSatang: signedSatang(shortfall) },
      { accountId: suspenseAccount.id, amountSatang: signedSatang(-shortfall) },
    ],
  });
};

const seedPayouts = async (adminId: string, members: DemoSeedMember[]) => {
  const encryption = createPayoutDestinationEncryption();
  const statuses: string[] = [];

  for (const [index, member] of members.slice(5, 10).entries()) {
    const key = `admin-demo-finance-v1:payout:${index + 1}`;
    const existingId = await idempotentResourceId({
      userId: member.id,
      scope: payoutOperationScope,
      key,
    });
    let payoutId = existingId;
    let payoutStatus: string | null = null;

    if (existingId) {
      const [existing] = await db
        .select({ status: paymentPayouts.payoutStatus })
        .from(paymentPayouts)
        .where(eq(paymentPayouts.id, existingId))
        .limit(1);
      if (!existing) throw new Error('The idempotent demo Payout is missing.');
      payoutStatus = existing.status;
    } else {
      const destination =
        (await getPayoutDestination(member.id)) ??
        (await savePayoutDestination(
          {
            principalUserId: member.id,
            givenName: member.firstName,
            surname: member.lastName,
            relationship: 'SELF',
            bankCode: 'KBANK',
            accountNumber: `620000000${String(index + 1).padStart(4, '0')}`,
            accountHolderName: `${member.firstName} ${member.lastName}`,
            routingType: 'BANK_ACCOUNT',
            routingValue: `KUQUEST-DEMO-${index + 1}`,
          },
          encryption
        ));
      if (!destination) throw new Error('Could not save a Payout Destination for the demo.');

      const quote = await quotePayout({
        principalUserId: member.id,
        receiptSatang: positiveSatang(payoutReceiptSatang),
      });
      await ensurePayoutEarnings({
        memberId: member.id,
        index,
        requiredSatang: quote.maximumDebitSatang,
      });
      const payout = await initiatePayout({
        principalUserId: member.id,
        quoteId: quote.id,
        idempotency: { key },
      });
      payoutId = payout.id;
      payoutStatus = payout.payoutStatus;
    }

    if (!payoutId || !payoutStatus) throw new Error('Could not load a seeded Payout.');
    if (index === 4 && payoutStatus === 'PENDING_ADMIN_APPROVAL') {
      const [payout] = await db
        .select({ version: paymentPayouts.version })
        .from(paymentPayouts)
        .where(eq(paymentPayouts.id, payoutId))
        .limit(1);
      if (!payout) throw new Error('The Payout selected for cancellation is missing.');
      await cancelPayout({
        adminId,
        payoutId,
        expectedVersion: payout.version,
        idempotencyKey: `admin-demo-finance-v1:payout-cancel:${index + 1}`,
        reasonCode: 'PAYOUT_POLICY_REVIEW',
      });
      payoutStatus = 'CANCELLED';
    }
    statuses.push(payoutStatus);
  }
  summarize('Payouts', statuses);
};

type DemoSeedMember = (typeof demoMembers)[number] & { id: string };
type DemoOccupationMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  occupation: 'Staff' | 'Lecturer';
  telephone: string;
};
type DemoExtraQuestPlan = DemoQuestPlan & {
  workflow: Exclude<DemoQuestWorkflow, 'BASE'>;
};
type DemoQuestRow = {
  id: string;
  status: string;
  version: number;
  startTime: Date;
  dueAt: Date | null;
};
type DemoQuestActors = {
  hirer: DemoSeedMember;
  workers: DemoSeedMember[];
  roleIds: {
    hirer: string;
    workerA: string;
    workerB: string;
    workerC: string;
  };
};
type DemoExtraQuest = {
  plan: DemoExtraQuestPlan;
  title: string;
  template: (typeof demoQuests)[number];
  actors: DemoQuestActors;
  headcount: number;
  mode: 'FIRST_COME_FIRST_SERVED' | 'CANDIDATE';
};
type FailedQuestSeed = {
  questId: string;
  hirerId: string;
  roleIds: DemoQuestActors['roleIds'];
  assignmentIds: Record<'workerA' | 'workerB' | 'workerC', string>;
};
type WorkConversationSeed = {
  conversationId: string;
  hirerId: string;
  workerId: string;
};
type SeededExtraQuestResults = {
  statuses: string[];
  failedQuests: FailedQuestSeed[];
  workConversations: WorkConversationSeed[];
};

const isDemoExtraQuest = (plan: DemoQuestPlan): plan is DemoExtraQuestPlan =>
  plan.workflow !== 'BASE';

const actorsForDemoQuest = (
  plan: DemoExtraQuestPlan,
  members: DemoSeedMember[]
): DemoQuestActors => {
  if (plan.workflow === 'IN_PROGRESS') {
    const hirer = members[plan.sequence + 5]!;
    const worker = members[plan.sequence]!;
    return {
      hirer,
      workers: [worker],
      roleIds: {
        hirer: hirer.id,
        workerA: worker.id,
        workerB: worker.id,
        workerC: worker.id,
      },
    };
  }
  if (plan.workflow === 'FAILED') {
    const hirer = members[plan.sequence]!;
    const workerA = members[(plan.sequence + 1) % 5]!;
    const workerB = members[5 + ((plan.sequence + 1) % 5)]!;
    const workerC = members[5 + plan.sequence]!;
    return {
      hirer,
      workers: [workerA, workerB, workerC],
      roleIds: {
        hirer: hirer.id,
        workerA: workerA.id,
        workerB: workerB.id,
        workerC: workerC.id,
      },
    };
  }

  const hirer = members[plan.templateIndex % members.length]!;
  const worker = members[(plan.templateIndex + 1) % members.length]!;
  return {
    hirer,
    workers: [worker],
    roleIds: {
      hirer: hirer.id,
      workerA: worker.id,
      workerB: worker.id,
      workerC: worker.id,
    },
  };
};

const prepareExtraQuestSeeds = (
  plan: DemoFrontendSeedPlan,
  members: DemoSeedMember[]
): DemoExtraQuest[] =>
  plan.quests.filter(isDemoExtraQuest).map((questPlan) => {
    const template = demoQuests[questPlan.templateIndex % demoQuests.length]!;
    const title = `[Frontend Demo ${questPlan.workflow}] ${String(questPlan.sequence + 1).padStart(2, '0')} ${template.title}`;
    return {
      plan: questPlan,
      title,
      template,
      actors: actorsForDemoQuest(questPlan, members),
      headcount: questPlan.workflow === 'FAILED' ? 3 : 1,
      mode:
        questPlan.workflow === 'OPEN' && questPlan.sequence % 2 === 0
          ? 'CANDIDATE'
          : 'FIRST_COME_FIRST_SERVED',
    };
  });

const seedExtraQuestBudgets = async (seeds: DemoExtraQuest[]): Promise<void> => {
  const fundingByHirer = new Map<string, number>();
  for (const seed of seeds) {
    if (seed.plan.workflow === 'DRAFT') continue;
    const current = fundingByHirer.get(seed.actors.hirer.id) ?? 0;
    fundingByHirer.set(
      seed.actors.hirer.id,
      current + additionalQuestFundingTotalBaht * 100 * seed.headcount
    );
  }

  for (const [userId, fundingSatang] of fundingByHirer) {
    const businessReference = `frontend-demo-v1:quest-budget:${userId}`;
    const [existing] = await db
      .select({ id: walletLedgerTransaction.id })
      .from(walletLedgerTransaction)
      .where(eq(walletLedgerTransaction.businessReference, businessReference))
      .limit(1);
    if (existing) continue;

    const wallet = await ensureWallet(userId);
    const [spendingAccount] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(
        and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, 'SPENDING'))
      )
      .limit(1);
    const [suspenseAccount] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'))
      .limit(1);
    if (!spendingAccount || !suspenseAccount) {
      throw new Error('Wallet Ledger accounts are missing for the frontend demo Quest seed.');
    }
    const amount = positiveSatang(fundingSatang);
    await createSealedLedgerTransaction({
      businessReference,
      eventType: 'ADJUSTMENT',
      description: 'Local frontend demo Quest seed funding',
      postings: [
        { accountId: spendingAccount.id, amountSatang: signedSatang(amount) },
        { accountId: suspenseAccount.id, amountSatang: signedSatang(-amount) },
      ],
    });
  }
};

const readDemoQuest = async (seed: DemoExtraQuest): Promise<DemoQuestRow> => {
  const [row] = await db
    .select({
      id: quest.id,
      status: quest.questStatus,
      version: quest.version,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
    })
    .from(quest)
    .where(
      and(
        eq(quest.hirerId, seed.actors.hirer.id),
        eq(quest.apiVersion, 'v2'),
        eq(quest.title, seed.title)
      )
    )
    .limit(1);
  if (!row) throw new Error(`Frontend demo Quest ${seed.title} is missing.`);
  return row;
};

const ensureDemoQuest = async (seed: DemoExtraQuest, tagId: string): Promise<DemoQuestRow> => {
  const [existing] = await db
    .select({
      id: quest.id,
      status: quest.questStatus,
      version: quest.version,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
    })
    .from(quest)
    .where(
      and(
        eq(quest.hirerId, seed.actors.hirer.id),
        eq(quest.apiVersion, 'v2'),
        eq(quest.title, seed.title)
      )
    )
    .limit(1);
  if (existing) return existing;

  const now = new Date();
  const scheduleStartsInFuture = ['DRAFT', 'OPEN', 'CANCELLED'].includes(seed.plan.workflow);
  const startTime = new Date(
    now.getTime() + (scheduleStartsInFuture ? 30 * 24 * 60 * 60 * 1000 : 2_000)
  );
  const dueAt =
    seed.plan.workflow === 'FAILED'
      ? new Date(startTime.getTime() + 10_000)
      : new Date(startTime.getTime() + 7 * 24 * 60 * 60 * 1000);
  const participation = seed.headcount === 1 ? 'SINGLE' : 'GROUP';
  const created = await createQuestV2(
    seed.actors.hirer.id,
    {
      title: seed.title,
      description: seed.template.description,
      condition: { items: [...seed.template.conditions] },
      mode: seed.mode,
      participation,
      questFundingTotal: additionalQuestFundingTotalBaht,
      headcount: seed.headcount,
      startTime: formatQuestV2ScheduleTime(startTime),
      dueAt: formatQuestV2ScheduleTime(dueAt),
      tagId,
      proofRequired: seed.plan.workflow !== 'COMPLETED',
      locations: [{ label: 'Kasetsart University, Bang Khen campus' }],
    } satisfies QuestV2CreateInput,
    `frontend-demo-v1:${seed.plan.key}:create`
  );
  if (!('quest' in created)) {
    throw new Error(
      `Could not create frontend demo Quest ${seed.title}: ${JSON.stringify(created)}`
    );
  }
  return readDemoQuest(seed);
};

const publishDemoQuest = async (
  seed: DemoExtraQuest,
  initial: DemoQuestRow
): Promise<DemoQuestRow> => {
  if (initial.status !== 'QUEST_DRAFT' || seed.plan.workflow === 'DRAFT') return initial;
  let current = initial;
  if (!current.dueAt || current.startTime.getTime() <= Date.now() + 500) {
    const startTime = new Date(Date.now() + 2_000);
    const dueAt = new Date(
      startTime.getTime() + (seed.plan.workflow === 'FAILED' ? 10_000 : 7 * 24 * 60 * 60 * 1000)
    );
    const revised = await editQuestV2(
      seed.actors.hirer.id,
      current.id,
      {
        startTime: formatQuestV2ScheduleTime(startTime),
        dueAt: formatQuestV2ScheduleTime(dueAt),
      },
      current.version,
      `frontend-demo-v1:${seed.plan.key}:schedule-repair:${current.version}`
    );
    if (!('quest' in revised)) {
      throw new Error(`Could not repair frontend demo Quest schedule ${seed.title}.`);
    }
    current = await readDemoQuest(seed);
  }
  const published = await publishQuestV2(
    seed.actors.hirer.id,
    current.id,
    `frontend-demo-v1:${seed.plan.key}:publish`
  );
  if (!published || !('quest' in published)) {
    throw new Error(
      `Could not publish frontend demo Quest ${seed.title}: ${JSON.stringify(published)}`
    );
  }
  return readDemoQuest(seed);
};

const ensureDemoAssignments = async (
  seed: DemoExtraQuest,
  current: DemoQuestRow
): Promise<DemoQuestRow> => {
  for (const worker of seed.actors.workers) {
    const [existing] = await db
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(and(eq(questAssignment.questId, current.id), eq(questAssignment.workerId, worker.id)))
      .limit(1);
    if (existing) continue;
    if (current.status !== 'QUEST_OPEN') {
      throw new Error(`Frontend demo Quest ${seed.title} has an unexpected roster.`);
    }
    const joined = await joinQuestV2(
      worker.id,
      current.id,
      `frontend-demo-v1:${seed.plan.key}:join:${worker.id}`,
      new Date(Math.min(Date.now(), current.startTime.getTime() - 1))
    );
    if ('outcome' in joined) {
      throw new Error(`Could not join frontend demo Quest ${seed.title}: ${joined.outcome}`);
    }
    current = await readDemoQuest(seed);
  }
  return current;
};

const startDemoQuestWorkers = async (
  seed: DemoExtraQuest,
  current: DemoQuestRow
): Promise<DemoQuestRow> => {
  const waitUntilStart = current.startTime.getTime() - Date.now();
  if (waitUntilStart > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitUntilStart));
  }
  for (const worker of seed.actors.workers) {
    const [assignment] = await db
      .select({ startedAt: questAssignment.startedAt })
      .from(questAssignment)
      .where(and(eq(questAssignment.questId, current.id), eq(questAssignment.workerId, worker.id)))
      .limit(1);
    if (!assignment) throw new Error(`Missing Worker Assignment for ${seed.title}.`);
    if (assignment.startedAt) continue;
    const started = await startQuestWork(
      'v2',
      worker.id,
      current.id,
      `frontend-demo-v1:${seed.plan.key}:start:${worker.id}`
    );
    if ('outcome' in started) {
      throw new Error(`Could not start frontend demo Quest ${seed.title}: ${started.outcome}`);
    }
    current = await readDemoQuest(seed);
  }
  return current;
};

const failDemoQuestAtDueAt = async (
  seed: DemoExtraQuest,
  current: DemoQuestRow
): Promise<DemoQuestRow> => {
  if (current.status !== 'QUEST_ASSIGNED' || !current.dueAt) {
    throw new Error(`Frontend demo Quest ${seed.title} is not waiting for Start Work.`);
  }
  const waitMilliseconds = current.dueAt.getTime() - Date.now() + 1;
  if (waitMilliseconds > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMilliseconds));
  }
  if (!(await failQuestV2AtDueAt(current.id))) {
    throw new Error(`Frontend demo Quest ${seed.title} did not fail at dueAt.`);
  }
  return readDemoQuest(seed);
};

const ensureDemoQuestWorkflow = async (
  seed: DemoExtraQuest,
  tagId: string
): Promise<DemoQuestRow> => {
  let current = await ensureDemoQuest(seed, tagId);
  if (seed.plan.workflow === 'DRAFT') return current;
  current = await publishDemoQuest(seed, current);
  if (seed.plan.workflow === 'OPEN') return current;

  if (seed.plan.workflow === 'CANCELLED') {
    if (current.status === 'QUEST_OPEN') {
      const cancelled = await cancelQuestV2(
        seed.actors.hirer.id,
        current.id,
        `frontend-demo-v1:${seed.plan.key}:cancel`
      );
      if (!('questStatus' in cancelled) || cancelled.questStatus !== 'QUEST_CANCELLED') {
        throw new Error(
          `Could not cancel frontend demo Quest ${seed.title}: ${JSON.stringify(cancelled)}`
        );
      }
      current = await readDemoQuest(seed);
    }
    return current;
  }

  if (seed.plan.workflow === 'FAILED') {
    if (current.status === 'QUEST_OPEN') current = await ensureDemoAssignments(seed, current);
    if (current.status !== 'QUEST_ASSIGNED' && current.status !== 'QUEST_FAILED') {
      throw new Error(
        `Frontend demo Quest ${seed.title} cannot reach QUEST_FAILED from ${current.status}.`
      );
    }
    return current;
  }

  if (current.status === 'QUEST_OPEN') current = await ensureDemoAssignments(seed, current);
  if (seed.plan.workflow === 'ASSIGNED') return current;

  if (current.status === 'QUEST_ASSIGNED') current = await startDemoQuestWorkers(seed, current);
  if (seed.plan.workflow === 'IN_PROGRESS') return current;

  if (seed.plan.workflow === 'COMPLETED' && current.status === 'QUEST_IN_PROGRESS') {
    const worker = seed.actors.workers[0]!;
    const confirmation = await confirmQuestV2Completion(
      worker.id,
      current.id,
      `frontend-demo-v1:${seed.plan.key}:complete`
    );
    if ('outcome' in confirmation) {
      throw new Error(
        `Could not complete frontend demo Quest ${seed.title}: ${confirmation.outcome}`
      );
    }
    current = await readDemoQuest(seed);
    return current;
  }
  return current;
};

const seedExtraQuests = async (
  seeds: DemoExtraQuest[],
  tagId: string
): Promise<SeededExtraQuestResults> => {
  const seededQuests: Array<{ seed: DemoExtraQuest; current: DemoQuestRow }> = [];
  for (const seed of seeds) {
    seededQuests.push({ seed, current: await ensureDemoQuestWorkflow(seed, tagId) });
  }

  const pendingFailures = seededQuests.filter(
    ({ seed, current }) => seed.plan.workflow === 'FAILED' && current.status === 'QUEST_ASSIGNED'
  );
  for (const { seed, current } of pendingFailures) {
    const failed = await failDemoQuestAtDueAt(seed, current);
    if (failed.status !== 'QUEST_FAILED') {
      throw new Error(`Frontend demo Quest ${seed.title} did not fail at dueAt.`);
    }
  }

  const statuses: string[] = [];
  const failedQuests: FailedQuestSeed[] = [];
  const workConversations: WorkConversationSeed[] = [];
  for (const { seed } of seededQuests) {
    const current = await readDemoQuest(seed);
    statuses.push(current.status);
    if (seed.plan.workflow === 'FAILED') {
      if (current.status !== 'QUEST_FAILED') {
        throw new Error(`Frontend demo Quest ${seed.title} is not failed for Admin case fixtures.`);
      }
      const assignments = await db
        .select({ id: questAssignment.id, workerId: questAssignment.workerId })
        .from(questAssignment)
        .where(eq(questAssignment.questId, current.id));
      const assignmentIds = new Map(assignments.map(({ id, workerId }) => [workerId, id]));
      const workerAId = assignmentIds.get(seed.actors.roleIds.workerA);
      const workerBId = assignmentIds.get(seed.actors.roleIds.workerB);
      const workerCId = assignmentIds.get(seed.actors.roleIds.workerC);
      if (!workerAId || !workerBId || !workerCId) {
        throw new Error(`Missing failed Quest Assignments for ${seed.title}.`);
      }
      failedQuests.push({
        questId: current.id,
        hirerId: seed.actors.hirer.id,
        roleIds: seed.actors.roleIds,
        assignmentIds: { workerA: workerAId, workerB: workerBId, workerC: workerCId },
      });
    }
    if (seed.plan.workflow === 'IN_PROGRESS') {
      const [conversation] = await db
        .select({ id: chatConversation.id })
        .from(chatConversation)
        .where(
          and(
            eq(chatConversation.questId, current.id),
            eq(chatConversation.type, 'CONVERSATION_WORK')
          )
        )
        .limit(1);
      if (!conversation) throw new Error(`Missing Work Conversation for ${seed.title}.`);
      workConversations.push({
        conversationId: conversation.id,
        hirerId: seed.actors.hirer.id,
        workerId: seed.actors.workers[0]!.id,
      });
    }
  }
  return { statuses, failedQuests, workConversations };
};

const applyDisputeStatus = async (input: {
  adminId: string;
  caseId: string;
  desiredStatus: (typeof disputeStatusPool)[number];
  resolvedWorkerId: string;
}): Promise<string> => {
  const [current] = await db
    .select({
      id: adminDisputeCase.id,
      status: adminDisputeCase.status,
      version: adminDisputeCase.version,
    })
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, input.caseId))
    .limit(1);
  if (!current) throw new Error('Seed Dispute Case was not stored.');
  if (
    input.desiredStatus === disputeCaseStatus.pending ||
    current.status !== disputeCaseStatus.pending
  ) {
    return current.status;
  }

  await resolveAdminDisputeCase({
    adminId: input.adminId,
    disputeCaseId: current.id,
    expectedVersion: current.version,
    requestKey: `frontend-demo-v1:dispute:${current.id}:${input.desiredStatus}`,
    reasonCode: 'DISPUTE_EVIDENCE_REVIEW',
    outcome: input.desiredStatus,
    ...(input.desiredStatus === disputeCaseStatus.resolved
      ? { workerId: input.resolvedWorkerId, amountSatang: disputeResolutionSatang }
      : {}),
  });
  const [updated] = await db
    .select({ status: adminDisputeCase.status })
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, current.id))
    .limit(1);
  if (!updated) throw new Error('Seed Dispute Case status was not stored.');
  return updated.status;
};

const seedDisputeCases = async (
  adminId: string,
  plan: DemoFrontendSeedPlan,
  failedQuests: FailedQuestSeed[]
): Promise<string[]> => {
  const results: string[] = [];
  for (const seed of plan.disputeCases) {
    const questSeed = failedQuests[seed.questIndex];
    if (!questSeed) throw new Error(`Missing failed Quest fixture ${seed.questIndex + 1}.`);
    const disputeCase = await createAdminDisputeCase({
      questId: questSeed.questId,
      filerUserId: questSeed.roleIds[seed.filerRole],
    });
    results.push(
      await applyDisputeStatus({
        adminId,
        caseId: disputeCase.id,
        desiredStatus: seed.status,
        resolvedWorkerId: questSeed.roleIds[seed.resolvedWorkerRole],
      })
    );
  }
  return results;
};

const applyConductReportStatus = async (input: {
  adminId: string;
  reportId: string;
  desiredStatus: (typeof conductStatusPool)[number];
}): Promise<string> => {
  const [current] = await db
    .select({
      id: adminConductReport.id,
      status: adminConductReport.status,
      version: adminConductReport.version,
    })
    .from(adminConductReport)
    .where(eq(adminConductReport.id, input.reportId))
    .limit(1);
  if (!current) throw new Error('Seed Conduct Report was not stored.');
  if (
    input.desiredStatus === conductReportStatus.pending ||
    current.status !== conductReportStatus.pending
  ) {
    return current.status;
  }

  const command = {
    adminId: input.adminId,
    reportId: current.id,
    expectedVersion: current.version,
    requestKey: `frontend-demo-v1:conduct:${current.id}:${input.desiredStatus}`,
  };
  if (input.desiredStatus === conductReportStatus.dismissed) {
    await decideAdminReport({
      ...command,
      outcome: conductReportStatus.dismissed,
      decisionReasonCode: 'CONDUCT_REPORT_INSUFFICIENT_EVIDENCE',
    });
  } else {
    await decideAdminReport({
      ...command,
      outcome: conductReportStatus.upheld,
    });
  }
  const [updated] = await db
    .select({ status: adminConductReport.status })
    .from(adminConductReport)
    .where(eq(adminConductReport.id, current.id))
    .limit(1);
  if (!updated) throw new Error('Seed Conduct Report status was not stored.');
  return updated.status;
};

const seedConductReports = async (
  adminId: string,
  plan: DemoFrontendSeedPlan,
  failedQuests: FailedQuestSeed[]
): Promise<string[]> => {
  const results: string[] = [];
  for (const seed of plan.conductReports) {
    const questSeed = failedQuests[seed.questIndex];
    if (!questSeed) throw new Error(`Missing failed Quest fixture ${seed.questIndex + 1}.`);
    const filerUserId = questSeed.roleIds[seed.filerRole];
    const reportedMemberId = questSeed.roleIds[seed.reportedRole];
    const assignmentId = questSeed.assignmentIds[seed.assignmentRole];
    let [report] = await db
      .select({
        id: adminConductReport.id,
        status: adminConductReport.status,
      })
      .from(adminConductReport)
      .where(
        and(
          eq(adminConductReport.questId, questSeed.questId),
          eq(adminConductReport.reportedMemberId, reportedMemberId)
        )
      )
      .limit(1);
    if (!report) {
      // No Member filing service exists yet; link this retained row to a real Quest Assignment.
      [report] = await db
        .insert(adminConductReport)
        .values({
          questId: questSeed.questId,
          filerUserId,
          reportedMemberId,
          assignmentId,
          reason: seed.reason,
          detail:
            seed.reason === conductReportReason.abandoned
              ? 'The assigned Worker did not submit required work.'
              : seed.reason === conductReportReason.outOfScope
                ? 'The Worker reports that requested work exceeded the Quest Condition.'
                : 'The assigned Worker did not attend or submit required work.',
        })
        .onConflictDoNothing({
          target: [adminConductReport.questId, adminConductReport.reportedMemberId],
        })
        .returning({ id: adminConductReport.id, status: adminConductReport.status });
    }
    if (!report) {
      [report] = await db
        .select({
          id: adminConductReport.id,
          status: adminConductReport.status,
        })
        .from(adminConductReport)
        .where(
          and(
            eq(adminConductReport.questId, questSeed.questId),
            eq(adminConductReport.reportedMemberId, reportedMemberId)
          )
        )
        .limit(1);
    }
    if (!report) throw new Error('Seed Conduct Report was not stored.');
    results.push(
      await applyConductReportStatus({
        adminId,
        reportId: report.id,
        desiredStatus: seed.status,
      })
    );
  }
  return results;
};

const seedReportCases = async (
  adminId: string,
  plan: DemoFrontendSeedPlan,
  conversations: WorkConversationSeed[]
): Promise<string[]> => {
  const results: string[] = [];
  for (const seed of plan.reportCases) {
    const conversation = conversations[seed.index % conversations.length];
    if (!conversation) throw new Error('Missing Work Conversation for the Report Case demo.');
    const example = reportExamples[seed.reason];
    const senderId =
      seed.status === reportCaseStatus.hidden || seed.status === reportCaseStatus.restored
        ? conversation.workerId
        : seed.index % 2 === 0
          ? conversation.workerId
          : conversation.hirerId;
    const reporterId =
      senderId === conversation.workerId ? conversation.hirerId : conversation.workerId;
    const clientMessageId = `frontend-demo-v1-report-${seed.index + 1}`;
    let [message] = await db
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.conversationId, conversation.conversationId),
          eq(chatMessage.clientMessageId, clientMessageId)
        )
      )
      .limit(1);
    if (!message) {
      const created = await sendWorkConversationMessage(senderId, conversation.conversationId, {
        clientMessageId,
        text: example.text,
      });
      message = { id: created.id };
    }
    const [existingEntry] = await db
      .select({ id: adminReporterEntry.id })
      .from(adminReporterEntry)
      .where(
        and(
          eq(adminReporterEntry.messageId, message.id),
          eq(adminReporterEntry.reporterMemberId, reporterId)
        )
      )
      .limit(1);
    if (!existingEntry) {
      await submitMessageReport(reporterId, {
        messageId: message.id,
        reason: seed.reason,
        detail: example.detail,
      });
    }
    const [reportCase] = await db
      .select({ id: adminReportCase.id })
      .from(adminReportCase)
      .where(eq(adminReportCase.messageId, message.id))
      .orderBy(desc(adminReportCase.createdAt), desc(adminReportCase.id))
      .limit(1);
    if (!reportCase) throw new Error('Seed Report Case was not stored.');
    results.push(
      await applyReportStatus({
        adminId,
        caseId: reportCase.id,
        desiredStatus: seed.status,
      })
    );
  }
  return results;
};

const seedWalletStatuses = async (
  adminId: string,
  members: DemoSeedMember[],
  occupationMembers: DemoOccupationMember[]
): Promise<void> => {
  const desiredStatuses = [
    { memberId: occupationMembers[0]!.id, status: walletStatus.frozen },
    { memberId: occupationMembers[1]!.id, status: walletStatus.suspended },
    { memberId: members[0]!.id, status: walletStatus.closed },
  ] as const;
  for (const [index, desired] of desiredStatuses.entries()) {
    const wallet = await ensureWallet(desired.memberId);
    const [current] = await db
      .select({ status: walletWallet.walletStatus })
      .from(walletWallet)
      .where(eq(walletWallet.id, wallet.id))
      .limit(1);
    if (!current || current.status !== walletStatus.active) continue;
    await changeWalletStatusAdmin({
      adminId,
      walletId: wallet.id,
      toStatus: desired.status,
      reason: 'Local frontend demo seed: display the Wallet status in Admin.',
      requestKey: `frontend-demo-v1:wallet-status:${index + 1}`,
    });
  }
};

const applyReportStatus = async (input: {
  adminId: string;
  caseId: string;
  desiredStatus: (typeof reportStatusPool)[number];
}): Promise<string> => {
  const [current] = await db
    .select({
      id: adminReportCase.id,
      status: adminReportCase.status,
      version: adminReportCase.version,
    })
    .from(adminReportCase)
    .where(eq(adminReportCase.id, input.caseId))
    .limit(1);
  if (!current) throw new Error('Seed Report Case was not stored.');
  const desiredStatus = input.desiredStatus;
  if (desiredStatus === reportCaseStatus.pending) return current.status;
  if (
    current.status === desiredStatus ||
    current.status === reportCaseStatus.dismissed ||
    current.status === reportCaseStatus.restored
  ) {
    return current.status;
  }

  const decide = async (
    outcome: Exclude<(typeof reportStatusPool)[number], typeof reportCaseStatus.pending>,
    version: number
  ) =>
    decideAdminReportCase({
      adminId: input.adminId,
      reportId: current.id,
      expectedVersion: version,
      requestKey: `frontend-demo-v1:report:${current.id}:${outcome}`,
      reasonCode: outcome === reportCaseStatus.dismissed ? 'POLICY_REVIEW' : 'SAFETY_REVIEW',
      outcome,
    });

  let version = current.version;
  if (desiredStatus === reportCaseStatus.restored && current.status === reportCaseStatus.pending) {
    const hidden = await decide(reportCaseStatus.hidden, version);
    version = hidden.resourceVersion ?? version + 1;
  }
  if (current.status === reportCaseStatus.pending || current.status === reportCaseStatus.hidden) {
    await decide(desiredStatus, version);
  }
  const [saved] = await db
    .select({ status: adminReportCase.status })
    .from(adminReportCase)
    .where(eq(adminReportCase.id, current.id))
    .limit(1);
  if (!saved) throw new Error('Seed Report Case status was not stored.');
  return saved.status;
};

const summarize = (label: string, statuses: string[]) => {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  console.log(`${label}: ${[...counts].map(([status, count]) => `${status}=${count}`).join(', ')}`);
};

const main = async (): Promise<void> => {
  assertLocalDevelopment();
  assertDemoSeedEnvironment();
  await ensureInitialMoneyPolicy();
  await seedAcademicOptions();
  await seedQuestTags();
  await ensureAdminAccount();
  await seedDemoMembers();
  const occupationMembers = await ensureOccupationDemoMembers();
  await seedDemoQuests();

  const [{ adminId, tagId }, members] = await Promise.all([
    loadSeedReferences(),
    loadDemoMembers(),
  ]);
  const plan = createDemoFrontendSeedPlan();
  if (plan.quests.length !== 50) throw new Error('Frontend demo seed plan must have 50 Quests.');
  const extraQuestSeeds = prepareExtraQuestSeeds(plan, members);
  await seedExtraQuestBudgets(extraQuestSeeds);
  const extraQuestResults = await seedExtraQuests(extraQuestSeeds, tagId);
  const reportCaseStatuses = await seedReportCases(
    adminId,
    plan,
    extraQuestResults.workConversations
  );
  const conductReportStatuses = await seedConductReports(
    adminId,
    plan,
    extraQuestResults.failedQuests
  );
  const disputeCaseStatuses = await seedDisputeCases(adminId, plan, extraQuestResults.failedQuests);

  await seedTopUps(members);
  await seedPayouts(adminId, members);
  await seedWalletStatuses(adminId, members, occupationMembers);

  summarize('Additional Quests', extraQuestResults.statuses);
  summarize('Report Cases', reportCaseStatuses);
  summarize('Conduct Reports', conductReportStatuses);
  summarize('Dispute Cases', disputeCaseStatuses);
  console.log(
    'Frontend demo seed plan: 50 Quests, 20 Report Cases, 15 Conduct Reports, and 15 Dispute Cases.'
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
