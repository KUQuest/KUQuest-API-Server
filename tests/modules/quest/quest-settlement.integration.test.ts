import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { proofSubmission, quest, questAssignment, questSettlementCommand } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { auth, adminAuth } from '@/modules/auth';
import { configureQuestWorkChatMembershipWriter } from '@/modules/quest/quest-assignment.service';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  reserveSpending,
  signedSatang,
} from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';

let postgresAvailable = false;
const hirerId = randomUUID();
const workerIds = [randomUUID(), randomUUID(), randomUUID()];
const adminId = randomUUID();
const tagId = randomUUID();
const questIds: string[] = [];

const request = (method: string, path: string, userId: string, body?: unknown, headers: HeadersInit = {}) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...headers, 'x-user-id': userId, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

const account = async (userId: string, type: 'SPENDING' | 'FUNDING_RESERVED') => {
  const [wallet] = await db.select({ id: walletWallet.id }).from(walletWallet).where(eq(walletWallet.userId, userId));
  const [row] = await db.select({ id: walletLedgerAccount.id }).from(walletLedgerAccount).where(and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, type)));
  return row.id;
};

const fundWallet = async (userId: string, amountSatang: number) => {
  const spending = await account(userId, 'SPENDING');
  const [suspense] = await db.select({ id: walletLedgerAccount.id }).from(walletLedgerAccount).where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  await createSealedLedgerTransaction({
    businessReference: `be184-test-topup-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spending, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const createQuest = async (status: 'QUEST_OPEN' | 'QUEST_ASSIGNED' | 'QUEST_IN_PROGRESS' | 'QUEST_SUBMITTED' | 'QUEST_DISPUTED', workers: string[] = [], rewardSatang = 1_000) => {
  const questId = randomUUID();
  questIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Settlement test',
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: workers.length > 1 ? 'GROUP' : 'SOLO',
    questStatus: status,
    rewardSatang,
    headcount: workers.length || 1,
    tagId,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  if (workers.length > 0) await db.insert(questAssignment).values(workers.map((workerId) => ({ questId, workerId, assignmentStatus: 'ASSIGNMENT_ACTIVE', createdAt: new Date() })));
  await db.transaction((transaction) => reserveSpending(transaction, {
    ownerUserId: hirerId,
    callerScope: 'quest',
    callerReference: questId,
    amountSatang: positiveSatang((workers.length || 1) * (rewardSatang + Math.ceil(rewardSatang * 0.02))),
  }));
  return questId;
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
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Settlement', lastName: 'Hirer' },
    ...workerIds.map((id, index) => ({ id, email: `${id}@ku.th`, firstName: 'Settlement', lastName: `Worker ${index}` })),
  ]);
  await db.insert(authAdmin).values({ id: adminId, email: `${adminId}@admin.kuquest`, firstName: 'Settlement', lastName: 'Admin' });
  await db.insert(tag).values({ id: tagId, name: 'Settlement test' });
  await ensureWallet(hirerId);
  for (const workerId of workerIds) await ensureWallet(workerId);
  await fundWallet(hirerId, 100_000);
});

afterEach(() => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
});

afterAll(async () => {
  if (postgresAvailable && questIds.length > 0) await db.delete(quest).where(inArray(quest.id, questIds));
});

describe('Quest terminal settlement HTTP contract', () => {
  it('cancels OPEN, ASSIGNED, and IN_PROGRESS with exact integer-Satang outcomes', async () => {
    if (!postgresAvailable) return;
    const authenticate = spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => ({ user: { id: headers.get('x-user-id') ?? hirerId }, session: { userId: headers.get('x-user-id') ?? hirerId } }) as never) as never);
    for (const [status, workers, expectedPaid, expectedRefund] of [
      ['QUEST_OPEN', [], 0, 1_020],
      ['QUEST_ASSIGNED', [workerIds[0]], 200, 820],
      ['QUEST_IN_PROGRESS', [workerIds[1]], 1_000, 0],
    ] as const) {
      const questId = await createQuest(status, [...workers]);
      const response = await request('POST', `/api/v1/quests/${questId}/cancel`, hirerId, undefined, { 'idempotency-key': `cancel-${questId}` });
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({ questStatus: 'QUEST_CANCELLED', paidSatang: expectedPaid, refundedSatang: expectedRefund });
    }
    expect(authenticate).toHaveBeenCalled();
  });

  it('gives an ASSIGNED group remainder Satang to earliest Assignments', async () => {
    if (!postgresAvailable) return;
    spyOn(auth.api, 'getSession').mockImplementation((async () => ({ user: { id: hirerId }, session: { userId: hirerId } }) as never) as never);
    const questId = await createQuest('QUEST_ASSIGNED', workerIds, 1_002);
    const before = await Promise.all(workerIds.map(async (workerId) => (await db.select({ earnings: walletWallet.earningsBalanceSatang }).from(walletWallet).where(eq(walletWallet.userId, workerId)))[0]?.earnings ?? 0));
    const response = await request('POST', `/api/v1/quests/${questId}/cancel`, hirerId, undefined, { 'idempotency-key': 'be184-remainder' });
    expect(response.status).toBe(200);
    const after = await Promise.all(workerIds.map(async (workerId) => (await db.select({ earnings: walletWallet.earningsBalanceSatang }).from(walletWallet).where(eq(walletWallet.userId, workerId)))[0]?.earnings ?? 0));
    expect(after.map((value, index) => value - before[index])).toEqual([201, 200, 200]);
  });

  it('settles approved Proof Submission obligations and completes active Assignments', async () => {
    if (!postgresAvailable) return;
    spyOn(auth.api, 'getSession').mockImplementation((async () => ({ user: { id: hirerId }, session: { userId: hirerId } }) as never) as never);
    const questId = await createQuest('QUEST_SUBMITTED', [workerIds[0]]);
    const proofId = randomUUID();
    await db.insert(proofSubmission).values({ id: proofId, questId, workerId: workerIds[0], submittedByUserId: workerIds[0], content: 'Done' });
    const response = await request('POST', `/api/v1/quests/${questId}/proof/${proofId}/review`, hirerId, { status: 'PROOF_APPROVED' });
    expect(response.status).toBe(200);
    expect((await response.json()).data.questStatus).toBe('QUEST_COMPLETED');
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_COMPLETED');
    expect((await db.select({ status: questAssignment.assignmentStatus }).from(questAssignment).where(eq(questAssignment.questId, questId)))[0]?.status).toBe('ASSIGNMENT_COMPLETED');
  });

  it('replays one cancellation and rejects a different key after terminal settlement', async () => {
    if (!postgresAvailable) return;
    spyOn(auth.api, 'getSession').mockImplementation((async () => ({ user: { id: hirerId }, session: { userId: hirerId } }) as never) as never);
    const questId = await createQuest('QUEST_ASSIGNED', [workerIds[2]]);
    const first = await request('POST', `/api/v1/quests/${questId}/cancel`, hirerId, undefined, { 'idempotency-key': 'be184-replay' });
    const replay = await request('POST', `/api/v1/quests/${questId}/cancel`, hirerId, undefined, { 'idempotency-key': 'be184-replay' });
    const duplicate = await request('POST', `/api/v1/quests/${questId}/cancel`, hirerId, undefined, { 'idempotency-key': 'be184-other' });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual((await first.clone().json()).data);
    expect(duplicate.status).toBe(409);
    expect(await db.select().from(questSettlementCommand).where(eq(questSettlementCommand.questId, questId))).toHaveLength(1);
  });

  it('allows an Admin to refund a disputed Quest or release explicit Worker allocations', async () => {
    if (!postgresAvailable) return;
    spyOn(adminAuth.api, 'getSession').mockImplementation((async () => ({ user: { id: adminId }, session: { userId: adminId } }) as never) as never);
    const refundQuest = await createQuest('QUEST_DISPUTED', [workerIds[0]]);
    const refund = await request('POST', `/api/v1/admin/quests/${refundQuest}/dispute/resolve`, adminId, { outcome: 'REFUND_HIRER' }, { 'idempotency-key': 'be184-refund' });
    expect(refund.status).toBe(200);
    expect((await refund.json()).data.outcome).toBe('REFUNDED');

    const releaseQuest = await createQuest('QUEST_DISPUTED', [workerIds[1], workerIds[2]], 500);
    const release = await request('POST', `/api/v1/admin/quests/${releaseQuest}/dispute/resolve`, adminId, {
      outcome: 'RELEASE_TO_WORKER',
      allocations: [
        { workerId: workerIds[1], amountSatang: 601 },
        { workerId: workerIds[2], amountSatang: 399 },
      ],
    }, { 'idempotency-key': 'be184-release' });
    expect(release.status).toBe(200);
    expect((await release.json()).data).toMatchObject({ outcome: 'RELEASED_TO_WORKER', paidSatang: 1_000, refundedSatang: 20 });
  });

  it('rolls back Quest, Assignment, Wallet, and command changes when Work Chat rejects the terminal transition', async () => {
    if (!postgresAvailable) return;
    spyOn(auth.api, 'getSession').mockImplementation((async () => ({ user: { id: hirerId }, session: { userId: hirerId } }) as never) as never);
    const questId = await createQuest('QUEST_IN_PROGRESS', [workerIds[0]]);
    const before = (await db.select({ spending: walletWallet.spendingBalanceSatang, reserved: walletWallet.fundingReservedSatang }).from(walletWallet).where(eq(walletWallet.userId, hirerId)))[0];
    configureQuestWorkChatMembershipWriter({ applyQuestTransition: async () => { throw new Error('chat unavailable'); } });
    const response = await request('POST', `/api/v1/quests/${questId}/cancel`, hirerId, undefined, { 'idempotency-key': 'be184-chat-failure' });
    expect(response.status).toBe(503);
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_IN_PROGRESS');
    expect((await db.select({ status: questAssignment.assignmentStatus }).from(questAssignment).where(eq(questAssignment.questId, questId)))[0]?.status).toBe('ASSIGNMENT_ACTIVE');
    const after = (await db.select({ spending: walletWallet.spendingBalanceSatang, reserved: walletWallet.fundingReservedSatang }).from(walletWallet).where(eq(walletWallet.userId, hirerId)))[0];
    expect(after).toEqual(before);
    expect(await db.select().from(questSettlementCommand).where(eq(questSettlementCommand.commandId, 'be184-chat-failure'))).toHaveLength(0);
  });

  it('requires a command key before authentication', async () => {
    const missing = await app.handle(new Request(`http://localhost/api/v1/quests/${randomUUID()}/cancel`, { method: 'POST' }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
