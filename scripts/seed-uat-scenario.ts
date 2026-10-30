/* eslint-disable no-await-in-loop -- Seed steps keep each Quest workflow in domain order. */
// UAT scenario seed: realistic Members, real Xendit Development Top-ups, and Quest activity
// created through the same domain services the HTTP controllers call. It only adds data.
// Run inside the UAT API image with UAT_SEED_CONFIRM set; see docs/operations/uat-scenario-seed.md.

import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { department, occupation } from '@/database/schema/academic.schema';
import {
  adminConductReport,
  adminDisputeCase,
  adminReportCase,
  conductReportReason,
  conductReportStatus,
  disputeCaseStatus,
  reportCaseStatus,
} from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { paymentPayouts, paymentTopUp } from '@/database/schema/payment.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { chatConversation, chatMessage } from '@/database/schema/work-chat.schema';
import {
  walletEarningsConversion,
  walletIdempotencyKey,
  walletStatus,
} from '@/database/schema/wallet.schema';
import { seedAcademicOptions } from '@/modules/academic-registration/academic-registration.service';
import { decideAdminReport, decideAdminReportCase } from '@/modules/admin/admin-report.service';
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
  createQuestV2CandidateApplication,
  createQuestV2ConductReport,
  createQuestV2ProofSubmission,
  createQuestV2Review,
  failQuestV2AtDueAt,
  formatQuestV2ScheduleTime,
  joinQuestV2,
  publishQuestV2,
  reviewQuestV2ProofSubmission,
  selectQuestV2CandidateApplication,
  startQuestWork,
  submitQuestV2ProofSubmission,
} from '@/modules/quest';
import type { QuestV2CreateInput } from '@/modules/quest';
import {
  createAdminDisputeCase,
  resolveAdminDisputeCase,
} from '@/modules/quest/admin/quest-dispute-admin.service';
import { legacyTagMappings, seedQuestTags } from '@/modules/tag/tag.service';
import {
  initiateTopUp,
  quoteTopUp,
  simulateTopUpPayment,
  topUpOperationScope,
  topUpTestSimulationIsEnabled,
} from '@/modules/top-up';
import { uatSeedConfirmation } from '@/modules/top-up/top-up.test-mode.service';
import {
  convertEarnings,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
} from '@/modules/wallet';
import { changeWalletStatusAdmin } from '@/modules/wallet/wallet.admin.service';
import { sendWorkConversationMessage } from '@/modules/work-chat/work-chat.service';
import { submitMessageReport } from '@/modules/work-chat/message-report.service';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { storeDemoImage } from './demo-seed';
import {
  uatScenarioChat,
  uatScenarioEmailDomain,
  uatScenarioMembers,
  uatScenarioQuestTemplates,
  uatScenarioReviewComments,
  type UatScenarioQuestTemplate,
} from './uat-scenario-data';

const prefix = 'uat-scenario-v1';
const day = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- environment

export const assertUatScenarioEnvironment = (): void => {
  const local = env.nodeEnv === 'development' && env.deploymentEnv === 'development';
  const uat =
    env.nodeEnv === 'production' &&
    env.deploymentEnv === 'uat' &&
    process.env.UAT_SEED_CONFIRM === uatSeedConfirmation;
  if (!local && !uat) {
    throw new Error(
      `The UAT scenario seed runs only in development, or in production/uat with UAT_SEED_CONFIRM='${uatSeedConfirmation}'.`
    );
  }
  if (!topUpTestSimulationIsEnabled()) {
    throw new Error('The UAT scenario seed needs an Xendit Development key for real test Top-ups.');
  }
};

// ---------------------------------------------------------------- Members

type SeededMember = { key: string; id: string; firstName: string; lastName: string };

const emailFor = (firstName: string, lastName: string) =>
  `${firstName}.${lastName}`.toLowerCase() + `@${uatScenarioEmailDomain}`;

const seedMembers = async (): Promise<Map<string, SeededMember>> => {
  const departments = await db
    .select({ id: department.id, name: department.name })
    .from(department);
  const occupations = await db.select().from(occupation);
  const members = new Map<string, SeededMember>();
  for (const [index, member] of uatScenarioMembers.entries()) {
    const academicDepartment = departments.find(({ name }) => name === member.department);
    const memberOccupation = occupations.find(({ name }) => name === member.occupation);
    if (!academicDepartment) throw new Error(`Missing Department: ${member.department}`);
    if (!memberOccupation) throw new Error(`Missing Occupation: ${member.occupation}`);
    const isStudent = memberOccupation.requiresStudentId;
    const profile = {
      firstName: member.firstName,
      lastName: member.lastName,
      bio: member.bio,
      telephone: `08${String(61_000_000 + index * 7_919).padStart(8, '0')}`,
      studentId: isStudent
        ? `${String(member.academicYear ?? 2566).slice(2)}10${String(52_301 + index * 37).padStart(6, '0')}`
        : null,
      academicYear: isStudent ? member.academicYear : null,
      departmentId: academicDepartment.id,
      occupationId: memberOccupation.id,
      emailVerified: true,
      termsAcceptedAt: new Date(),
      termsVersion: '1.0',
    };
    const email = emailFor(member.firstName, member.lastName);
    // No credential Account row: seeded Members are data only and cannot sign in.
    const [user] = await db
      .insert(authUser)
      .values({ email, ...profile })
      .onConflictDoUpdate({ target: authUser.email, set: { bio: profile.bio } })
      .returning({ id: authUser.id, imageFileId: authUser.imageFileId });
    if (!user) throw new Error(`Could not seed Member ${email}`);
    await ensureWallet(user.id);
    if (member.avatar !== null && !user.imageFileId) {
      const avatarId = await storeDemoImage(
        user.id,
        `${prefix}/${user.id}/avatar.jpg`,
        `avatar-${member.avatar}.jpg`
      );
      await db.update(authUser).set({ imageFileId: avatarId }).where(eq(authUser.id, user.id));
    }
    members.set(member.key, {
      key: member.key,
      id: user.id,
      firstName: member.firstName,
      lastName: member.lastName,
    });
  }
  console.log(`Members: ${members.size} prepared on @${uatScenarioEmailDomain}`);
  return members;
};

// ---------------------------------------------------------------- Quest plan

type Flow =
  | 'DRAFT'
  | 'OPEN'
  | 'OPEN_CANDIDATES'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'PROOF_PENDING'
  | 'COMPLETED'
  | 'COMPLETED_GROUP'
  | 'COMPLETED_CANDIDATE'
  | 'COMPLETED_NO_PROOF'
  | 'FAILED_NOT_APPROVED'
  | 'FAILED_DUE'
  | 'CANCELLED';

type QuestPlan = {
  key: string;
  flow: Flow;
  template: UatScenarioQuestTemplate;
  templateIndex: number;
  hirer: string;
  workers: string[];
  applicants: string[];
};

const hirerPool = [
  'm37',
  'm38',
  'm39',
  'm40',
  'm02',
  'm03',
  'm08',
  'm14',
  'm23',
  'm33',
  'm12',
  'm25',
];
// Students who take terminal work; they may repeat because a finished Assignment is not active.
const terminalWorkerPool = [
  'm01',
  'm04',
  'm05',
  'm06',
  'm07',
  'm09',
  'm10',
  'm13',
  'm16',
  'm22',
  'm26',
  'm28',
];
// One Member per still-active Assignment, so no Worker has two overlapping active schedules.
const activeWorkerPool = [
  'm11',
  'm15',
  'm17',
  'm18',
  'm19',
  'm20',
  'm21',
  'm24',
  'm27',
  'm29',
  'm30',
  'm31',
];
const applicantPool = ['m32', 'm34', 'm35', 'm36', 'm01', 'm06', 'm10', 'm13'];

const flowCounts: Array<[Flow, number]> = [
  ['COMPLETED', 13],
  ['COMPLETED_GROUP', 3],
  ['COMPLETED_CANDIDATE', 3],
  ['COMPLETED_NO_PROOF', 2],
  ['FAILED_NOT_APPROVED', 4],
  ['FAILED_DUE', 2],
  ['CANCELLED', 4],
  ['PROOF_PENDING', 4],
  ['IN_PROGRESS', 4],
  ['ASSIGNED', 3],
  ['OPEN', 8],
  ['OPEN_CANDIDATES', 4],
  ['DRAFT', 4],
];

export const createUatScenarioPlan = (): QuestPlan[] => {
  const plans: QuestPlan[] = [];
  let sequence = 0;
  let terminalCursor = 0;
  let activeCursor = 0;
  let applicantCursor = 0;
  const takeTerminal = (count: number, hirer: string) => {
    const taken: string[] = [];
    while (taken.length < count) {
      const candidate = terminalWorkerPool[terminalCursor++ % terminalWorkerPool.length]!;
      if (candidate !== hirer && !taken.includes(candidate)) taken.push(candidate);
    }
    return taken;
  };
  const takeApplicants = (count: number, hirer: string) => {
    const taken: string[] = [];
    while (taken.length < count) {
      const candidate = applicantPool[applicantCursor++ % applicantPool.length]!;
      if (candidate !== hirer && !taken.includes(candidate)) taken.push(candidate);
    }
    return taken;
  };
  for (const [flow, count] of flowCounts) {
    for (let index = 0; index < count; index += 1) {
      const templateIndex = (sequence * 11) % uatScenarioQuestTemplates.length;
      const hirer = hirerPool[sequence % hirerPool.length]!;
      let workers: string[] = [];
      let applicants: string[] = [];
      if (['IN_PROGRESS', 'PROOF_PENDING', 'ASSIGNED'].includes(flow)) {
        workers = [activeWorkerPool[activeCursor++]!];
      } else if (flow === 'COMPLETED_GROUP') {
        workers = takeTerminal(2, hirer);
      } else if (flow === 'COMPLETED_CANDIDATE') {
        applicants = takeApplicants(3, hirer);
        workers = [applicants[index % applicants.length]!];
      } else if (flow === 'OPEN_CANDIDATES') {
        applicants = takeApplicants(2 + (index % 3), hirer);
      } else if (!['DRAFT', 'OPEN', 'CANCELLED'].includes(flow)) {
        workers = takeTerminal(1, hirer);
      }
      plans.push({
        key: `${flow.toLowerCase()}-${String(index + 1).padStart(2, '0')}`,
        flow,
        template: uatScenarioQuestTemplates[templateIndex]!,
        templateIndex,
        hirer,
        workers,
        applicants,
      });
      sequence += 1;
    }
  }
  const identities = new Set(plans.map((plan) => `${plan.hirer}|${plan.template.title}`));
  if (identities.size !== plans.length) throw new Error('A Hirer has the same Quest title twice.');
  return plans;
};

// ---------------------------------------------------------------- Top-ups (real Xendit Development)

const idempotentResourceId = async (userId: string, scope: string, key: string) => {
  const [entry] = await db
    .select({ resourceId: walletIdempotencyKey.resourceId })
    .from(walletIdempotencyKey)
    .where(
      and(
        eq(walletIdempotencyKey.principalUserId, userId),
        eq(walletIdempotencyKey.operationScope, scope),
        eq(walletIdempotencyKey.key, key)
      )
    )
    .limit(1);
  return entry?.resourceId ?? null;
};

type TopUpJob = { memberId: string; creditBaht: number; key: string; pay: boolean };

const runTopUp = async (job: TopUpJob): Promise<string> => {
  const existingId = await idempotentResourceId(job.memberId, topUpOperationScope, job.key);
  let topUpId = existingId;
  if (!topUpId) {
    const quote = await quoteTopUp({
      principalUserId: job.memberId,
      creditSatang: positiveSatang(job.creditBaht * 100),
    });
    const topUp = await initiateTopUp({
      principalUserId: job.memberId,
      quoteId: quote.id,
      idempotency: { key: job.key },
    });
    topUpId = topUp.id;
  }
  const [row] = await db
    .select({ status: paymentTopUp.topUpStatus })
    .from(paymentTopUp)
    .where(eq(paymentTopUp.id, topUpId))
    .limit(1);
  if (!job.pay || row?.status !== 'PENDING') return row?.status ?? 'UNKNOWN';
  const simulated = await simulateTopUpPayment(job.memberId, topUpId);
  return simulated.topUp.topUpStatus;
};

const runTopUps = async (jobs: TopUpJob[]): Promise<void> => {
  const statuses: string[] = [];
  // Each simulation can wait 30 seconds for the callback, so run a few at once.
  for (let start = 0; start < jobs.length; start += 6) {
    const batch = jobs.slice(start, start + 6);
    statuses.push(...(await Promise.all(batch.map(runTopUp))));
    console.log(`Top-ups: ${Math.min(start + 6, jobs.length)}/${jobs.length}`);
  }
  summarize('Top-ups', statuses);
};

/** Splits a funding need into realistic PromptPay amounts (300 to 2,000 Baht). */
const topUpAmounts = (needBaht: number): number[] => {
  const steps = [2_000, 1_500, 1_000, 500, 300];
  const amounts: number[] = [];
  let remaining = Math.ceil(needBaht / 100) * 100;
  while (remaining > 0) {
    const amount = steps.find((step) => step <= remaining) ?? 300;
    amounts.push(amount);
    remaining -= amount;
  }
  return amounts;
};

const planTopUps = (plans: QuestPlan[], members: Map<string, SeededMember>): TopUpJob[] => {
  const needByHirer = new Map<string, number>();
  for (const plan of plans) {
    if (plan.flow === 'DRAFT') continue;
    const headcount = plan.flow === 'COMPLETED_GROUP' ? 2 : 1;
    needByHirer.set(
      plan.hirer,
      (needByHirer.get(plan.hirer) ?? 0) + plan.template.fundingBaht * headcount
    );
  }
  const jobs: TopUpJob[] = [];
  for (const [hirerKey, needBaht] of needByHirer) {
    const memberId = members.get(hirerKey)!.id;
    topUpAmounts(needBaht * 1.1 + 200).forEach((creditBaht, index) =>
      jobs.push({
        memberId,
        creditBaht,
        key: `${prefix}:top-up:${hirerKey}:${index + 1}`,
        pay: true,
      })
    );
  }
  // Members who top up without hiring yet, and a few unpaid PromptPay requests.
  for (const [key, creditBaht, pay] of [
    ['m01', 500, true],
    ['m22', 300, true],
    ['m31', 1_000, true],
    ['m35', 300, false],
    ['m28', 500, false],
    ['m16', 1_000, false],
  ] as const) {
    jobs.push({
      memberId: members.get(key)!.id,
      creditBaht,
      key: `${prefix}:top-up:${key}:extra`,
      pay,
    });
  }
  return jobs;
};

// ---------------------------------------------------------------- Quest workflows

type Context = {
  members: Map<string, SeededMember>;
  tags: Map<string, string>;
  adminId: string;
};

type SeededQuest = { plan: QuestPlan; questId: string; status: string; skipped: boolean };

const idOf = (context: Context, key: string) => context.members.get(key)!.id;

const readQuest = async (hirerId: string, title: string) => {
  const [row] = await db
    .select({
      id: quest.id,
      status: quest.questStatus,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
    })
    .from(quest)
    .where(and(eq(quest.hirerId, hirerId), eq(quest.apiVersion, 'v2'), eq(quest.title, title)))
    .limit(1);
  return row;
};

const failIfOutcome = (label: string, result: unknown) => {
  if (result && typeof result === 'object' && 'outcome' in result) {
    throw new Error(`${label}: ${JSON.stringify(result)}`);
  }
};

const waitUntil = async (time: Date) => {
  const wait = time.getTime() - Date.now() + 250;
  if (wait > 0) await Bun.sleep(wait);
};

const at = (hoursFromNow: number) => {
  // Round to the next quarter hour so schedules look hand-entered.
  const time = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  time.setUTCMinutes(Math.ceil(time.getUTCMinutes() / 15) * 15, 0, 0);
  return time;
};

const scheduleFor = (flow: Flow) => {
  if (['DRAFT', 'OPEN', 'OPEN_CANDIDATES', 'CANCELLED'].includes(flow)) {
    const start = at(24 * (3 + Math.floor(Math.random() * 10)));
    return { start, due: new Date(start.getTime() + (2 + Math.floor(Math.random() * 6)) * day) };
  }
  if (flow === 'ASSIGNED') {
    const start = at(24 * (1 + Math.floor(Math.random() * 3)));
    return { start, due: new Date(start.getTime() + 5 * day) };
  }
  // Work that happens in this run starts within seconds.
  const start = new Date(Date.now() + (flow === 'COMPLETED_CANDIDATE' ? 8_000 : 4_000));
  const due = new Date(start.getTime() + (flow === 'FAILED_DUE' ? 12_000 : 5 * day));
  return { start, due };
};

const createAndPublish = async (context: Context, plan: QuestPlan): Promise<string> => {
  const hirerId = idOf(context, plan.hirer);
  // Templates name the skill; Quest Tags are the fixed categories it maps to.
  const tagName = legacyTagMappings[plan.template.tag] ?? plan.template.tag;
  const tagId = context.tags.get(tagName);
  if (!tagId) throw new Error(`Missing Quest Tag ${tagName}`);
  const { start, due } = scheduleFor(plan.flow);
  const group = plan.flow === 'COMPLETED_GROUP';
  const created = await createQuestV2(
    hirerId,
    {
      title: plan.template.title,
      description: plan.template.description,
      condition: { items: [...plan.template.conditions] },
      mode: ['COMPLETED_CANDIDATE', 'OPEN_CANDIDATES'].includes(plan.flow)
        ? 'CANDIDATE'
        : 'FIRST_COME_FIRST_SERVED',
      participation: group ? 'GROUP' : 'SINGLE',
      // Quest Funding Total is per Worker; Escrow is this amount times headcount.
      questFundingTotal: plan.template.fundingBaht,
      headcount: group ? 2 : 1,
      startTime: formatQuestV2ScheduleTime(start),
      dueAt: formatQuestV2ScheduleTime(due),
      tagId,
      proofRequired: plan.flow !== 'COMPLETED_NO_PROOF',
      locations: [{ label: plan.template.location }],
    } satisfies QuestV2CreateInput,
    `${prefix}:${plan.key}:create`
  );
  if (!('quest' in created)) throw new Error(`Create ${plan.key}: ${JSON.stringify(created)}`);
  const row = await readQuest(hirerId, plan.template.title);
  if (!row) throw new Error(`Quest ${plan.key} was not stored.`);
  if (plan.flow === 'DRAFT') return row.id;
  const published = await publishQuestV2(hirerId, row.id, `${prefix}:${plan.key}:publish`);
  if (!published || !('quest' in published)) {
    throw new Error(`Publish ${plan.key}: ${JSON.stringify(published)}`);
  }
  return row.id;
};

const workConversationId = async (questId: string) => {
  const [conversation] = await db
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(
      and(eq(chatConversation.questId, questId), eq(chatConversation.type, 'CONVERSATION_WORK'))
    )
    .orderBy(asc(chatConversation.createdAt))
    .limit(1);
  return conversation?.id ?? null;
};

const chat = async (
  questId: string,
  plan: QuestPlan,
  context: Context,
  stage: 'kickoff' | 'progress' | 'wrap',
  lines: Array<{ from: 'hirer' | 'worker'; text: string }>
) => {
  const conversationId = await workConversationId(questId);
  if (!conversationId) return;
  for (const [index, line] of lines.entries()) {
    const senderId = idOf(context, line.from === 'hirer' ? plan.hirer : plan.workers[0]!);
    await sendWorkConversationMessage(senderId, conversationId, {
      clientMessageId: `${prefix}-${plan.key}-${stage}-${index + 1}`,
      text: line.text,
    });
  }
};

const pick = <T>(items: readonly T[], seed: number) => items[seed % items.length]!;

const sendProof = async (context: Context, plan: QuestPlan, questId: string, workerKey: string) => {
  const workerId = idOf(context, workerKey);
  const fileId = await storeDemoImage(
    workerId,
    `${prefix}/proof/${questId}/${workerId}.jpg`,
    `quest-${(plan.templateIndex % 10) + 1}.jpg`
  );
  const draft = await createQuestV2ProofSubmission(
    workerId,
    questId,
    { description: plan.template.proof, fileIds: [fileId] },
    `${prefix}:${plan.key}:proof:${workerKey}`
  );
  failIfOutcome(`Proof draft ${plan.key}`, draft);
  const proofId = (draft as { id: string }).id;
  const sent = await submitQuestV2ProofSubmission(
    workerId,
    questId,
    proofId,
    `${prefix}:${plan.key}:proof-send:${workerKey}`
  );
  failIfOutcome(`Proof send ${plan.key}`, sent);
  return proofId;
};

const review = async (
  context: Context,
  plan: QuestPlan,
  questId: string,
  workerKey: string,
  tone: 'good' | 'ok' | 'bad',
  seed: number
) => {
  const rating = tone === 'good' ? (seed % 3 === 0 ? 4 : 5) : tone === 'ok' ? 3 : 2;
  const hirerReview = await createQuestV2Review(
    idOf(context, plan.hirer),
    questId,
    {
      revieweeId: idOf(context, workerKey),
      rating,
      comment: pick(uatScenarioReviewComments[tone], seed),
    },
    `${prefix}:${plan.key}:review-hirer:${workerKey}`
  );
  failIfOutcome(`Hirer review ${plan.key}`, hirerReview);
  if (tone === 'bad') return;
  const workerReview = await createQuestV2Review(
    idOf(context, workerKey),
    questId,
    { rating: seed % 4 === 0 ? 4 : 5, comment: pick(uatScenarioReviewComments.hirer, seed) },
    `${prefix}:${plan.key}:review-worker:${workerKey}`
  );
  failIfOutcome(`Worker review ${plan.key}`, workerReview);
};

const runQuest = async (context: Context, plan: QuestPlan, seed: number): Promise<SeededQuest> => {
  const hirerId = idOf(context, plan.hirer);
  const existing = await readQuest(hirerId, plan.template.title);
  if (existing) return { plan, questId: existing.id, status: existing.status, skipped: true };

  const questId = await createAndPublish(context, plan);
  const finish = async () => {
    const row = await readQuest(hirerId, plan.template.title);
    return { plan, questId, status: row?.status ?? 'UNKNOWN', skipped: false };
  };
  if (plan.flow === 'DRAFT' || plan.flow === 'OPEN') return finish();

  if (plan.flow === 'CANCELLED') {
    const cancelled = await cancelQuestV2(hirerId, questId, `${prefix}:${plan.key}:cancel`);
    if (!('questStatus' in cancelled))
      throw new Error(`Cancel ${plan.key}: ${JSON.stringify(cancelled)}`);
    return finish();
  }

  // Candidate applications, then selection for the Candidate Quests that run.
  if (plan.applicants.length > 0) {
    const applicationIds = new Map<string, string>();
    for (const applicant of plan.applicants) {
      const application = await createQuestV2CandidateApplication(
        idOf(context, applicant),
        questId,
        `${prefix}:${plan.key}:apply:${applicant}`
      );
      failIfOutcome(`Apply ${plan.key}`, application);
      applicationIds.set(applicant, (application as { id: string }).id);
    }
    if (plan.flow === 'OPEN_CANDIDATES') return finish();
    const selected = await selectQuestV2CandidateApplication(
      hirerId,
      questId,
      applicationIds.get(plan.workers[0]!)!,
      `${prefix}:${plan.key}:select`
    );
    failIfOutcome(`Select ${plan.key}`, selected);
  } else {
    const row = await readQuest(hirerId, plan.template.title);
    for (const workerKey of plan.workers) {
      const joined = await joinQuestV2(
        idOf(context, workerKey),
        questId,
        `${prefix}:${plan.key}:join:${workerKey}`,
        new Date(Math.min(Date.now(), row!.startTime.getTime() - 1))
      );
      failIfOutcome(`Join ${plan.key}`, joined);
    }
  }
  await chat(questId, plan, context, 'kickoff', [
    { from: 'hirer', text: pick(uatScenarioChat.kickoff, seed) },
    { from: 'worker', text: pick(uatScenarioChat.kickoff, seed + 1) },
  ]);
  if (plan.flow === 'ASSIGNED') return finish();

  const row = await readQuest(hirerId, plan.template.title);
  if (plan.flow === 'FAILED_DUE') {
    await waitUntil(row!.dueAt!);
    if (!(await failQuestV2AtDueAt(questId))) throw new Error(`${plan.key} did not fail at dueAt.`);
    return finish();
  }

  await waitUntil(row!.startTime);
  for (const workerKey of plan.workers) {
    const started = await startQuestWork(
      'v2',
      idOf(context, workerKey),
      questId,
      `${prefix}:${plan.key}:start:${workerKey}`
    );
    failIfOutcome(`Start ${plan.key}`, started);
  }
  await chat(questId, plan, context, 'progress', [
    { from: 'worker', text: pick(uatScenarioChat.progress, seed) },
    { from: 'hirer', text: pick(uatScenarioChat.progress, seed + 2) },
  ]);
  if (plan.flow === 'IN_PROGRESS') return finish();

  if (plan.flow === 'COMPLETED_NO_PROOF') {
    const confirmed = await confirmQuestV2Completion(
      idOf(context, plan.workers[0]!),
      questId,
      `${prefix}:${plan.key}:complete`
    );
    failIfOutcome(`Complete ${plan.key}`, confirmed);
    await review(context, plan, questId, plan.workers[0]!, 'good', seed);
    return finish();
  }

  const proofIds = new Map<string, string>();
  for (const workerKey of plan.workers) {
    proofIds.set(workerKey, await sendProof(context, plan, questId, workerKey));
  }
  // The Work Conversation closes at the decision, so talk about the proof before it.
  await chat(questId, plan, context, 'wrap', [
    { from: 'worker', text: uatScenarioChat.wrap[0]! },
    { from: 'hirer', text: pick(uatScenarioChat.wrap.slice(1), seed) },
  ]);
  if (plan.flow === 'PROOF_PENDING') return finish();

  const notApproved = plan.flow === 'FAILED_NOT_APPROVED';
  for (const workerKey of plan.workers) {
    const decided = await reviewQuestV2ProofSubmission(
      hirerId,
      questId,
      proofIds.get(workerKey)!,
      notApproved ? 'PROOF_NOT_APPROVED' : 'PROOF_APPROVED',
      notApproved
        ? pick(
            [
              'The photos do not show the full booth as the condition requires.',
              'Only part of the files were delivered and the deadline has passed.',
              'The result does not match the brief we agreed in chat.',
            ],
            seed
          )
        : null,
      `${prefix}:${plan.key}:decide:${workerKey}`
    );
    failIfOutcome(`Proof decision ${plan.key}`, decided);
  }
  for (const workerKey of plan.workers) {
    await review(
      context,
      plan,
      questId,
      workerKey,
      notApproved ? 'bad' : seed % 5 === 0 ? 'ok' : 'good',
      seed
    );
  }
  return finish();
};

// ---------------------------------------------------------------- Admin cases

const reportMessages = [
  {
    reason: 'REPORT_SPAM',
    text: 'Join my crypto group for guaranteed profit!! link in my bio',
    detail: 'Unrelated promotion in a Work Conversation.',
  },
  {
    reason: 'REPORT_ABUSIVE_OR_HARASSMENT',
    text: 'Are you stupid? I already told you three times.',
    detail: 'Insulting language toward the Worker.',
  },
  {
    reason: 'REPORT_INAPPROPRIATE_CONTENT',
    text: 'Send me your personal LINE and home address so we can skip the app.',
    detail: 'Asks for private contact details outside KU Quest.',
  },
  {
    reason: 'REPORT_OTHER',
    text: 'I will only finish if you pay me extra in cash.',
    detail: 'Asks for payment outside the platform.',
  },
  {
    reason: 'REPORT_SPAM',
    text: 'Selling used textbooks cheap, DM me!!!',
    detail: 'Repeated advertising.',
  },
  {
    reason: 'REPORT_DANGER_OR_THREAT',
    text: 'You will regret it if you give me a bad review.',
    detail: 'Threat about the review.',
  },
] as const;
const reportOutcomes = [
  reportCaseStatus.pending,
  reportCaseStatus.pending,
  reportCaseStatus.dismissed,
  reportCaseStatus.hidden,
  reportCaseStatus.restored,
  reportCaseStatus.hidden,
] as const;

const seedReportCases = async (context: Context, active: SeededQuest[]) => {
  const statuses: string[] = [];
  const candidates = active.filter(({ plan }) =>
    ['IN_PROGRESS', 'PROOF_PENDING'].includes(plan.flow)
  );
  for (const [index, report] of reportMessages.entries()) {
    const target = candidates[index % candidates.length];
    if (!target) break;
    const conversationId = await workConversationId(target.questId);
    if (!conversationId) continue;
    const workerSends = index % 2 === 0;
    const senderId = idOf(context, workerSends ? target.plan.workers[0]! : target.plan.hirer);
    const reporterId = idOf(context, workerSends ? target.plan.hirer : target.plan.workers[0]!);
    const clientMessageId = `${prefix}-report-${index + 1}`;
    let [message] = await db
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.conversationId, conversationId),
          eq(chatMessage.clientMessageId, clientMessageId)
        )
      )
      .limit(1);
    if (!message) {
      const created = await sendWorkConversationMessage(senderId, conversationId, {
        clientMessageId,
        text: report.text,
      });
      message = { id: created.id };
      await submitMessageReport(reporterId, {
        messageId: message.id,
        reason: report.reason,
        detail: report.detail,
      });
    }
    const [reportCase] = await db
      .select({
        id: adminReportCase.id,
        status: adminReportCase.status,
        version: adminReportCase.version,
      })
      .from(adminReportCase)
      .where(eq(adminReportCase.messageId, message.id))
      .limit(1);
    if (!reportCase) throw new Error('Report Case was not stored.');
    const desired = reportOutcomes[index]!;
    if (reportCase.status === reportCaseStatus.pending && desired !== reportCaseStatus.pending) {
      const command = { adminId: context.adminId, reportId: reportCase.id };
      if (desired === reportCaseStatus.dismissed) {
        await decideAdminReportCase({
          ...command,
          expectedVersion: reportCase.version,
          requestKey: `${prefix}:report:${index}:dismiss`,
          outcome: desired,
          reasonCode: 'REPORT_NO_POLICY_VIOLATION',
        });
      } else {
        const hidden = await decideAdminReportCase({
          ...command,
          expectedVersion: reportCase.version,
          requestKey: `${prefix}:report:${index}:hide`,
          outcome: reportCaseStatus.hidden,
          reasonCode: 'REPORT_SPAM_CONFIRMED',
        });
        if (desired === reportCaseStatus.restored) {
          await decideAdminReportCase({
            ...command,
            expectedVersion: hidden.resourceVersion ?? reportCase.version + 1,
            requestKey: `${prefix}:report:${index}:restore`,
            outcome: desired,
            reasonCode: 'REPORT_MESSAGE_COMPLIES_WITH_POLICY',
          });
        }
      }
    }
    const [saved] = await db
      .select({ status: adminReportCase.status })
      .from(adminReportCase)
      .where(eq(adminReportCase.id, reportCase.id))
      .limit(1);
    statuses.push(saved?.status ?? 'UNKNOWN');
  }
  summarize('Report Cases', statuses);
};

const seedDisputes = async (context: Context, seeded: SeededQuest[]) => {
  const statuses: string[] = [];
  const failed = seeded.filter(({ plan }) => plan.flow === 'FAILED_NOT_APPROVED');
  const outcomes = [
    disputeCaseStatus.pending,
    disputeCaseStatus.resolved,
    disputeCaseStatus.dismissed,
  ];
  for (const [index, target] of failed.slice(0, outcomes.length).entries()) {
    const workerKey = target.plan.workers[0]!;
    const disputeCase = await createAdminDisputeCase({
      questId: target.questId,
      filerUserId: idOf(context, workerKey),
      category: index === 2 ? 'QUEST_CONDITION' : 'PROOF_REVIEW',
      submittedDetail: pick(
        [
          'I delivered every file listed in the Quest Condition. The Hirer rejected it after the deadline without asking for a fix.',
          'The Hirer changed the requirement in chat after I started. My proof matches the original Quest Condition.',
          'I completed most of the work and the Hirer used it. I ask for a partial Reward.',
        ],
        index
      ),
    });
    const desired = outcomes[index]!;
    const [current] = await db
      .select({
        id: adminDisputeCase.id,
        status: adminDisputeCase.status,
        version: adminDisputeCase.version,
      })
      .from(adminDisputeCase)
      .where(eq(adminDisputeCase.id, disputeCase.id))
      .limit(1);
    if (
      current &&
      current.status === disputeCaseStatus.pending &&
      desired !== disputeCaseStatus.pending
    ) {
      await resolveAdminDisputeCase({
        adminId: context.adminId,
        disputeCaseId: current.id,
        expectedVersion: current.version,
        requestKey: `${prefix}:dispute:${target.plan.key}`,
        reasonCode:
          desired === disputeCaseStatus.resolved
            ? 'DISPUTE_VALID_PROOF_NOT_APPROVED'
            : 'DISPUTE_INSUFFICIENT_EVIDENCE',
        outcome: desired,
        ...(desired === disputeCaseStatus.resolved
          ? {
              workerId: idOf(context, workerKey),
              amountSatang: Math.floor(target.plan.template.fundingBaht * 50),
            }
          : {}),
      });
    }
    const [saved] = await db
      .select({ status: adminDisputeCase.status })
      .from(adminDisputeCase)
      .where(eq(adminDisputeCase.id, disputeCase.id))
      .limit(1);
    statuses.push(saved?.status ?? 'UNKNOWN');
  }
  summarize('Dispute Cases', statuses);
};

const seedConductReports = async (context: Context, seeded: SeededQuest[]) => {
  const statuses: string[] = [];
  // Eligibility rules: a Hirer reports a Worker who delivered nothing by dueAt as abandoned;
  // a Worker reports the Hirer for out-of-scope requests.
  const targets = [
    ...seeded
      .filter(({ plan }) => plan.flow === 'FAILED_DUE')
      .map((target) => ({
        target,
        filer: 'hirer' as const,
        reason: conductReportReason.abandoned,
        detail: 'The Worker joined but never started work and did not reply in chat.',
      })),
    ...seeded
      .filter(({ plan }) => plan.flow === 'FAILED_NOT_APPROVED')
      .slice(3, 4)
      .map((target) => ({
        target,
        filer: 'worker' as const,
        reason: conductReportReason.outOfScope,
        detail: 'The Hirer rejected my proof for items that were never in the Quest Condition.',
      })),
    ...seeded
      .filter(({ plan }) => plan.flow === 'COMPLETED')
      .slice(0, 1)
      .map((target) => ({
        target,
        filer: 'worker' as const,
        reason: conductReportReason.outOfScope,
        detail: 'The Hirer asked for three extra designs that were not in the Quest Condition.',
      })),
  ];
  const outcomes = [
    conductReportStatus.pending,
    conductReportStatus.upheld,
    conductReportStatus.pending,
    conductReportStatus.dismissed,
  ];
  for (const [index, { target, filer, reason, detail }] of targets.entries()) {
    const workerKey = target.plan.workers[0]!;
    const filerId = idOf(context, filer === 'hirer' ? target.plan.hirer : workerKey);
    const reportedId = idOf(context, filer === 'hirer' ? workerKey : target.plan.hirer);
    const created = await createQuestV2ConductReport(
      filerId,
      target.questId,
      { reportedMemberId: reportedId, reason, detail },
      `${prefix}:conduct:${target.plan.key}`
    );
    failIfOutcome(`Conduct Report ${target.plan.key}`, created);
    const [report] = await db
      .select({
        id: adminConductReport.id,
        status: adminConductReport.status,
        version: adminConductReport.version,
      })
      .from(adminConductReport)
      .where(
        and(
          eq(adminConductReport.questId, target.questId),
          eq(adminConductReport.reportedMemberId, reportedId)
        )
      )
      .limit(1);
    if (!report) throw new Error('Conduct Report was not stored.');
    const desired = outcomes[index % outcomes.length]!;
    if (report.status === conductReportStatus.pending && desired !== conductReportStatus.pending) {
      await decideAdminReport({
        adminId: context.adminId,
        reportId: report.id,
        expectedVersion: report.version,
        requestKey: `${prefix}:conduct-decision:${target.plan.key}`,
        ...(desired === conductReportStatus.upheld
          ? {
              outcome: desired,
              decisionReasonCode: 'CONDUCT_REPORT_QUEST_RECORD_CONFIRMS_VIOLATION' as const,
            }
          : {
              outcome: conductReportStatus.dismissed,
              decisionReasonCode: 'CONDUCT_REPORT_INSUFFICIENT_EVIDENCE' as const,
            }),
      });
    }
    const [saved] = await db
      .select({ status: adminConductReport.status })
      .from(adminConductReport)
      .where(eq(adminConductReport.id, report.id))
      .limit(1);
    statuses.push(saved?.status ?? 'UNKNOWN');
  }
  summarize('Conduct Reports', statuses);
};

// ---------------------------------------------------------------- money out

const earningsOf = async (memberId: string) => (await ensureWallet(memberId)).earningsBalanceSatang;

const seedEarningsAndPayouts = async (context: Context) => {
  // Fixed Members keep each command on the same idempotency key when the seed runs again.
  const earnersFor = async (keys: readonly string[]) =>
    Promise.all(
      keys.map(async (key) => {
        const id = idOf(context, key);
        return { key, id, earnings: await earningsOf(id) };
      })
    );
  const converters = await earnersFor(['m04', 'm05', 'm13']);
  const payees = await earnersFor(['m01', 'm07', 'm09', 'm22', 'm26', 'm28']);

  const conversions: string[] = [];
  for (const earner of converters) {
    // The amount depends on current Earnings, so a re-run skips a Member who already converted.
    const [done] = await db
      .select({ amountSatang: walletEarningsConversion.amountSatang })
      .from(walletEarningsConversion)
      .where(eq(walletEarningsConversion.principalUserId, earner.id))
      .limit(1);
    if (done) {
      conversions.push(`${earner.key}=${done.amountSatang / 100}`);
      continue;
    }
    const amount = Math.floor((earner.earnings * 0.4) / 5_000) * 5_000;
    if (amount < 5_000) continue;
    const converted = await convertEarnings({
      principalUserId: earner.id,
      amountSatang: positiveSatang(amount),
      idempotency: { key: `${prefix}:convert:${earner.key}` },
    });
    conversions.push(`${earner.key}=${converted.amountSatang / 100}`);
  }
  console.log(`Earnings Conversions: ${conversions.join(', ') || 'none'}`);

  const encryption = createPayoutDestinationEncryption();
  const banks = ['KBANK', 'SCB', 'BBL', 'KTB', 'BAY'] as const;
  const statuses: string[] = [];
  for (const [index, earner] of payees.entries()) {
    const key = `${prefix}:payout:${earner.key}`;
    let payoutId = await idempotentResourceId(earner.id, payoutOperationScope, key);
    if (!payoutId) {
      const member = context.members.get(earner.key)!;
      if (!(await getPayoutDestination(earner.id))) {
        await savePayoutDestination(
          {
            principalUserId: earner.id,
            givenName: member.firstName,
            surname: member.lastName,
            relationship: 'SELF',
            bankCode: banks[index % banks.length]!,
            accountNumber: `${1_230_000_000 + index * 104_729}`,
            accountHolderName: `${member.firstName} ${member.lastName}`,
            routingType: 'BANK_ACCOUNT',
            routingValue: `${prefix}-${earner.key}`,
          },
          encryption
        );
      }
      const receipt = Math.floor((earner.earnings * 0.7) / 10_000) * 10_000;
      if (receipt < 10_000) continue;
      const quote = await quotePayout({
        principalUserId: earner.id,
        receiptSatang: positiveSatang(receipt),
      });
      const payout = await initiatePayout({
        principalUserId: earner.id,
        quoteId: quote.id,
        idempotency: { key },
      });
      payoutId = payout.id;
    }
    const [payout] = await db
      .select({ status: paymentPayouts.payoutStatus, version: paymentPayouts.version })
      .from(paymentPayouts)
      .where(eq(paymentPayouts.id, payoutId))
      .limit(1);
    if (index === 5 && payout?.status === 'PENDING_ADMIN_APPROVAL') {
      await cancelPayout({
        adminId: context.adminId,
        payoutId,
        expectedVersion: payout.version,
        idempotencyKey: `${prefix}:payout-cancel:${earner.key}`,
        reasonCode: 'PAYOUT_RISK_REVIEW_FAILED',
      });
      statuses.push('CANCELLED');
    } else {
      statuses.push(payout?.status ?? 'UNKNOWN');
    }
  }
  summarize('Payouts', statuses);
};

const seedWalletFreeze = async (context: Context) => {
  const wallet = await ensureWallet(idOf(context, 'm32'));
  if (wallet.walletStatus !== walletStatus.active) return;
  await changeWalletStatusAdmin({
    adminId: context.adminId,
    walletId: wallet.id,
    toStatus: walletStatus.frozen,
    reason: 'Several unpaid Top-up requests in a short time; held for identity check.',
    requestKey: `${prefix}:wallet-freeze:m32`,
  });
  console.log('Wallet status: m32 FROZEN');
};

// ---------------------------------------------------------------- main

const summarize = (label: string, statuses: string[]) => {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  console.log(
    `${label}: ${[...counts].map(([status, count]) => `${status}=${count}`).join(', ') || 'none'}`
  );
};

const loadAdminId = async () => {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const [admin] = await db
    .select({ id: authAdmin.id })
    .from(authAdmin)
    .where(email ? eq(authAdmin.email, email) : isNull(authAdmin.disabledAt))
    .orderBy(asc(authAdmin.createdAt))
    .limit(1);
  if (!admin) throw new Error('Seed an Admin before the UAT scenario.');
  return admin.id;
};

const main = async () => {
  assertUatScenarioEnvironment();
  await ensureInitialMoneyPolicy();
  await seedAcademicOptions();
  await seedQuestTags();
  const plans = createUatScenarioPlan();
  const members = await seedMembers();
  const tags = new Map(
    (await db.select({ id: tag.id, name: tag.name }).from(tag)).map((row) => [row.name, row.id])
  );
  const context: Context = { members, tags, adminId: await loadAdminId() };

  await runTopUps(planTopUps(plans, members));

  const seeded: SeededQuest[] = [];
  // Finished work first: those Assignments end, so the same Workers can take more work.
  const order: Flow[] = [
    'COMPLETED',
    'COMPLETED_GROUP',
    'COMPLETED_CANDIDATE',
    'COMPLETED_NO_PROOF',
    'FAILED_NOT_APPROVED',
    'FAILED_DUE',
    'CANCELLED',
    'PROOF_PENDING',
    'IN_PROGRESS',
    'ASSIGNED',
    'OPEN_CANDIDATES',
    'OPEN',
    'DRAFT',
  ];
  let seed = 0;
  for (const flow of order) {
    for (const plan of plans.filter((candidate) => candidate.flow === flow)) {
      const result = await runQuest(context, plan, seed++);
      seeded.push(result);
      console.log(`Quest ${plan.key}: ${result.status}${result.skipped ? ' (existing)' : ''}`);
    }
  }
  summarize(
    'Quests',
    seeded.map(({ status }) => status)
  );

  const fresh = seeded.filter(({ skipped }) => !skipped);
  await seedReportCases(context, fresh);
  await seedDisputes(context, fresh);
  await seedConductReports(context, fresh);
  await seedEarningsAndPayouts(context);
  await seedWalletFreeze(context);

  const [assignments] = await db.select({ id: questAssignment.id }).from(questAssignment).limit(1);
  if (!assignments) throw new Error('No Assignment exists after the scenario.');
  console.log('UAT scenario seed complete.');
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
