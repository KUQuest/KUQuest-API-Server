import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questAssignment,
  questSettlementCommand,
  questV2UnderfilledConsent,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletFundingReservation, walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { auth } from '@/modules/auth';
import { configureQuestWorkChatMembershipWriter } from '@/modules/quest/quest-assignment.service';
import { runQuestLifecycleWorker } from '@/modules/quest/quest-lifecycle.worker';
import { getQuestV2Underfilled } from '@/modules/quest/quest-underfilled-v2.service';
import type { QuestTransaction, QuestWorkChatMembershipTransition } from '@/modules/quest';
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirer = {
  id: randomUUID(),
  email: `underfilled-v2-hirer-${randomUUID()}@ku.th`,
  firstName: 'Underfilled',
  lastName: 'Hirer',
};
const workers = [
  {
    id: randomUUID(),
    email: `underfilled-v2-worker-one-${randomUUID()}@ku.th`,
    firstName: 'First',
    lastName: 'Worker',
  },
  {
    id: randomUUID(),
    email: `underfilled-v2-worker-two-${randomUUID()}@ku.th`,
    firstName: 'Second',
    lastName: 'Worker',
  },
  {
    id: randomUUID(),
    email: `underfilled-v2-worker-three-${randomUUID()}@ku.th`,
    firstName: 'Third',
    lastName: 'Worker',
  },
];
const tagId = randomUUID();
const questIds: string[] = [];
let postgresAvailable = false;

const successfulWriter = {
  applyQuestTransition: async (
    _transaction: QuestTransaction,
    _transition: QuestWorkChatMembershipTransition,
  ) => ({ conversationId: 'underfilled-test-conversation', outcome: 'APPLIED' as const }),
};

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
  const memberId = headers.get('x-member-id') ?? workers[0].id;
  const member = [hirer, ...workers].find(({ id }) => id === memberId) ?? workers[0];
  return { user: member, session: { userId: member.id } } as never;
}) as never);

const request = (
  path: string,
  method: 'GET' | 'POST',
  memberId: string,
  body?: unknown,
  headers: HeadersInit = {},
) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: {
    ...headers,
    'x-member-id': memberId,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

const account = async (userId: string, type: 'SPENDING' | 'FUNDING_RESERVED') => {
  const [wallet] = await db.select({ id: walletWallet.id }).from(walletWallet).where(eq(walletWallet.userId, userId));
  const [row] = await db.select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, type)));
  return row.id;
};

const fundHirer = async (amountSatang: number) => {
  const spending = await account(hirer.id, 'SPENDING');
  const [suspense] = await db.select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  await createSealedLedgerTransaction({
    businessReference: `underfilled-v2-top-up-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spending, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const createQuest = async (workerIds: string[], reserve = false) => {
  const now = new Date();
  const questId = randomUUID();
  questIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Underfilled GROUP Quest',
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: 'GROUP',
    v2Mode: 'FIRST_COME_FIRST_SERVED',
    v2Participation: 'GROUP',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1_000,
    questFundingTotalSatang: 4_000,
    questEscrowSatang: 16_000,
    tagId,
    headcount: 4,
    startTime: new Date(now.getTime() - 1_000),
    dueAt: new Date(now.getTime() + 60 * 60 * 1_000),
  });
  await db.insert(questAssignment).values(workerIds.map((workerId, index) => ({
    questId,
    workerId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: new Date(now.getTime() - 10_000 + index),
  })));
  if (reserve) {
    await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: hirer.id,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(16_000),
    }));
  }
  return questId;
};

const detect = (now: Date) => runQuestLifecycleWorker({
  clock: { now: () => now },
  autoApprove: async () => [],
});

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    console.warn('Skipping Quest underfilled V2 persistence tests: PostgreSQL is unavailable');
    return;
  }
  await ensureInitialMoneyPolicy();
  await db.insert(authUser).values([hirer, ...workers]);
  await db.insert(tag).values({ id: tagId, name: 'Underfilled V2 test tag' });
  await ensureWallet(hirer.id);
  for (const worker of workers) await ensureWallet(worker.id);
  await fundHirer(100_000);
});

beforeEach(() => {
  authenticate();
  configureQuestWorkChatMembershipWriter(successfulWriter);
});

afterEach(async () => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
  if (!postgresAvailable) return;
  if (questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.splice(0, questIds.length);
  }
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest underfilled GROUP + FCFS API v2', () => {
  it('opens the decision window at startTime and keeps the Quest OPEN', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest([workers[0].id]);
    const now = new Date();

    const result = await detect(now);
    expect(result.autoCancelledQuestIds).not.toContain(questId);
    expect(result.underfilledQuestIds).toContain(questId);

    const response = await request(`/api/v2/quests/${questId}/underfilled`, 'GET', hirer.id);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      questId,
      questState: 'QUEST_OPEN',
      state: 'UNDERFILLED_DECISION_PENDING',
      activeWorkerCount: 1,
      headcount: 4,
      decision: { status: 'UNDERFILLED_DECISION_PENDING', value: null },
      consent: { totalCount: 1, pendingCount: 1 },
    });

    const lateJoin = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      workers[1].id,
      undefined,
      { 'idempotency-key': 'underfilled-late-join' },
    );
    expect(lateJoin.status).toBe(409);
    expect((await lateJoin.json()).error.code).toBe('QUEST_ROSTER_FROZEN');
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_OPEN');
  });

  it('lets the Hirer proceed, exposes the exact revised Reward, and replays the decision command', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest([workers[0].id, workers[1].id]);
    await detect(new Date());

    const first = await request(
      `/api/v2/quests/${questId}/underfilled/decision`,
      'POST',
      hirer.id,
      { decision: 'PROCEED' },
      { 'idempotency-key': 'underfilled-proceed' },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data).toMatchObject({
      state: 'UNDERFILLED_CONSENT_PENDING',
      decision: { status: 'UNDERFILLED_DECISION_PROCEEDED', value: 'PROCEED' },
      consent: { pendingCount: 2, acceptedCount: 0 },
    });

    const workerView = await request(`/api/v2/quests/${questId}/underfilled`, 'GET', workers[0].id);
    expect(workerView.status).toBe(200);
    expect((await workerView.json()).data).toMatchObject({
      questReward: 20,
      dueAt: expect.stringContaining('+07:00'),
      ownResponse: { decision: null, questReward: 20 },
    });

    const replay = await request(
      `/api/v2/quests/${questId}/underfilled/decision`,
      'POST',
      hirer.id,
      { decision: 'PROCEED' },
      { 'idempotency-key': 'underfilled-proceed' },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(firstBody.data);
  });

  it('requires unanimous Worker consent, allocates the original pool, and freezes the roster', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest([workers[0].id, workers[1].id]);
    await detect(new Date());
    await request(
      `/api/v2/quests/${questId}/underfilled/decision`,
      'POST',
      hirer.id,
      { decision: 'PROCEED' },
      { 'idempotency-key': 'underfilled-all-proceed' },
    );

    const [first, second] = await Promise.all(workers.slice(0, 2).map((worker, index) => request(
      `/api/v2/quests/${questId}/underfilled/consent`,
      'POST',
      worker.id,
      { decision: 'ACCEPT' },
      { 'idempotency-key': `underfilled-consent-${index}` },
    )));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const final = await request(`/api/v2/quests/${questId}/underfilled`, 'GET', hirer.id);
    expect(final.status).toBe(200);
    const finalBody = await final.json();
    expect(finalBody.data).toMatchObject({
      state: 'UNDERFILLED_COMPLETED',
      questState: 'QUEST_ASSIGNED',
      consent: { acceptedCount: 2, pendingCount: 0 },
    });
    expect(await db.select({ rewardSatang: questV2UnderfilledConsent.rewardSatang })
      .from(questV2UnderfilledConsent)
      .where(eq(questV2UnderfilledConsent.questId, questId))).toEqual([
      { rewardSatang: 2_000 },
      { rewardSatang: 2_000 },
    ]);
    expect((await db.select({ headcount: quest.headcount, state: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]).toEqual({
      headcount: 4,
      state: 'QUEST_ASSIGNED',
    });

    const afterConsentWindow = await getQuestV2Underfilled(
      hirer.id,
      questId,
      new Date(Date.now() + 10 * 60 * 1_000 + 1),
    );
    expect('underfilled' in afterConsentWindow && afterConsentWindow.underfilled.state).toBe('UNDERFILLED_COMPLETED');

    const lateJoin = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      workers[2].id,
      undefined,
      { 'idempotency-key': 'underfilled-after-consent' },
    );
    expect(lateJoin.status).toBe(409);
  });

  it('cancels on Hirer refusal and refunds the open Quest Escrow', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest([workers[0].id], true);
    await detect(new Date());

    const response = await request(
      `/api/v2/quests/${questId}/underfilled/decision`,
      'POST',
      hirer.id,
      { decision: 'CANCEL' },
      { 'idempotency-key': 'underfilled-cancel' },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      state: 'UNDERFILLED_CANCELLED',
      questState: 'QUEST_CANCELLED',
    });
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_CANCELLED');
    expect((await db.select({ status: walletFundingReservation.status })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.callerReference, questId)))[0]?.status).toBe('RELEASED');

    const replay = await request(
      `/api/v2/quests/${questId}/underfilled/decision`,
      'POST',
      hirer.id,
      { decision: 'CANCEL' },
      { 'idempotency-key': 'underfilled-cancel' },
    );
    expect(replay.status).toBe(200);
  });

  it('cancels when the Hirer decision window times out', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest([workers[0].id], true);
    const detectedAt = new Date();
    await detect(detectedAt);

    const result = await runQuestLifecycleWorker({
      clock: { now: () => new Date(detectedAt.getTime() + 10 * 60 * 1_000 + 1) },
      autoApprove: async () => [],
    });
    expect(result.timedOutUnderfilledQuestIds).toContain(questId);
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_CANCELLED');
    expect((await db.select({ type: questSettlementCommand.commandType, actorUserId: questSettlementCommand.actorUserId })
      .from(questSettlementCommand)
      .where(eq(questSettlementCommand.questId, questId)))[0]).toEqual({ type: 'AUTO_CANCEL', actorUserId: null });
  });

  it('cancels on Worker decline and on consent timeout', async () => {
    if (!postgresAvailable) return;
    const declinedQuestId = await createQuest([workers[0].id, workers[1].id], true);
    await detect(new Date());
    await request(
      `/api/v2/quests/${declinedQuestId}/underfilled/decision`,
      'POST',
      hirer.id,
      { decision: 'PROCEED' },
      { 'idempotency-key': 'underfilled-decline-proceed' },
    );
    const declined = await request(
      `/api/v2/quests/${declinedQuestId}/underfilled/consent`,
      'POST',
      workers[0].id,
      { decision: 'DECLINE' },
      { 'idempotency-key': 'underfilled-decline' },
    );
    expect(declined.status).toBe(200);
    expect((await declined.json()).data).toMatchObject({ state: 'UNDERFILLED_CANCELLED', questState: 'QUEST_CANCELLED' });

    const timeoutQuestId = await createQuest([workers[1].id], true);
    const detectedAt = new Date();
    await detect(detectedAt);
    await request(
      `/api/v2/quests/${timeoutQuestId}/underfilled/decision`,
      'POST',
      hirer.id,
      { decision: 'PROCEED' },
      { 'idempotency-key': 'underfilled-timeout-proceed' },
    );
    const consentStartedAt = new Date();
    const result = await runQuestLifecycleWorker({
      clock: { now: () => new Date(consentStartedAt.getTime() + 10 * 60 * 1_000 + 1) },
      autoApprove: async () => [],
    });
    expect(result.timedOutUnderfilledQuestIds).toContain(timeoutQuestId);
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, timeoutQuestId)))[0]?.status).toBe('QUEST_CANCELLED');
  });

  it('publishes authenticated, actor-scoped underfilled operations', async () => {
    if (!postgresAvailable) return;
    const document = await (await app.handle(new Request('http://localhost/openapi/json'))).json() as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(document.paths['/api/v2/quests/{questId}/underfilled']?.get?.operationId).toBe('getQuestUnderfilledV2');
    expect(document.paths['/api/v2/quests/{questId}/underfilled/decision']?.post?.operationId).toBe('decideQuestUnderfilledV2');
    expect(document.paths['/api/v2/quests/{questId}/underfilled/consent']?.post?.operationId).toBe('respondToQuestUnderfilledV2');

    const questId = await createQuest([workers[0].id]);
    await detect(new Date());
    const otherWorker = await request(`/api/v2/quests/${questId}/underfilled`, 'GET', workers[1].id);
    expect(otherWorker.status).toBe(404);
  });
});
