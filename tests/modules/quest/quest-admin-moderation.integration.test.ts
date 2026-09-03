import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questAssignment,
  questConditionItem,
  questTeam,
  questTeamInvitation,
  questTeamMember,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  chatConversation,
  chatMembership,
  chatMessage,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import {
  walletFundingReservation,
  walletLedgerAccount,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { auth } from '@/modules/auth';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { editQuestV2 } from '@/modules/quest';
import { configureQuestWorkChatMembershipWriter } from '@/modules/quest/quest-assignment.service';
import type { QuestStatus } from '@/modules/quest/quest.contract';
import { workChatMembershipWriter } from '@/modules/work-chat';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  reserveSpending,
  signedSatang,
} from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

let postgresAvailable = false;
let adminCookie = '';
let adminId = '';
const tagId = randomUUID();
const hirerId = randomUUID();
const workerId = randomUUID();
const teamLeaderId = randomUUID();
const questIds: string[] = [];
const adminEmail = `${randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const adminRequest = (
  path: string,
  body: unknown,
  headers: HeadersInit = {},
) => app.handle(new Request(`http://localhost${path}`, {
  method: 'POST',
  headers: {
    ...headers,
    cookie: adminCookie,
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
}));

const asMember = (memberId: string = workerId) => spyOn(auth.api, 'getSession').mockImplementation((async () => ({
  user: { id: memberId },
  session: { userId: memberId },
})) as never);

const workerRequest = (path: string, headers: HeadersInit = {}, body?: unknown) => app.handle(
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
);

const memberGet = (path: string) => app.handle(
  new Request(`http://localhost${path}`, { method: 'GET' }),
);

const hideQuest = (questId: string, version: number) => adminRequest(
  `/api/v1/admin/quests/${questId}/hide`,
  { reasonCode: 'POLICY_REVIEW' },
  { 'idempotency-key': `admin-hide-${questId}`, 'if-match': String(version) },
);

// Hides the Quest and proves the overlay is the only thing that changed: the Quest
// stays QUEST_OPEN, so a refusal below can only come from `hiddenAt`.
const hideOpenQuest = async (questId: string) => {
  expect((await hideQuest(questId, 1)).status).toBe(200);
  const [row] = await db.select({ hiddenAt: quest.hiddenAt, questStatus: quest.questStatus })
    .from(quest).where(eq(quest.id, questId));
  expect(row).toMatchObject({ hiddenAt: expect.any(Date), questStatus: 'QUEST_OPEN' });
};

const walletAccount = async (userId: string, type: 'SPENDING' | 'FUNDING_RESERVED') => {
  const [wallet] = await db.select({ id: walletWallet.id })
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));
  if (!wallet) throw new Error(`Wallet for ${userId} was not found`);
  const [account] = await db.select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, type)));
  if (!account) throw new Error(`Wallet ${type} account was not found`);
  return account.id;
};

const fundWallet = async (userId: string, amountSatang: number) => {
  const spendingAccountId = await walletAccount(userId, 'SPENDING');
  const [suspenseAccount] = await db.select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  if (!suspenseAccount) throw new Error('Platform suspense account was not found');
  await createSealedLedgerTransaction({
    businessReference: `admin-quest-test-top-up:${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spendingAccountId, amountSatang: signedSatang(amountSatang) },
      { accountId: suspenseAccount.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const createQuest = async (
  status: QuestStatus,
  startTime = new Date('2035-01-01T00:00:00.000Z'),
  options: { group?: boolean } = {},
) => {
  const questId = randomUUID();
  const group = options.group ?? false;
  questIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId,
    apiVersion: 'v2',
    title: `Admin moderation ${questId}`,
    condition: 'Complete the work',
    mode: group ? 'CANDIDATE' : 'NO_CANDIDATE',
    participation: group ? 'GROUP' : 'SOLO',
    v2Mode: group ? 'CANDIDATE' : 'FIRST_COME_FIRST_SERVED',
    v2Participation: group ? 'GROUP' : 'SINGLE',
    rewardSatang: status === 'QUEST_DRAFT' ? null : 1_000,
    questStatus: status,
    questFundingTotalSatang: group ? 2_040 : 1_020,
    platformFeePerWorkerSatang: 20,
    questEscrowSatang: group ? 2_040 : 1_020,
    tagId,
    headcount: group ? 2 : 1,
    startTime,
    dueAt: new Date('2035-01-01T02:00:00.000Z'),
    // `quest_cancelled_at_check` ties the timestamp to the status.
    cancelledAt: status === 'QUEST_CANCELLED' ? new Date('2035-01-01T01:00:00.000Z') : null,
    cancelledByUserId: status === 'QUEST_CANCELLED' ? hirerId : null,
  });
  return questId;
};

const createV2CandidateSingleQuest = async () => {
  const questId = randomUUID();
  questIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId,
    apiVersion: 'v2',
    title: `Admin moderation v2 candidate ${questId}`,
    condition: 'Complete the work',
    mode: 'CANDIDATE',
    participation: 'SOLO',
    v2Mode: 'CANDIDATE',
    v2Participation: 'SINGLE',
    rewardSatang: 1_000,
    questStatus: 'QUEST_OPEN',
    questFundingTotalSatang: 1_020,
    platformFeePerWorkerSatang: 20,
    questEscrowSatang: 1_020,
    tagId,
    headcount: 1,
    startTime: new Date('2035-01-01T00:00:00.000Z'),
    dueAt: new Date('2035-01-01T02:00:00.000Z'),
  });
  return questId;
};

const createV1CandidateQuest = async (participation: 'SOLO' | 'GROUP' = 'SOLO') => {
  const questId = randomUUID();
  questIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId,
    apiVersion: 'v1',
    title: `Admin moderation v1 ${questId}`,
    condition: 'Complete the work',
    mode: 'CANDIDATE',
    participation,
    rewardSatang: 1_000,
    questStatus: 'QUEST_OPEN',
    tagId,
    headcount: participation === 'GROUP' ? 2 : 1,
    startTime: new Date('2035-01-01T00:00:00.000Z'),
    dueAt: new Date('2035-01-01T02:00:00.000Z'),
  });
  return questId;
};

const createInProgressQuestWithChat = async () => {
  const questId = await createQuest('QUEST_IN_PROGRESS');
  const assignmentId = randomUUID();
  const joinedAt = new Date('2020-12-31T23:00:00.000Z');
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId,
    workerId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: joinedAt,
  });
  await db.transaction((transaction) => workChatMembershipWriter.applyQuestTransition(transaction, {
    producer: 'QUEST_DIRECT_JOIN',
    type: 'workersAccepted',
    commandId: `admin-quest-seed:${questId}`,
    eventId: `admin-quest-seed:${questId}`,
    questId,
    actorId: workerId,
    hirerId,
    occurredAt: joinedAt.toISOString(),
    workers: [{ workerId, assignmentId, joinedAt: joinedAt.toISOString() }],
  }));
  await db.transaction((transaction) => reserveSpending(transaction, {
    ownerUserId: hirerId,
    callerScope: 'quest',
    callerReference: questId,
    amountSatang: positiveSatang(1_020),
  }));
  return { questId, assignmentId };
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }

  await ensureInitialMoneyPolicy();
  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Admin', lastName: 'Hirer' },
    { id: workerId, email: `${workerId}@ku.th`, firstName: 'Admin', lastName: 'Worker' },
    { id: teamLeaderId, email: `${teamLeaderId}@ku.th`, firstName: 'Admin', lastName: 'Leader' },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Admin moderation ${tagId}` });
  const seedAuth = createAdminAuth({ allowSignUp: true, autoSignIn: false, markEmailVerified: true });
  await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Quest Admin',
      firstName: 'Quest',
      lastName: 'Moderator',
    },
  });
  const loginResponse = await app.handle(new Request('http://localhost/api/admin/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  }));
  if (loginResponse.status !== 200) throw new Error('Admin test session could not be created.');
  adminCookie = getCookieHeader(loginResponse);
  const [admin] = await db.select({ id: authAdmin.id }).from(authAdmin).where(eq(authAdmin.email, adminEmail));
  adminId = admin!.id;

  await ensureWallet(hirerId);
  await ensureWallet(workerId);
  await ensureWallet(teamLeaderId);
  await fundWallet(hirerId, 100_000);
});

beforeEach(() => {
  configureQuestWorkChatMembershipWriter(workChatMembershipWriter);
});

afterAll(async () => {
  if (!postgresAvailable) return;
  for (const questId of questIds) {
    await db.delete(chatTransitionCommand).where(eq(chatTransitionCommand.questId, questId));
    const conversations = await db.select({ id: chatConversation.id })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    for (const conversation of conversations) {
      await db.delete(chatMessage).where(eq(chatMessage.conversationId, conversation.id));
      await db.delete(chatMembership).where(eq(chatMembership.conversationId, conversation.id));
      await db.delete(chatConversation).where(eq(chatConversation.id, conversation.id));
    }
    await db.delete(questAssignment).where(eq(questAssignment.questId, questId));
    await db.delete(quest).where(eq(quest.id, questId));
  }
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Admin Quest moderation commands', () => {
  it('publishes Admin command paths with Admin security', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };
    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/admin/quests/{questId}/hide']?.post?.operationId).toBe('hideAdminQuest');
    expect(document.paths['/api/v1/admin/quests/{questId}/restore']?.post?.operationId).toBe('restoreAdminQuest');
    expect(document.paths['/api/v1/admin/quests/{questId}/terminate']?.post?.operationId).toBe('terminateAdminQuest');
    expect(document.paths['/api/v1/admin/quests/{questId}/hide']?.post?.security).toEqual([{ betterAuthSession: [] }]);
  });
  it('hides an active Quest without changing lifecycle, Assignment, Wallet, or Work Conversation', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN');

    const response = await adminRequest(
      `/api/v1/admin/quests/${questId}/hide`,
      { reasonCode: 'POLICY_REVIEW' },
      { 'idempotency-key': `admin-hide-${questId}`, 'if-match': '1' },
    );
    const body = await response.json() as {
      success: boolean;
      data: {
        resourceSummary: Record<string, unknown>;
        resourceVersion: number;
        adminActionId: string;
      };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        resourceSummary: {
          id: questId,
          questStatus: 'QUEST_OPEN',
          version: 2,
          hiddenAt: expect.any(String),
        },
        resourceVersion: 2,
        adminActionId: expect.any(String),
      },
    });
    expect(await db.select({ status: quest.questStatus, version: quest.version })
      .from(quest).where(eq(quest.id, questId))).toEqual([{ status: 'QUEST_OPEN', version: 2 }]);
    expect(await db.select({ action: adminAction.action, resourceType: adminAction.resourceType }).from(adminAction)
      .where(and(eq(adminAction.adminId, adminId), eq(adminAction.resourceId, questId)))).toEqual([{ action: 'QUEST_HIDE', resourceType: 'quest' }]);
  });

  it('hides ASSIGNED and IN_PROGRESS Quests without changing lifecycle state', async () => {
    if (!postgresAvailable) return;
    const [assignedQuestId, inProgressQuestId] = await Promise.all([
      createQuest('QUEST_ASSIGNED'),
      createQuest('QUEST_IN_PROGRESS'),
    ]);
    const responses = await Promise.all([
      adminRequest(`/api/v1/admin/quests/${assignedQuestId}/hide`, { reasonCode: 'POLICY_REVIEW' }, {
        'idempotency-key': `admin-hide-assigned-${assignedQuestId}`,
        'if-match': '1',
      }),
      adminRequest(`/api/v1/admin/quests/${inProgressQuestId}/hide`, { reasonCode: 'POLICY_REVIEW' }, {
        'idempotency-key': `admin-hide-in-progress-${inProgressQuestId}`,
        'if-match': '1',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await db.select({ status: quest.questStatus, version: quest.version })
      .from(quest).where(eq(quest.id, assignedQuestId))).toEqual([{ status: 'QUEST_ASSIGNED', version: 2 }]);
    expect(await db.select({ status: quest.questStatus, version: quest.version })
      .from(quest).where(eq(quest.id, inProgressQuestId))).toEqual([{ status: 'QUEST_IN_PROGRESS', version: 2 }]);
  });

  it('hides every remaining non-terminal Quest state without changing lifecycle state', async () => {
    if (!postgresAvailable) return;
    const states = [
      'QUEST_DRAFT',
      'QUEST_AWAITING_CONSENT',
      'QUEST_SUBMITTED',
      'QUEST_APPROVED',
      'QUEST_REWORK',
      'QUEST_DISPUTED',
    ] as const;
    const questIdsByState = await Promise.all(states.map((state) => createQuest(state)));

    const responses = await Promise.all(questIdsByState.map((questId) => hideQuest(questId, 1)));

    expect(responses.map((response) => response.status)).toEqual(states.map(() => 200));
    const rows = await Promise.all(questIdsByState.map(async (questId) => {
      const [row] = await db.select({ status: quest.questStatus, hiddenAt: quest.hiddenAt, version: quest.version })
        .from(quest).where(eq(quest.id, questId));
      return row;
    }));
    expect(rows).toEqual(states.map((state) => ({
      status: state,
      hiddenAt: expect.any(Date),
      version: 2,
    })));
  });

  it('refuses to hide a terminal Quest', async () => {
    if (!postgresAvailable) return;
    const states = ['QUEST_COMPLETED', 'QUEST_CANCELLED', 'QUEST_FAILED'] as const;
    const questIdsByState = await Promise.all(states.map((state) => createQuest(state)));

    const responses = await Promise.all(questIdsByState.map((questId) => hideQuest(questId, 1)));

    expect(responses.map((response) => response.status)).toEqual(states.map(() => 409));
    expect(await Promise.all(responses.map(async (response) => (await response.json()).error.code)))
      .toEqual(states.map(() => 'QUEST_ACTION_NOT_ALLOWED'));
    const rows = await Promise.all(questIdsByState.map(async (questId) => {
      const [row] = await db.select({ hiddenAt: quest.hiddenAt, version: quest.version })
        .from(quest).where(eq(quest.id, questId));
      return row;
    }));
    expect(rows).toEqual(states.map(() => ({ hiddenAt: null, version: 1 })));
  });

  // The cancellation matrix pays the whole 20% to the Team Leader in a GROUP + CANDIDATE
  // Quest, not a share per Active Worker.
  it('pays the whole ASSIGNED cancellation share to the Team Leader of a GROUP Candidate Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_ASSIGNED', undefined, { group: true });
    const joinedAt = new Date('2020-12-31T23:00:00.000Z');
    const roster = [
      { assignmentId: randomUUID(), workerId: teamLeaderId, joinedAt: joinedAt.toISOString() },
      { assignmentId: randomUUID(), workerId, joinedAt: joinedAt.toISOString() },
    ] as const;
    await db.insert(questAssignment).values(roster.map(({ assignmentId, workerId: memberId }) => ({
      id: assignmentId,
      questId,
      workerId: memberId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE' as const,
      createdAt: joinedAt,
    })));
    await db.transaction((transaction) => workChatMembershipWriter.applyQuestTransition(transaction, {
      producer: 'QUEST_DIRECT_JOIN',
      type: 'workersAccepted',
      commandId: `admin-group-leader-seed:${questId}`,
      eventId: `admin-group-leader-seed:${questId}`,
      questId,
      actorId: teamLeaderId,
      hirerId,
      occurredAt: joinedAt.toISOString(),
      workers: [roster[0], roster[1]],
    }));
    await db.insert(questTeam).values({
      id: randomUUID(),
      questId,
      leaderId: teamLeaderId,
      name: 'Terminated Quest Team',
      teamStatus: 'TEAM_SELECTED',
    });
    await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(2_040),
    }));
    const before = await Promise.all([teamLeaderId, workerId].map(async (userId) => {
      const [row] = await db.select({ earnings: walletWallet.earningsBalanceSatang })
        .from(walletWallet).where(eq(walletWallet.userId, userId));
      return row!.earnings;
    }));

    const response = await adminRequest(
      `/api/v1/admin/quests/${questId}/terminate`,
      { reasonCode: 'POLICY_REVIEW' },
      { 'idempotency-key': `admin-terminate-group-leader-${questId}`, 'if-match': '1' },
    );

    expect(response.status).toBe(200);
    const after = await Promise.all([teamLeaderId, workerId].map(async (userId) => {
      const [row] = await db.select({ earnings: walletWallet.earningsBalanceSatang })
        .from(walletWallet).where(eq(walletWallet.userId, userId));
      return row!.earnings;
    }));
    // 20% of the 2,000 satang Worker Reward pool, paid to the Leader alone.
    expect(after).toEqual([before[0]! + 400, before[1]!]);
    expect(await db.select({
      status: walletFundingReservation.status,
      remainingSatang: walletFundingReservation.remainingSatang,
    }).from(walletFundingReservation).where(and(
      eq(walletFundingReservation.ownerUserId, hirerId),
      eq(walletFundingReservation.callerReference, questId),
    ))).toEqual([{ status: 'RELEASED', remainingSatang: 0 }]);
  });

  it('terminates an OPEN GROUP Candidate Quest and releases its full reservation', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN', undefined, { group: true });
    await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(2_040),
    }));

    const response = await adminRequest(
      `/api/v1/admin/quests/${questId}/terminate`,
      { reasonCode: 'POLICY_REVIEW' },
      { 'idempotency-key': `admin-terminate-open-group-${questId}`, 'if-match': '1' },
    );
    const body = await response.json() as { data: { resourceSummary: Record<string, unknown> } };

    expect(response.status).toBe(200);
    expect(body.data.resourceSummary).toMatchObject({
      questStatus: 'QUEST_CANCELLED',
      version: 2,
    });
    expect(await db.select({
      status: walletFundingReservation.status,
      remainingSatang: walletFundingReservation.remainingSatang,
    }).from(walletFundingReservation).where(and(
      eq(walletFundingReservation.ownerUserId, hirerId),
      eq(walletFundingReservation.callerReference, questId),
    ))).toEqual([{ status: 'RELEASED', remainingSatang: 0 }]);
  });


  it('replays a Hide command and rejects stale or reused keys without another effect', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN');
    const key = `admin-hide-replay-${questId}`;
    const headers = { 'idempotency-key': key, 'if-match': '1' };
    const [first, replay] = await Promise.all([
      adminRequest(`/api/v1/admin/quests/${questId}/hide`, { reasonCode: 'POLICY_REVIEW' }, headers),
      adminRequest(`/api/v1/admin/quests/${questId}/hide`, { reasonCode: 'POLICY_REVIEW' }, headers),
    ]);
    const reused = await adminRequest(`/api/v1/admin/quests/${questId}/hide`, { reasonCode: 'SAFETY_REVIEW' }, headers);
    const stale = await adminRequest(`/api/v1/admin/quests/${questId}/hide`, { reasonCode: 'POLICY_REVIEW' }, {
      'idempotency-key': `${key}-stale`,
      'if-match': '1',
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.clone().json());
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe('ADMIN_ACTION_KEY_REUSED');
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('ADMIN_ACTION_CONFLICT');
    expect(await db.select({ id: adminAction.id }).from(adminAction)
      .where(and(eq(adminAction.adminId, adminId), eq(adminAction.resourceId, questId)))).toHaveLength(1);
  });

  it('rejects an Admin command based on a revision before a Quest edit', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_DRAFT');
    await db.insert(questConditionItem).values({
      questId,
      position: 0,
      text: 'Edited Quest condition',
    });
    const edited = await editQuestV2(
      hirerId,
      questId,
      { title: 'Edited before moderation' },
      1,
      `member-edit-${questId}`,
    );
    expect('quest' in edited).toBe(true);

    const stale = await adminRequest(
      `/api/v1/admin/quests/${questId}/hide`,
      { reasonCode: 'POLICY_REVIEW' },
      { 'idempotency-key': `admin-hide-stale-edit-${questId}`, 'if-match': '1' },
    );

    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('ADMIN_ACTION_CONFLICT');
    expect(await db.select({
      title: quest.title,
      version: quest.version,
      hiddenAt: quest.hiddenAt,
    }).from(quest).where(eq(quest.id, questId))).toEqual([{
      title: 'Edited before moderation',
      version: 2,
      hiddenAt: null,
    }]);
  });

  it('restores an eligible hidden Quest without requiring free-form reason text', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN');
    await db.update(quest).set({ hiddenAt: new Date(), hiddenByAdminId: adminId }).where(eq(quest.id, questId));

    const response = await adminRequest(
      `/api/v1/admin/quests/${questId}/restore`,
      {},
      { 'idempotency-key': `admin-restore-${questId}`, 'if-match': '1' },
    );
    const body = await response.json() as { data: { resourceSummary: Record<string, unknown>; resourceVersion: number } };

    expect(response.status).toBe(200);
    expect(body.data.resourceSummary).toMatchObject({
      id: questId,
      questStatus: 'QUEST_OPEN',
      version: 2,
      hiddenAt: null,
    });
    expect(body.data.resourceVersion).toBe(2);
  });

  it('keeps an ineligible hidden Quest hidden after its start time', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN', new Date('2020-01-01T00:00:00.000Z'));
    await db.update(quest).set({ hiddenAt: new Date(), hiddenByAdminId: adminId }).where(eq(quest.id, questId));

    const response = await adminRequest(
      `/api/v1/admin/quests/${questId}/restore`,
      {},
      { 'idempotency-key': `admin-restore-ineligible-${questId}`, 'if-match': '1' },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('QUEST_RESTORE_NOT_ELIGIBLE');
    expect(await db.select({ hiddenAt: quest.hiddenAt, version: quest.version })
      .from(quest).where(eq(quest.id, questId))).toEqual([{ hiddenAt: expect.any(Date), version: 1 }]);
  });

  // The Hirer manages a hidden Quest normally, so Candidate selection can move it past
  // QUEST_OPEN while the overlay is on. Restore has to stay reachable, or the Quest is
  // hidden for the rest of its life.
  it('restores a hidden Quest that moved past QUEST_OPEN while hidden', async () => {
    if (!postgresAvailable) return;
    const states = ['QUEST_DRAFT', 'QUEST_ASSIGNED', 'QUEST_IN_PROGRESS', 'QUEST_DISPUTED'] as const;
    const questIdsByState = await Promise.all(states.map((state) => createQuest(state)));
    await Promise.all(questIdsByState.map((questId) => db.update(quest)
      .set({ hiddenAt: new Date(), hiddenByAdminId: adminId })
      .where(eq(quest.id, questId))));

    const responses = await Promise.all(questIdsByState.map((questId) => adminRequest(
      `/api/v1/admin/quests/${questId}/restore`,
      {},
      { 'idempotency-key': `admin-restore-past-open-${questId}`, 'if-match': '1' },
    )));

    expect(responses.map((response) => response.status)).toEqual(states.map(() => 200));
    const rows = await Promise.all(questIdsByState.map(async (questId) => {
      const [row] = await db.select({
        status: quest.questStatus,
        hiddenAt: quest.hiddenAt,
        hiddenByAdminId: quest.hiddenByAdminId,
        version: quest.version,
      }).from(quest).where(eq(quest.id, questId));
      return row;
    }));
    expect(rows).toEqual(states.map((state) => ({
      status: state,
      hiddenAt: null,
      hiddenByAdminId: null,
      version: 2,
    })));
  });

  it('refuses to restore a terminal hidden Quest', async () => {
    if (!postgresAvailable) return;
    const states = ['QUEST_COMPLETED', 'QUEST_CANCELLED', 'QUEST_FAILED'] as const;
    const questIdsByState = await Promise.all(states.map((state) => createQuest(state)));
    await Promise.all(questIdsByState.map((questId) => db.update(quest)
      .set({ hiddenAt: new Date(), hiddenByAdminId: adminId })
      .where(eq(quest.id, questId))));

    const responses = await Promise.all(questIdsByState.map((questId) => adminRequest(
      `/api/v1/admin/quests/${questId}/restore`,
      {},
      { 'idempotency-key': `admin-restore-terminal-${questId}`, 'if-match': '1' },
    )));

    expect(responses.map((response) => response.status)).toEqual(states.map(() => 409));
    expect(await Promise.all(responses.map(async (response) => (await response.json()).error.code)))
      .toEqual(states.map(() => 'QUEST_ACTION_NOT_ALLOWED'));
    const rows = await Promise.all(questIdsByState.map(async (questId) => {
      const [row] = await db.select({ hiddenAt: quest.hiddenAt, version: quest.version })
        .from(quest).where(eq(quest.id, questId));
      return row;
    }));
    expect(rows).toEqual(states.map(() => ({ hiddenAt: expect.any(Date), version: 1 })));
  });

  // The cancellation settlement matrix covers QUEST_OPEN, QUEST_ASSIGNED and
  // QUEST_IN_PROGRESS only, so Terminate refuses every other non-terminal state rather
  // than inventing a settlement for it.
  it('refuses to terminate a non-terminal Quest with no defined settlement', async () => {
    if (!postgresAvailable) return;
    const states = ['QUEST_AWAITING_CONSENT', 'QUEST_SUBMITTED', 'QUEST_APPROVED', 'QUEST_REWORK', 'QUEST_DISPUTED'] as const;
    const questIdsByState = await Promise.all(states.map((state) => createQuest(state)));
    await Promise.all(questIdsByState.map((questId) => db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(1_020),
    }))));

    const responses = await Promise.all(questIdsByState.map((questId) => adminRequest(
      `/api/v1/admin/quests/${questId}/terminate`,
      { reasonCode: 'POLICY_REVIEW' },
      { 'idempotency-key': `admin-terminate-undefined-${questId}`, 'if-match': '1' },
    )));

    expect(responses.map((response) => response.status)).toEqual(states.map(() => 409));
    expect(await Promise.all(responses.map(async (response) => (await response.json()).error.code)))
      .toEqual(states.map(() => 'QUEST_ACTION_NOT_ALLOWED'));
    const rows = await Promise.all(questIdsByState.map(async (questId) => {
      const [row] = await db.select({ status: quest.questStatus, version: quest.version })
        .from(quest).where(eq(quest.id, questId));
      return row;
    }));
    expect(rows).toEqual(states.map((state) => ({ status: state, version: 1 })));
    // The escrow is untouched, so a refused command moves no money.
    const reservations = await Promise.all(questIdsByState.map(async (questId) => {
      const [row] = await db.select({
        status: walletFundingReservation.status,
        remainingSatang: walletFundingReservation.remainingSatang,
      }).from(walletFundingReservation).where(and(
        eq(walletFundingReservation.ownerUserId, hirerId),
        eq(walletFundingReservation.callerReference, questId),
      ));
      return row;
    }));
    expect(reservations).toEqual(states.map(() => ({ status: 'ACTIVE', remainingSatang: 1_020 })));
  });

  it('keeps a hidden overlay when termination reaches a terminal state', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN');
    await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(1_020),
    }));
    await db.update(quest).set({ hiddenAt: new Date(), hiddenByAdminId: adminId }).where(eq(quest.id, questId));

    const hideAtTerminal = await adminRequest(
      `/api/v1/admin/quests/${questId}/terminate`,
      { reasonCode: 'POLICY_REVIEW' },
      { 'idempotency-key': `admin-terminate-hidden-${questId}`, 'if-match': '1' },
    );
    const body = await hideAtTerminal.json() as { data: { resourceSummary: Record<string, unknown> } };

    expect(hideAtTerminal.status).toBe(200);
    expect(body.data.resourceSummary).toMatchObject({
      id: questId,
      questStatus: 'QUEST_CANCELLED',
      version: 2,
      hiddenAt: expect.any(String),
    });
    expect(await db.select({ status: quest.questStatus, hiddenAt: quest.hiddenAt, hiddenByAdminId: quest.hiddenByAdminId })
      .from(quest).where(eq(quest.id, questId))).toEqual([{
        status: 'QUEST_CANCELLED',
        hiddenAt: expect.any(Date),
        hiddenByAdminId: adminId,
      }]);
  });

  it('terminates through Quest, Wallet, Assignment, Work Conversation, and Admin Action owners', async () => {
    if (!postgresAvailable) return;
    const { questId, assignmentId } = await createInProgressQuestWithChat();
    const [beforeWorker] = await db.select({ earnings: walletWallet.earningsBalanceSatang })
      .from(walletWallet).where(eq(walletWallet.userId, workerId));

    const response = await adminRequest(
      `/api/v1/admin/quests/${questId}/terminate`,
      { reasonCode: 'SAFETY_REVIEW' },
      { 'idempotency-key': `admin-terminate-${questId}`, 'if-match': '1' },
    );
    const body = await response.json() as {
      data: { resourceSummary: Record<string, unknown>; resourceVersion: number; adminActionId: string };
    };

    expect(response.status).toBe(200);
    expect(body.data.resourceSummary).toMatchObject({
      id: questId,
      questStatus: 'QUEST_CANCELLED',
      version: 2,
      hiddenAt: null,
    });
    expect(body.data.resourceVersion).toBe(2);
    expect(body.data.adminActionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.select({ status: questAssignment.assignmentStatus })
      .from(questAssignment).where(eq(questAssignment.id, assignmentId))).toEqual([{ status: 'ASSIGNMENT_CANCELLED' }]);
    expect((await db.select({ earnings: walletWallet.earningsBalanceSatang })
      .from(walletWallet).where(eq(walletWallet.userId, workerId)))[0]!.earnings).toBe(beforeWorker!.earnings + 1_000);
    expect(await db.select({ status: walletFundingReservation.status, remaining: walletFundingReservation.remainingSatang })
      .from(walletFundingReservation).where(eq(walletFundingReservation.callerReference, questId))).toEqual([{ status: 'SETTLED', remaining: 0 }]);
    expect(await db.select({ readOnlyAt: chatConversation.readOnlyAt, archivedAt: chatConversation.archivedAt })
      .from(chatConversation).where(eq(chatConversation.questId, questId))).toEqual([{ readOnlyAt: expect.any(Date), archivedAt: expect.any(Date) }]);
  });

  it('refuses a v1 direct join once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN');
    await hideOpenQuest(questId);

    const session = asMember();
    let response: Response;
    try {
      response = await workerRequest(`/api/v1/quests/${questId}/join`, {
        'idempotency-key': `join-hidden-${questId}`,
      });
    } finally {
      session.mockRestore();
    }

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 409,
      body: { success: false, error: { code: 'QUEST_NOT_OPEN' } },
    });
    expect(await db.select({ id: questAssignment.id })
      .from(questAssignment).where(eq(questAssignment.questId, questId))).toEqual([]);
  });

  it('refuses a v2 direct join once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN');
    await hideOpenQuest(questId);

    const session = asMember();
    let response: Response;
    try {
      response = await workerRequest(`/api/v2/quests/${questId}/join`, {
        'idempotency-key': `join-v2-hidden-${questId}`,
      });
    } finally {
      session.mockRestore();
    }

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 409,
      body: { success: false, error: { code: 'QUEST_NOT_OPEN' } },
    });
    expect(await db.select({ id: questAssignment.id })
      .from(questAssignment).where(eq(questAssignment.questId, questId))).toEqual([]);
  });

  it('refuses a Candidate application once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createV1CandidateQuest();
    await hideOpenQuest(questId);

    const session = asMember();
    let response: Response;
    try {
      response = await workerRequest(`/api/v1/quests/${questId}/applications`, {}, {});
    } finally {
      session.mockRestore();
    }

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 404,
      body: { success: false, error: { code: 'QUEST_NOT_FOUND' } },
    });
  });

  it('refuses a Candidate Team once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createV1CandidateQuest('GROUP');
    await hideOpenQuest(questId);

    const session = asMember();
    let response: Response;
    try {
      response = await workerRequest(`/api/v1/quests/${questId}/teams`, {}, { name: 'Hidden Quest Team' });
    } finally {
      session.mockRestore();
    }

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 404,
      body: { success: false, error: { code: 'QUEST_NOT_FOUND' } },
    });
  });

  it('refuses a Team invitation response once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createV1CandidateQuest('GROUP');
    const teamId = randomUUID();
    const invitationId = randomUUID();
    await db.insert(questTeam).values({ id: teamId, questId, leaderId: teamLeaderId, name: 'Hidden Quest Team' });
    await db.insert(questTeamMember).values({ teamId, userId: teamLeaderId });
    await db.insert(questTeamInvitation).values({
      id: invitationId,
      teamId,
      invitedUserId: workerId,
      invitedByUserId: teamLeaderId,
      expiresAt: new Date('2035-01-01T00:00:00.000Z'),
    });
    await hideOpenQuest(questId);

    const session = asMember();
    let response: Response;
    try {
      response = await workerRequest(`/api/v1/quests/invitations/${invitationId}/accept`);
    } finally {
      session.mockRestore();
    }

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 409,
      body: { success: false, error: { code: 'INVITATION_NOT_ALLOWED' } },
    });
    expect(await db.select({ userId: questTeamMember.userId })
      .from(questTeamMember).where(and(eq(questTeamMember.teamId, teamId), eq(questTeamMember.userId, workerId)))).toEqual([]);
  });

  it('refuses a v2 Candidate application once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createV2CandidateSingleQuest();
    await hideOpenQuest(questId);

    const session = asMember();
    let response: Response;
    try {
      response = await workerRequest(
        `/api/v2/quests/${questId}/applications`,
        { 'idempotency-key': `apply-v2-hidden-${questId}` },
        {},
      );
    } finally {
      session.mockRestore();
    }

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 409,
      body: { success: false, error: { code: 'QUEST_NOT_OPEN' } },
    });
  });

  it('still lets an invited Member decline once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createV1CandidateQuest('GROUP');
    const teamId = randomUUID();
    const invitationId = randomUUID();
    await db.insert(questTeam).values({ id: teamId, questId, leaderId: teamLeaderId, name: 'Hidden Quest Team' });
    await db.insert(questTeamMember).values({ teamId, userId: teamLeaderId });
    await db.insert(questTeamInvitation).values({
      id: invitationId,
      teamId,
      invitedUserId: workerId,
      invitedByUserId: teamLeaderId,
      expiresAt: new Date('2035-01-01T00:00:00.000Z'),
    });
    await hideOpenQuest(questId);

    const session = asMember();
    let response: Response;
    try {
      response = await workerRequest(`/api/v1/quests/invitations/${invitationId}/decline`);
    } finally {
      session.mockRestore();
    }

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 200,
      body: { success: true, data: { invitationStatus: 'INVITATION_DECLINED' } },
    });
  });

  it('refuses a new Team invitation once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createV1CandidateQuest('GROUP');
    const teamId = randomUUID();
    await db.insert(questTeam).values({ id: teamId, questId, leaderId: teamLeaderId, name: 'Hidden Quest Team' });
    await db.insert(questTeamMember).values({ teamId, userId: teamLeaderId });
    await hideOpenQuest(questId);

    const session = asMember(teamLeaderId);
    let response: Response;
    try {
      response = await workerRequest(
        `/api/v1/quests/${questId}/teams/${teamId}/invitations`,
        {},
        { invitedUserId: workerId },
      );
    } finally {
      session.mockRestore();
    }

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 404,
      body: { success: false, error: { code: 'INVITATION_NOT_FOUND' } },
    });
    expect(await db.select({ id: questTeamInvitation.id })
      .from(questTeamInvitation).where(eq(questTeamInvitation.teamId, teamId))).toEqual([]);
  });

  it('hides a pending invitation from Member reads once an Admin has hidden the Quest', async () => {
    if (!postgresAvailable) return;
    const questId = await createV1CandidateQuest('GROUP');
    const teamId = randomUUID();
    const invitationId = randomUUID();
    await db.insert(questTeam).values({ id: teamId, questId, leaderId: teamLeaderId, name: 'Hidden Quest Team' });
    await db.insert(questTeamMember).values({ teamId, userId: teamLeaderId });
    await db.insert(questTeamInvitation).values({
      id: invitationId,
      teamId,
      invitedUserId: workerId,
      invitedByUserId: teamLeaderId,
      expiresAt: new Date('2035-01-01T00:00:00.000Z'),
    });

    const before = asMember();
    let listedBefore: { data: { items: unknown[] } };
    try {
      listedBefore = await (await memberGet('/api/v1/quests/invitations')).json() as typeof listedBefore;
    } finally {
      before.mockRestore();
    }
    expect(listedBefore.data.items).toHaveLength(1);

    await hideOpenQuest(questId);

    const after = asMember();
    let listResponse: Response;
    let detailResponse: Response;
    try {
      listResponse = await memberGet('/api/v1/quests/invitations');
      detailResponse = await memberGet(`/api/v1/quests/invitations/${invitationId}`);
    } finally {
      after.mockRestore();
    }

    expect(await listResponse.json()).toMatchObject({ success: true, data: { items: [] } });
    expect(detailResponse.status).toBe(404);
  });

  it('rejects unsupported Admin approval operations and invalid reason codes', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_OPEN');
    const response = await adminRequest(
      `/api/v1/admin/quests/${questId}/approve`,
      { reasonCode: 'POLICY_REVIEW' },
      { 'idempotency-key': `admin-approve-${questId}`, 'if-match': '1' },
    );
    const invalidReason = await adminRequest(
      `/api/v1/admin/quests/${questId}/hide`,
      { reasonCode: 'NOT_ALLOWED' },
      { 'idempotency-key': `admin-invalid-reason-${questId}`, 'if-match': '1' },
    );

    expect(response.status).toBe(404);
    expect(invalidReason.status).toBe(400);
    expect((await invalidReason.json()).error.code).toBe('ADMIN_ACTION_INVALID_REASON_CODE');
  });
});
