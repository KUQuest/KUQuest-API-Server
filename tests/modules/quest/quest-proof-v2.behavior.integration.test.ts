import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { adminDisputeCase, adminReviewItem } from '@/database/schema/admin.schema';
import { auditRecord } from '@/database/schema/audit.schema';
import { file } from '@/database/schema/file.schema';
import { chatConversation, chatMembership } from '@/database/schema/work-chat.schema';
import {
  quest,
  questCommand,
  questAssignment,
  questConditionItem,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2CompletionConfirmation,
  questV2UnderfilledConsent,
  questV2UnderfilledDecision,
  questV2ProofSubmission,
  questV2ProofSubmissionFile,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { auth } from '@/modules/auth';
import {
  autoApproveDueQuestV2CompletionConfirmations,
  autoApproveDueQuestV2Proofs,
  createQuestV2ProofSubmission,
  failQuestV2AtDueAt,
  retryQuestV2ProofUploadCleanup,
  reviewQuestV2ProofSubmission,
  submitQuestV2ProofSubmission,
  type QuestTransaction,
} from '@/modules/quest';
import { terminateQuestInTransaction } from '@/modules/quest/settlement';
import { questV2ProofStorage } from '@/modules/quest/v2';
import type { QuestWorkChatWriter } from '@/modules/quest/shared';
import { createWorkChatMembershipWriter, workChatMembershipWriter } from '@/modules/work-chat';
import {
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  reserveSpending,
} from '@/modules/wallet';
import {
  FileDimensionsTooLargeError,
  FileTooLargeError,
  UnsupportedFileTypeError,
} from '@/shared/object-storage';
import {
  fundTestWallet,
  listTestLedgerPostings,
  listTestQuestEscrowSettlements,
  readTestQuestEscrow,
  releaseTestQuestEscrows,
} from '../wallet/wallet-test-fixtures';

import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  type Mock,
  spyOn,
} from 'bun:test';

const hirer = {
  id: randomUUID(),
  email: `proof-v2-behavior-hirer-${randomUUID()}@ku.th`,
  firstName: 'Proof',
  lastName: 'Hirer',
};
const worker = {
  id: randomUUID(),
  email: `proof-v2-behavior-worker-${randomUUID()}@ku.th`,
  firstName: 'Proof',
  lastName: 'Worker',
};
const secondWorker = {
  id: randomUUID(),
  email: `proof-v2-behavior-worker-two-${randomUUID()}@ku.th`,
  firstName: 'Second',
  lastName: 'Worker',
};
const unrelated = {
  id: randomUUID(),
  email: `proof-v2-behavior-unrelated-${randomUUID()}@ku.th`,
  firstName: 'Unrelated',
  lastName: 'Member',
};
const members = [hirer, worker, secondWorker, unrelated];
const tagId = randomUUID();
const questIds: string[] = [];
const fileIds: string[] = [];
let postgresAvailable = false;
let proofSchemaAvailable = false;
let applySpy: Mock<QuestWorkChatWriter['applyQuestTransition']> | undefined;

const successfulWriter = {
  applyQuestTransition: async (_transaction: QuestTransaction, _transition: unknown) => ({
    conversationId: 'proof-v2-behavior-conversation',
    outcome: 'APPLIED' as const,
  }),
};

const authenticate = () =>
  spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
    const memberId = headers.get('x-member-id') ?? worker.id;
    const member = members.find(({ id }) => id === memberId) ?? worker;
    return { user: member, session: { userId: member.id } } as never;
  }) as never);

const request = (
  method: string,
  path: string,
  memberId: string,
  body?: BodyInit,
  headers: HeadersInit = {}
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'x-member-id': memberId,
        ...(body instanceof FormData
          ? {}
          : body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        ...headers,
      },
      body,
    })
  );

const jsonRequest = (
  method: string,
  path: string,
  memberId: string,
  body: unknown,
  headers: HeadersInit = {}
) => request(method, path, memberId, JSON.stringify(body), headers);

const createCompletionConfirmation = async (
  questId: string,
  memberId: string,
  commandId: string
) => {
  const response = await request(
    'POST',
    `/api/v2/quests/${questId}/completion-confirmation`,
    memberId,
    undefined,
    { 'idempotency-key': commandId }
  );
  const body = await response.json();
  return { response, body };
};

const reviewCompletionConfirmation = (
  questId: string,
  completionConfirmationId: string,
  decision: 'COMPLETION_CONFIRMATION_APPROVED' | 'COMPLETION_CONFIRMATION_NOT_APPROVED',
  reason: string | undefined,
  commandId: string
) =>
  jsonRequest(
    'POST',
    `/api/v2/quests/${questId}/completion-confirmations/${completionConfirmationId}/review`,
    hirer.id,
    { decision, ...(reason === undefined ? {} : { reason }) },
    { 'idempotency-key': commandId }
  );

const createQuest = async (
  overrides: Partial<typeof quest.$inferInsert> = {},
  assignmentWorkerIds?: string[]
) => {
  const questId = randomUUID();
  questIds.push(questId);
  const group = overrides.v2Participation === 'GROUP';
  const v2Mode = overrides.v2Mode ?? 'FIRST_COME_FIRST_SERVED';
  const workerIds = assignmentWorkerIds ?? (group ? [worker.id, secondWorker.id] : [worker.id]);
  await db.insert(quest).values({
    id: questId,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Proof Submission v2 behavior Quest',
    condition: 'Complete the work',
    mode: v2Mode === 'CANDIDATE' ? 'CANDIDATE' : 'NO_CANDIDATE',
    participation: group ? 'GROUP' : 'SOLO',
    v2Mode,
    v2Participation: group ? 'GROUP' : 'SINGLE',
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 1_000,
    questFundingTotalSatang: group ? 2_000 : 1_000,
    questEscrowSatang: group ? 2_040 : 1_020,
    tagId,
    headcount: group ? 2 : 1,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
    dueAt: new Date('2030-01-01T11:00:00.000Z'),
    proofRequired: true,
    ...overrides,
  });
  await db.insert(questAssignment).values(
    workerIds.map((workerId, index) => ({
      questId,
      workerId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
      createdAt: new Date(Date.now() + index),
    }))
  );
  return { questId, workerIds };
};

const createFile = async (uploadedByUserId: string, contentType = 'application/pdf') => {
  const id = randomUUID();
  fileIds.push(id);
  await db.insert(file).values({
    id,
    bucket: 'proof-v2-behavior-test',
    objectKey: `${id}.pdf`,
    contentType,
    sizeBytes: 100,
    uploadedByUserId,
  });
  return id;
};

const reserveQuest = async (questId: string, amountSatang: number) => {
  await db.transaction((transaction) =>
    reserveSpending(transaction, {
      ownerUserId: hirer.id,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(amountSatang),
    })
  );
};

const deleteWorkChatForQuests = async (ids: string[]) => {
  if (ids.length === 0) return;
  const conversations = await db
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(inArray(chatConversation.questId, ids));
  const conversationIds = conversations.map(({ id }) => id);
  if (conversationIds.length === 0) return;
  const messages = await sql<{ id: string }[]>`
    select id from chat_message where conversation_id = any(${sql.array(conversationIds, 2951)})
  `;
  const messageIds = messages.map(({ id }) => id);
  if (messageIds.length > 0) {
    await sql`delete from chat_message_attachment where message_id = any(${sql.array(messageIds, 2951)})`;
    await sql`delete from chat_message where id = any(${sql.array(messageIds, 2951)})`;
  }
  await sql`delete from chat_read_cursor where conversation_id = any(${sql.array(conversationIds, 2951)})`;
  await sql`delete from chat_attachment where conversation_id = any(${sql.array(conversationIds, 2951)})`;
  await sql`delete from chat_transition_commands where quest_id = any(${sql.array(ids, 2951)})`;
  await db.delete(chatMembership).where(inArray(chatMembership.conversationId, conversationIds));
  await db.delete(chatConversation).where(inArray(chatConversation.id, conversationIds));
};

const createSentProofForQuest = async (questId: string, memberId: string, sentAt = new Date()) => {
  const proofFileId = await createFile(memberId);
  const created = await createQuestV2ProofSubmission(
    memberId,
    questId,
    { description: 'Submitted proof', fileIds: [proofFileId] },
    `proof-v2-behavior-create-${questId}-${randomUUID()}`,
    sentAt
  );
  if ('outcome' in created) throw new Error(`Proof Draft creation failed: ${created.outcome}`);
  const sent = await submitQuestV2ProofSubmission(
    memberId,
    questId,
    created.id,
    `proof-v2-behavior-submit-${questId}-${randomUUID()}`,
    sentAt
  );
  if ('outcome' in sent) throw new Error(`Proof Submission send failed: ${sent.outcome}`);
  return { proofSubmissionId: sent.id, proofFileId, sentAt: sent.submittedAt! };
};

const createHttpSentProof = async (
  overrides: Partial<typeof quest.$inferInsert> = {},
  memberId = worker.id
) => {
  const { questId } = await createQuest(overrides);
  const proofFileId = await createFile(memberId);
  const created = await jsonRequest(
    'POST',
    `/api/v2/quests/${questId}/proof-submissions`,
    memberId,
    { description: 'Submitted proof', fileIds: [proofFileId] },
    { 'idempotency-key': `proof-v2-behavior-http-create-${questId}` }
  );
  if (created.status !== 201)
    throw new Error(`Proof Draft HTTP creation failed: ${created.status}`);
  const createdData = (await created.json()).data as { id: string };
  const sent = await request(
    'POST',
    `/api/v2/quests/${questId}/proof-submissions/${createdData.id}/submit`,
    memberId,
    undefined,
    { 'idempotency-key': `proof-v2-behavior-http-submit-${questId}` }
  );
  if (sent.status !== 200) throw new Error(`Proof Submission HTTP send failed: ${sent.status}`);
  return { questId, proofSubmissionId: createdData.id, proofFileId };
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
    const [tables] = await sql<{ command: string | null; submission: string | null }[]>`
      select
        to_regclass('public.quest_command') as command,
        to_regclass('public.quest_v2_proof_submission') as submission
    `;
    proofSchemaAvailable = tables?.command !== null && tables?.submission !== null;
  } catch {
    console.warn('Skipping Quest Proof v2 behavior tests: PostgreSQL is unavailable');
    return;
  }
  if (!proofSchemaAvailable) {
    console.warn('Skipping Quest Proof v2 behavior tests: proof migrations are not applied');
    return;
  }
  await ensureInitialMoneyPolicy();
  await db.insert(authUser).values(members);
  await db.insert(tag).values({ id: tagId, name: `Proof v2 behavior test tag ${tagId}` });
  for (const member of members) await ensureWallet(member.id);
  await fundTestWallet(hirer.id, 100_000);
});

beforeEach(() => {
  authenticate();
  applySpy = spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
    successfulWriter.applyQuestTransition
  );
});

afterEach(async () => {
  mock.restore();
  if (!postgresAvailable || !proofSchemaAvailable) return;
  await releaseTestQuestEscrows([hirer.id]);
  if (questIds.length > 0) {
    await deleteWorkChatForQuests([...questIds]);
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.splice(0, questIds.length);
  }
  if (fileIds.length > 0) {
    await db.delete(file).where(inArray(file.id, fileIds));
    fileIds.splice(0, fileIds.length);
  }
});

afterAll(async () => {
  if (!postgresAvailable || !proofSchemaAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest Proof Submission v2 behavior', () => {
  it('creates, edits, sends, replays, and role-filters a Proof Submission', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const dueAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const { questId } = await createQuest({
      v2Participation: 'GROUP',
      headcount: 2,
      questFundingTotalSatang: 2_000,
      questEscrowSatang: 2_040,
      startTime: new Date(Date.now() - 60 * 60 * 1000),
      dueAt,
    });
    const firstFileId = await createFile(worker.id);
    const secondFileId = await createFile(worker.id);

    const created = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      { description: 'draft', workerMessage: 'Worker note', fileIds: [firstFileId] },
      { 'idempotency-key': 'proof-v2-behavior-create' }
    );
    expect(created.status).toBe(201);
    const createdData = (await created.json()).data as Record<string, unknown>;
    expect(createdData).toMatchObject({
      description: 'draft',
      workerMessage: 'Worker note',
      status: null,
      visibility: 'FULL',
      fileIds: [firstFileId],
    });

    const hirerDrafts = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions`,
      hirer.id
    );
    expect(hirerDrafts.status).toBe(200);
    expect((await hirerDrafts.json()).data.items).toEqual([]);

    const workerDrafts = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id
    );
    expect((await workerDrafts.json()).data.items).toEqual([
      expect.objectContaining({
        id: createdData.id,
        visibility: 'FULL',
        description: 'draft',
      }),
    ]);

    const updated = await jsonRequest(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}`,
      worker.id,
      { description: 'edited', fileIds: [secondFileId] },
      { 'idempotency-key': 'proof-v2-behavior-edit' }
    );
    expect(updated.status).toBe(200);
    const updatedData = (await updated.json()).data as Record<string, unknown>;
    expect(updatedData).toMatchObject({ description: 'edited', fileIds: [secondFileId] });

    const replay = await jsonRequest(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}`,
      worker.id,
      { description: 'edited', fileIds: [secondFileId] },
      { 'idempotency-key': 'proof-v2-behavior-edit' }
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(updatedData);

    const reused = await jsonRequest(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}`,
      worker.id,
      { description: 'different', fileIds: [secondFileId] },
      { 'idempotency-key': 'proof-v2-behavior-edit' }
    );
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const sent = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-submit' }
    );
    expect(sent.status).toBe(200);
    const sentData = (await sent.json()).data;
    expect(sentData.status).toBe('PROOF_PENDING');
    expect(new Date(sentData.reviewDeadlineAt).getTime()).toBe(
      Math.max(new Date(sentData.submittedAt).getTime() + 24 * 60 * 60 * 1000, dueAt.getTime())
    );
    expect(sentData.reviewReason).toBeNull();
    const [submitCommand] = await db
      .select({ id: questCommand.id, resultData: questCommand.resultData })
      .from(questCommand)
      .where(
        and(eq(questCommand.questId, questId), eq(questCommand.key, 'proof-v2-behavior-submit'))
      )
      .limit(1);
    if (!submitCommand) throw new Error('Proof Submission submit command was not recorded');
    const savedResult = submitCommand.resultData as {
      kind?: unknown;
      result?: unknown;
    } | null;
    if (
      savedResult?.kind !== 'success' ||
      !savedResult.result ||
      typeof savedResult.result !== 'object' ||
      Array.isArray(savedResult.result)
    ) {
      throw new Error('Proof Submission submit command has no saved success result');
    }
    const staleDeadline = new Date(
      new Date(sentData.submittedAt).getTime() + 24 * 60 * 60 * 1000
    ).toISOString();
    expect(new Date(staleDeadline).getTime()).toBeLessThan(dueAt.getTime());
    await db
      .update(questCommand)
      .set({
        resultData: {
          ...savedResult,
          result: { ...savedResult.result, reviewDeadlineAt: staleDeadline },
        },
      })
      .where(eq(questCommand.id, submitCommand.id));
    const sentReplay = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-submit' }
    );
    expect(sentReplay.status).toBe(200);
    expect((await sentReplay.json()).data.reviewDeadlineAt).toBe(sentData.reviewDeadlineAt);

    const hirerSent = await request('GET', `/api/v2/quests/${questId}/proof-submissions`, hirer.id);
    expect((await hirerSent.json()).data.items).toEqual([
      expect.objectContaining({
        id: createdData.id,
        visibility: 'FULL',
        description: 'edited',
        fileIds: [secondFileId],
      }),
    ]);

    const otherWorkerView = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions`,
      secondWorker.id
    );
    expect((await otherWorkerView.json()).data.items).toEqual([
      expect.objectContaining({
        id: createdData.id,
        visibility: 'SUMMARY',
        description: null,
        fileIds: [],
        files: [],
        status: 'PROOF_PENDING',
        reviewDeadlineAt: expect.any(String),
        reviewReason: null,
        reviewedAt: null,
        reviewedBy: null,
      }),
    ]);

    const lockedEdit = await jsonRequest(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}`,
      worker.id,
      { description: 'locked' },
      { 'idempotency-key': 'proof-v2-behavior-locked-edit' }
    );
    expect(lockedEdit.status).toBe(409);
    expect((await lockedEdit.json()).error.code).toBe('PROOF_SUBMISSION_LOCKED');

    const reuseQuest = await createQuest();
    const reusedFirst = await jsonRequest(
      'POST',
      `/api/v2/quests/${reuseQuest.questId}/proof-submissions`,
      worker.id,
      { description: 'worker command' },
      { 'idempotency-key': 'proof-v2-behavior-cross-actor' }
    );
    expect(reusedFirst.status).toBe(201);
    const reusedAgain = await jsonRequest(
      'POST',
      `/api/v2/quests/${reuseQuest.questId}/proof-submissions`,
      worker.id,
      { description: 'second command' },
      { 'idempotency-key': 'proof-v2-behavior-cross-actor' }
    );
    expect(reusedAgain.status).toBe(409);
    expect((await reusedAgain.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  it('rejects a Worker message longer than 200 characters', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const proofFileId = await createFile(worker.id);

    const result = await createQuestV2ProofSubmission(
      worker.id,
      questId,
      { workerMessage: 'x'.repeat(201), fileIds: [proofFileId] },
      `proof-v2-behavior-worker-message-too-long-${questId}`
    );

    expect(result).toEqual({ outcome: 'invalid-draft' });
  });

  it('lets two Workers send the same Idempotency-Key for their own proof commands', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const firstQuest = await createQuest();
    const secondQuest = await createQuest({}, [secondWorker.id]);

    const [first, second] = await Promise.all([
      jsonRequest(
        'POST',
        `/api/v2/quests/${firstQuest.questId}/proof-submissions`,
        worker.id,
        { description: 'first worker command' },
        { 'idempotency-key': 'proof-v2-behavior-two-workers-key' }
      ),
      jsonRequest(
        'POST',
        `/api/v2/quests/${secondQuest.questId}/proof-submissions`,
        secondWorker.id,
        { description: 'second worker command' },
        { 'idempotency-key': 'proof-v2-behavior-two-workers-key' }
      ),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };
    const secondBody = (await second.json()) as { data: { id: string } };
    expect(firstBody.data.id).not.toBe(secondBody.data.id);

    const [firstReplay, secondReplay] = await Promise.all([
      jsonRequest(
        'POST',
        `/api/v2/quests/${firstQuest.questId}/proof-submissions`,
        worker.id,
        { description: 'first worker command' },
        { 'idempotency-key': 'proof-v2-behavior-two-workers-key' }
      ),
      jsonRequest(
        'POST',
        `/api/v2/quests/${secondQuest.questId}/proof-submissions`,
        secondWorker.id,
        { description: 'second worker command' },
        { 'idempotency-key': 'proof-v2-behavior-two-workers-key' }
      ),
    ]);
    expect(firstReplay.status).toBe(201);
    expect(secondReplay.status).toBe(201);
    const firstReplayBody = (await firstReplay.json()) as { data: { id: string } };
    const secondReplayBody = (await secondReplay.json()) as { data: { id: string } };
    expect(firstReplayBody.data.id).toBe(firstBody.data.id);
    expect(secondReplayBody.data.id).toBe(secondBody.data.id);
  });

  it('approves a sent Proof, settles the Quest Reward, and completes the Quest atomically', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, proofSubmissionId } = await createHttpSentProof({
      questFundingTotalSatang: 1_020,
      questEscrowSatang: 1_020,
    });
    await reserveQuest(questId, 1_020);

    const response = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      hirer.id,
      { decision: 'PROOF_APPROVED' },
      { 'idempotency-key': `proof-v2-behavior-review-approve-${questId}` }
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      proof: { id: proofSubmissionId, status: 'PROOF_APPROVED' },
      questStatus: 'QUEST_COMPLETED',
    });

    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_COMPLETED');
    expect(
      (
        await db
          .select({ status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
      )[0]?.status
    ).toBe('ASSIGNMENT_COMPLETED');
    const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    expect(reservation).toMatchObject({ status: 'SETTLED', remainingSatang: 0 });
    expect(
      (await listTestQuestEscrowSettlements(reservation!.id)).map(
        ({ recipientUserId, recipientAmountSatang, platformFeeSatang }) => ({
          recipientUserId,
          recipientAmountSatang,
          platformFeeSatang,
        })
      )
    ).toEqual([
      { recipientUserId: worker.id, recipientAmountSatang: 1_000, platformFeeSatang: 20 },
    ]);
    expect(
      await db
        .select({ action: auditRecord.action, resourceType: auditRecord.resourceType })
        .from(auditRecord)
        .where(eq(auditRecord.resourceId, proofSubmissionId))
    ).toEqual([{ action: 'PROOF_REVIEWED', resourceType: 'PROOF_SUBMISSION' }]);
  });

  it('records PROOF_NOT_APPROVED, fails the Quest, and creates one Admin Review Item', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, proofSubmissionId, proofFileId } = await createHttpSentProof({
      questFundingTotalSatang: 1_020,
      questEscrowSatang: 1_020,
    });
    await reserveQuest(questId, 1_020);
    const key = `proof-v2-behavior-review-not-approved-${questId}`;
    const first = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      hirer.id,
      { decision: 'PROOF_NOT_APPROVED', reason: 'The submitted work is incomplete' },
      { 'idempotency-key': key }
    );
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      proof: { id: proofSubmissionId, status: 'PROOF_NOT_APPROVED' },
      questStatus: 'QUEST_FAILED',
    });

    const replay = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      hirer.id,
      { decision: 'PROOF_NOT_APPROVED', reason: 'The submitted work is incomplete' },
      { 'idempotency-key': key }
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(firstBody.data.proof).toMatchObject({
      reviewDeadlineAt: null,
      reviewReason: 'The submitted work is incomplete',
      reviewedBy: 'HIRER',
      reviewedAt: expect.any(String),
    });
    for (const viewer of [worker.id, hirer.id]) {
      const listed = await request('GET', `/api/v2/quests/${questId}/proof-submissions`, viewer);
      expect((await listed.json()).data.items[0]).toMatchObject({
        reviewReason: 'The submitted work is incomplete',
      });
    }

    const reused = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      hirer.id,
      { decision: 'PROOF_NOT_APPROVED', reason: 'A different reason' },
      { 'idempotency-key': key }
    );
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const secondDecision = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      hirer.id,
      { decision: 'PROOF_APPROVED' },
      { 'idempotency-key': `${key}-second` }
    );
    expect(secondDecision.status).toBe(409);
    expect((await secondDecision.json()).error.code).toBe('PROOF_REVIEW_NOT_PENDING');
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_FAILED');
    expect(
      (
        await db
          .select({ status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
      )[0]?.status
    ).toBe('ASSIGNMENT_INCOMPLETE');
    expect(
      await db
        .select({
          reason: adminReviewItem.reason,
          proofSubmissionId: adminReviewItem.proofSubmissionId,
          evidenceReferences: adminReviewItem.evidenceReferences,
        })
        .from(adminReviewItem)
        .where(eq(adminReviewItem.proofSubmissionId, proofSubmissionId))
    ).toEqual([
      {
        reason: 'The submitted work is incomplete',
        proofSubmissionId,
        evidenceReferences: [proofFileId],
      },
    ]);
    expect(
      await db
        .select({ filerUserId: adminDisputeCase.filerUserId, status: adminDisputeCase.status })
        .from(adminDisputeCase)
        .where(
          and(eq(adminDisputeCase.questId, questId), eq(adminDisputeCase.filerUserId, worker.id))
        )
    ).toEqual([]);
    expect(await readTestQuestEscrow({ ownerUserId: hirer.id, questId })).toMatchObject({
      status: 'ACTIVE',
      remainingSatang: 1_020,
    });
  });
  it('returns a temporary Proof file URL to an authorized Hirer', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, proofSubmissionId, proofFileId } = await createHttpSentProof();
    const expiresAt = new Date('2030-01-01T00:15:00.000Z');
    const link = spyOn(questV2ProofStorage, 'linkForWithExpiry').mockReturnValue({
      url: 'https://storage.example/proof-file',
      expiresAt,
    });

    const response = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/files/${proofFileId}`,
      hirer.id
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        fileId: proofFileId,
        contentType: 'application/pdf',
        sizeBytes: 100,
        position: 0,
        url: 'https://storage.example/proof-file',
        urlExpiresAt: expiresAt.toISOString(),
      },
    });
    expect(link).toHaveBeenCalledWith({
      bucket: 'proof-v2-behavior-test',
      objectKey: `${proofFileId}.pdf`,
    });

    const unauthorized = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/files/${proofFileId}`,
      unrelated.id
    );
    expect(unauthorized.status).toBe(404);
  });

  it('requires a reason for a not-approved decision without changing the pending Proof', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, proofSubmissionId } = await createHttpSentProof();
    const response = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      hirer.id,
      { decision: 'PROOF_NOT_APPROVED' },
      { 'idempotency-key': `proof-v2-behavior-review-reason-${questId}` }
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('PROOF_NOT_APPROVED_REASON_REQUIRED');
    expect(
      (
        await db
          .select({ status: questV2ProofSubmission.submissionStatus })
          .from(questV2ProofSubmission)
          .where(eq(questV2ProofSubmission.id, proofSubmissionId))
      )[0]?.status
    ).toBe('PROOF_PENDING');
  });

  it('auto-approves pending Proofs at the later of dueAt and 24 hours after send', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const reviewWindowMs = 24 * 60 * 60 * 1000;
    const sentAt = new Date(Date.now() - 50 * 60 * 60 * 1000);
    const verifyDeadline = async (dueOffsetMs: number, label: string) => {
      const dueAt = new Date(sentAt.getTime() + dueOffsetMs);
      const approvalAt = new Date(Math.max(sentAt.getTime() + reviewWindowMs, dueAt.getTime()));
      const { questId } = await createQuest({
        questFundingTotalSatang: 1_020,
        questEscrowSatang: 1_020,
        startTime: new Date(sentAt.getTime() - 60 * 60 * 1000),
        dueAt,
      });
      await reserveQuest(questId, 1_020);
      const { proofSubmissionId } = await createSentProofForQuest(questId, worker.id, sentAt);

      expect(
        await autoApproveDueQuestV2Proofs(new Date(approvalAt.getTime() - 1), 10),
        label
      ).not.toContain(proofSubmissionId);
      expect(await autoApproveDueQuestV2Proofs(approvalAt, 10), label).toContain(proofSubmissionId);
    };
    await verifyDeadline(48 * 60 * 60 * 1000, 'dueAt later than 24 hours');
    await verifyDeadline(8 * 60 * 60 * 1000, '24 hours later than dueAt');
    await verifyDeadline(reviewWindowMs, 'equal deadlines');

    const { questId } = await createQuest({
      questFundingTotalSatang: 1_020,
      questEscrowSatang: 1_020,
      startTime: new Date(sentAt.getTime() - 60 * 60 * 1000),
      dueAt: new Date(sentAt.getTime() + 48 * 60 * 60 * 1000),
    });
    await reserveQuest(questId, 1_020);
    const { proofSubmissionId } = await createSentProofForQuest(questId, worker.id, sentAt);
    const fixtureEscrow = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    expect(fixtureEscrow?.status).toBe('ACTIVE');
    const dueAt = new Date(sentAt.getTime() + 48 * 60 * 60 * 1000);
    expect(
      await autoApproveDueQuestV2Proofs(new Date(sentAt.getTime() + reviewWindowMs), 10)
    ).not.toContain(proofSubmissionId);
    expect(await autoApproveDueQuestV2Proofs(dueAt, 10)).toContain(proofSubmissionId);
    expect(
      (
        await db
          .select({ status: questV2ProofSubmission.submissionStatus })
          .from(questV2ProofSubmission)
          .where(eq(questV2ProofSubmission.id, proofSubmissionId))
      )[0]?.status
    ).toBe('PROOF_APPROVED');
    const autoApproved = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id
    );
    expect((await autoApproved.json()).data.items[0]).toMatchObject({
      status: 'PROOF_APPROVED',
      reviewDeadlineAt: null,
      reviewReason: null,
      reviewedBy: 'AUTO_APPROVE',
      reviewedAt: expect.any(String),
    });
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_COMPLETED');
  });

  it('keeps an early Hirer decision final when the auto-approval deadline arrives', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const sentAt = new Date(Date.now() - 50 * 60 * 60 * 1000);
    const dueAt = new Date(sentAt.getTime() + 48 * 60 * 60 * 1000);
    const hirerDecisionAt = new Date(sentAt.getTime() + 12 * 60 * 60 * 1000);
    const { questId } = await createQuest({
      questFundingTotalSatang: 1_020,
      questEscrowSatang: 1_020,
      startTime: new Date(sentAt.getTime() - 60 * 60 * 1000),
      dueAt,
    });
    await reserveQuest(questId, 1_020);
    const { proofSubmissionId } = await createSentProofForQuest(questId, worker.id, sentAt);

    const decision = await reviewQuestV2ProofSubmission(
      hirer.id,
      questId,
      proofSubmissionId,
      'PROOF_APPROVED',
      null,
      `proof-v2-behavior-early-hirer-decision-${questId}`,
      hirerDecisionAt
    );
    expect(decision).toMatchObject({ proof: { status: 'PROOF_APPROVED', reviewedBy: 'HIRER' } });
    expect(await autoApproveDueQuestV2Proofs(dueAt, 10)).not.toContain(proofSubmissionId);
    expect(
      await db
        .select({
          status: questV2ProofSubmission.submissionStatus,
          reviewedBy: questV2ProofSubmission.reviewedBy,
        })
        .from(questV2ProofSubmission)
        .where(eq(questV2ProofSubmission.id, proofSubmissionId))
    ).toEqual([{ status: 'PROOF_APPROVED', reviewedBy: 'HIRER' }]);
  });

  it('fails a Quest at dueAt when required Proof or proof-free confirmation is missing', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const dueAt = new Date(Date.now() - 1_000);
    const missingProof = await createQuest({
      startTime: new Date(dueAt.getTime() - 60 * 60 * 1000),
      dueAt,
    });
    const missingConfirmation = await createQuest({
      proofRequired: false,
      startTime: new Date(dueAt.getTime() - 60 * 60 * 1000),
      dueAt,
    });
    await reserveQuest(missingProof.questId, 1_020);
    await reserveQuest(missingConfirmation.questId, 1_020);

    expect(await failQuestV2AtDueAt(missingProof.questId, new Date())).toBe(true);
    expect(await failQuestV2AtDueAt(missingConfirmation.questId, new Date())).toBe(true);
    expect(
      await db
        .select({ status: quest.questStatus })
        .from(quest)
        .where(inArray(quest.id, [missingProof.questId, missingConfirmation.questId]))
    ).toEqual([{ status: 'QUEST_FAILED' }, { status: 'QUEST_FAILED' }]);
    expect(
      await db
        .select({ status: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(
          inArray(questAssignment.questId, [missingProof.questId, missingConfirmation.questId])
        )
    ).toEqual([{ status: 'ASSIGNMENT_INCOMPLETE' }, { status: 'ASSIGNMENT_INCOMPLETE' }]);
  });

  it('emits QUEST_FAILED and DISPUTE_WINDOW_OPENED once when dueAt fails the Quest', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const dueAt = new Date(Date.now() - 1_000);
    const { questId } = await createQuest({
      startTime: new Date(dueAt.getTime() - 60 * 60 * 1000),
      dueAt,
    });
    await reserveQuest(questId, 1_020);
    const changeTypes: string[] = [];
    let wake!: () => void;
    let waiting = new Promise<void>((resolve) => (wake = resolve));
    const listener = await sql.listen('kuquest_quest_updates', (payload) => {
      const event = JSON.parse(payload) as { questId: string; changeType: string };
      if (event.questId !== questId) return;
      changeTypes.push(event.changeType);
      wake();
      waiting = new Promise<void>((resolve) => (wake = resolve));
    });
    try {
      expect(await failQuestV2AtDueAt(questId, new Date())).toBe(true);
      expect(await failQuestV2AtDueAt(questId, new Date())).toBe(false);
      while (changeTypes.length < 2) await waiting;
      expect([...changeTypes].sort()).toEqual(['DISPUTE_WINDOW_OPENED', 'QUEST_FAILED']);
    } finally {
      await listener.unlisten();
    }
  });

  it('reviews a valid pending Proof after another GROUP FCFS Assignment fails', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const failureNow = new Date();
    const dueAt = new Date(failureNow.getTime() - 1_000);
    const { questId } = await createQuest(
      {
        v2Participation: 'GROUP',
        v2Mode: 'FIRST_COME_FIRST_SERVED',
        questFundingTotalSatang: 2_000,
        questEscrowSatang: 2_040,
        startTime: new Date(dueAt.getTime() - 60 * 60 * 1000),
        dueAt,
      },
      [worker.id, secondWorker.id]
    );
    await reserveQuest(questId, 2_040);
    const { proofSubmissionId } = await createSentProofForQuest(
      questId,
      worker.id,
      new Date(dueAt.getTime() - 1)
    );
    expect(await failQuestV2AtDueAt(questId, failureNow)).toBe(true);

    const review = await reviewQuestV2ProofSubmission(
      hirer.id,
      questId,
      proofSubmissionId,
      'PROOF_APPROVED',
      null,
      `proof-v2-behavior-post-failure-${questId}`,
      failureNow
    );
    expect(review).toMatchObject({
      questStatus: 'QUEST_FAILED',
      proof: { status: 'PROOF_APPROVED' },
    });
    expect(
      await db
        .select({ workerId: questAssignment.workerId, status: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(eq(questAssignment.questId, questId))
    ).toEqual(
      expect.arrayContaining([
        { workerId: worker.id, status: 'ASSIGNMENT_COMPLETED' },
        { workerId: secondWorker.id, status: 'ASSIGNMENT_INCOMPLETE' },
      ])
    );
    expect(await readTestQuestEscrow({ ownerUserId: hirer.id, questId })).toMatchObject({
      status: 'ACTIVE',
      remainingSatang: 1_020,
    });
  });

  it('rolls back Proof review effects when the Work Conversation transition fails', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, proofSubmissionId } = await createHttpSentProof();
    await reserveQuest(questId, 1_020);
    spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
      async (_transaction, transition) => {
        if (transition.type === 'workerBecameInactive') throw new Error('chat unavailable');
        return { conversationId: 'proof-v2-behavior-review-rollback', outcome: 'APPLIED' as const };
      }
    );

    const response = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      hirer.id,
      { decision: 'PROOF_NOT_APPROVED', reason: 'The work is not complete' },
      { 'idempotency-key': `proof-v2-behavior-review-rollback-${questId}` }
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');
    expect(
      (
        await db
          .select({ status: questV2ProofSubmission.submissionStatus })
          .from(questV2ProofSubmission)
          .where(eq(questV2ProofSubmission.id, proofSubmissionId))
      )[0]?.status
    ).toBe('PROOF_PENDING');
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_IN_PROGRESS');
    expect(
      (
        await db
          .select({ status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
      )[0]?.status
    ).toBe('ASSIGNMENT_ACTIVE');
    expect(
      await db
        .select({ id: adminReviewItem.id })
        .from(adminReviewItem)
        .where(eq(adminReviewItem.proofSubmissionId, proofSubmissionId))
    ).toEqual([]);
    expect(
      await db
        .select({ id: auditRecord.id })
        .from(auditRecord)
        .where(eq(auditRecord.resourceId, proofSubmissionId))
    ).toEqual([]);
  });

  it('preserves valid files, identifies failed files, and blocks send until retry', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const upload = spyOn(questV2ProofStorage, 'upload').mockImplementation(
      async (memberId, input) => {
        if (input.name === 'bad-one.jpg')
          throw new FileDimensionsTooLargeError('Image dimensions must not exceed 25 megapixels');
        if (input.name === 'bad-three.pdf') throw new UnsupportedFileTypeError('bad file');
        return {
          bucket: 'proof-v2-behavior-test',
          objectKey: `proof-submissions/${memberId}/${input.name}`,
          contentType: 'application/pdf',
          sizeBytes: input.size,
          fileName: input.name,
        };
      }
    );
    spyOn(questV2ProofStorage, 'delete').mockResolvedValue(undefined);

    const form = new FormData();
    form.append(
      'files',
      new File([new Uint8Array([1, 2, 3])], 'good-zero.pdf', { type: 'application/pdf' })
    );
    form.append(
      'files',
      new File([new Uint8Array([4, 5, 6])], 'bad-one.jpg', { type: 'image/jpeg' })
    );
    form.append(
      'files',
      new File([new Uint8Array([7, 8, 9])], 'good-two.pdf', { type: 'application/pdf' })
    );
    form.append(
      'files',
      new File([new Uint8Array([10, 11, 12])], 'bad-three.pdf', { type: 'application/pdf' })
    );
    const partial = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      form,
      { 'idempotency-key': 'proof-v2-behavior-partial' }
    );
    expect(partial.status).toBe(422);
    expect((await partial.json()).error.code).toBe('PROOF_FILE_DIMENSIONS_TOO_LARGE');
    expect(upload).toHaveBeenCalledTimes(4);

    const [submission] = await db
      .select({ id: questV2ProofSubmission.id })
      .from(questV2ProofSubmission)
      .where(eq(questV2ProofSubmission.questId, questId));
    const attachments = await db
      .select({
        fileId: questV2ProofSubmissionFile.fileId,
        position: questV2ProofSubmissionFile.position,
        status: questV2ProofSubmissionFile.uploadStatus,
        failureCode: questV2ProofSubmissionFile.failureCode,
      })
      .from(questV2ProofSubmissionFile)
      .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submission.id));
    expect(attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'PROOF_FILE_READY', failureCode: null }),
        expect.objectContaining({
          position: 1,
          status: 'PROOF_FILE_FAILED',
          fileId: null,
          failureCode: 'PROOF_FILE_DIMENSIONS_TOO_LARGE',
        }),
        expect.objectContaining({
          position: 3,
          status: 'PROOF_FILE_FAILED',
          fileId: null,
          failureCode: 'PROOF_FILE_TYPE_NOT_SUPPORTED',
        }),
      ])
    );
    expect(attachments).toHaveLength(4);

    const failedRetryForm = new FormData();
    failedRetryForm.append(
      'files',
      new File([new Uint8Array([13, 14, 15])], 'bad-one.jpg', { type: 'image/jpeg' })
    );
    failedRetryForm.set('retryPosition', '1');
    const failedRetry = await request(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}`,
      worker.id,
      failedRetryForm,
      { 'idempotency-key': 'proof-v2-behavior-partial-failed-retry' }
    );
    expect(failedRetry.status).toBe(422);
    const failedRetryAttachments = await db
      .select({
        position: questV2ProofSubmissionFile.position,
        status: questV2ProofSubmissionFile.uploadStatus,
      })
      .from(questV2ProofSubmissionFile)
      .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submission.id));
    expect(failedRetryAttachments).toHaveLength(4);
    expect(failedRetryAttachments.filter(({ status }) => status === 'PROOF_FILE_FAILED')).toEqual(
      expect.arrayContaining([
        { position: 1, status: 'PROOF_FILE_FAILED' },
        { position: 3, status: 'PROOF_FILE_FAILED' },
      ])
    );

    const blocked = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-partial-submit' }
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe('PROOF_FILES_UPLOAD_FAILED');

    const retryForm = new FormData();
    retryForm.append(
      'files',
      new File([new Uint8Array([16, 17, 18])], 'retry-three.pdf', { type: 'application/pdf' })
    );
    retryForm.set('retryPosition', '3');
    const retried = await request(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}`,
      worker.id,
      retryForm,
      { 'idempotency-key': 'proof-v2-behavior-partial-retry' }
    );
    expect(retried.status).toBe(200);
    const retriedData = (await retried.json()).data;
    expect(retriedData.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uploadStatus: 'PROOF_FILE_READY', failureCode: null }),
      ])
    );
    expect(retriedData.files).toHaveLength(4);
    expect(retriedData.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ position: 3, uploadStatus: 'PROOF_FILE_READY' }),
        expect.objectContaining({ position: 1, uploadStatus: 'PROOF_FILE_FAILED' }),
      ])
    );

    const finalRetryForm = new FormData();
    finalRetryForm.append(
      'files',
      new File([new Uint8Array([19, 20, 21])], 'retry-one.pdf', { type: 'application/pdf' })
    );
    finalRetryForm.set('retryPosition', '1');
    const finalRetry = await request(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}`,
      worker.id,
      finalRetryForm,
      { 'idempotency-key': 'proof-v2-behavior-partial-final-retry' }
    );
    expect(finalRetry.status).toBe(200);
    const finalRetryData = (await finalRetry.json()).data;
    expect(finalRetryData.files).toHaveLength(4);
    expect(
      finalRetryData.files.every(
        (entry: { uploadStatus: string }) => entry.uploadStatus === 'PROOF_FILE_READY'
      )
    ).toBe(true);

    const sent = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-partial-submit-retry' }
    );
    expect(sent.status).toBe(200);
    expect((await sent.json()).data.status).toBe('PROOF_PENDING');
  });

  it('waits for GROUP FCFS completion reviews and settles only approved Workers', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({
      v2Participation: 'GROUP',
      headcount: 2,
      proofRequired: false,
      questFundingTotalSatang: 2_000,
      questEscrowSatang: 2_040,
    });
    await reserveQuest(questId, 2_040);
    const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    if (!reservation) throw new Error('Proof-free GROUP fixture reservation was not created');

    const first = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-fcfs-first-${questId}`
    );
    expect(first.response.status).toBe(200);
    expect(first.body.data).toMatchObject({
      confirmed: true,
      reviewStatus: 'COMPLETION_CONFIRMATION_PENDING',
      questStatus: 'QUEST_IN_PROGRESS',
    });
    expect(
      await db
        .select({ workerId: questAssignment.workerId, status: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(eq(questAssignment.questId, questId))
    ).toEqual(
      expect.arrayContaining([
        { workerId: worker.id, status: 'ASSIGNMENT_ACTIVE' },
        { workerId: secondWorker.id, status: 'ASSIGNMENT_ACTIVE' },
      ])
    );
    expect(await listTestQuestEscrowSettlements(reservation.id)).toEqual([]);

    const rejected = await reviewCompletionConfirmation(
      questId,
      first.body.data.id,
      'COMPLETION_CONFIRMATION_NOT_APPROVED',
      'The work is not complete',
      `proof-v2-behavior-fcfs-reject-${questId}`
    );
    expect(rejected.status).toBe(200);
    expect((await rejected.json()).data.questStatus).toBe('QUEST_IN_PROGRESS');
    expect(await listTestQuestEscrowSettlements(reservation.id)).toEqual([]);
    expect(
      await db
        .select({
          proofSubmissionId: adminReviewItem.proofSubmissionId,
          completionConfirmationId: adminReviewItem.completionConfirmationId,
          reason: adminReviewItem.reason,
          evidenceReferences: adminReviewItem.evidenceReferences,
        })
        .from(adminReviewItem)
        .where(eq(adminReviewItem.questId, questId))
    ).toEqual([
      {
        proofSubmissionId: null,
        completionConfirmationId: first.body.data.id,
        reason: 'The work is not complete',
        evidenceReferences: [],
      },
    ]);
    const hirerConfirmations = await request(
      'GET',
      `/api/v2/quests/${questId}/completion-confirmations`,
      hirer.id
    );
    expect((await hirerConfirmations.json()).data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.body.data.id,
          reviewReason: 'The work is not complete',
        }),
      ])
    );
    const submitterConfirmations = await request(
      'GET',
      `/api/v2/quests/${questId}/completion-confirmations`,
      worker.id
    );
    expect((await submitterConfirmations.json()).data.items).toEqual([
      expect.objectContaining({
        id: first.body.data.id,
        reviewReason: 'The work is not complete',
      }),
    ]);
    const otherWorkerConfirmations = await request(
      'GET',
      `/api/v2/quests/${questId}/completion-confirmations`,
      secondWorker.id
    );
    expect((await otherWorkerConfirmations.json()).data.items).toEqual([]);

    const second = await createCompletionConfirmation(
      questId,
      secondWorker.id,
      `proof-v2-behavior-fcfs-second-${questId}`
    );
    expect(second.response.status).toBe(200);
    const approved = await reviewCompletionConfirmation(
      questId,
      second.body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      `proof-v2-behavior-fcfs-approve-${questId}`
    );
    expect(approved.status).toBe(200);
    expect((await approved.json()).data.questStatus).toBe('QUEST_COMPLETED');
    expect(
      await db
        .select()
        .from(questV2ProofSubmission)
        .where(eq(questV2ProofSubmission.questId, questId))
    ).toEqual([]);
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_COMPLETED');
    const assignments = await db
      .select({ workerId: questAssignment.workerId, status: questAssignment.assignmentStatus })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId));
    expect(assignments).toHaveLength(2);
    expect(assignments).toEqual(
      expect.arrayContaining([
        { workerId: worker.id, status: 'ASSIGNMENT_INCOMPLETE' },
        { workerId: secondWorker.id, status: 'ASSIGNMENT_COMPLETED' },
      ])
    );
    expect(
      await db
        .select()
        .from(questV2ProofSubmission)
        .where(eq(questV2ProofSubmission.questId, questId))
    ).toEqual([]);
    expect(await readTestQuestEscrow({ ownerUserId: hirer.id, questId })).toMatchObject({
      status: 'ACTIVE',
      remainingSatang: 1_020,
    });
    expect(
      (
        await db
          .select({ holdAt: quest.moneyHoldStartedAt })
          .from(quest)
          .where(eq(quest.id, questId))
      )[0]?.holdAt
    ).toBeInstanceOf(Date);
    expect(await listTestQuestEscrowSettlements(reservation.id)).toEqual([
      expect.objectContaining({ recipientUserId: secondWorker.id, recipientAmountSatang: 1_000 }),
    ]);
  });

  it('serializes concurrent proof-free GROUP FCFS confirmations', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({
      v2Participation: 'GROUP',
      headcount: 2,
      proofRequired: false,
      questFundingTotalSatang: 2_000,
      questEscrowSatang: 2_040,
    });
    await reserveQuest(questId, 2_040);
    const confirmations = await Promise.all(
      [worker, secondWorker].map((member, index) =>
        createCompletionConfirmation(
          questId,
          member.id,
          `proof-v2-behavior-concurrent-confirm-${index}-${questId}`
        )
      )
    );
    expect(confirmations.map(({ response }) => response.status)).toEqual([200, 200]);
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_IN_PROGRESS');
    for (const confirmation of confirmations) {
      const review = await reviewCompletionConfirmation(
        questId,
        confirmation.body.data.id,
        'COMPLETION_CONFIRMATION_APPROVED',
        undefined,
        `proof-v2-behavior-concurrent-review-${confirmation.body.data.id}`
      );
      expect(review.status).toBe(200);
    }
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_COMPLETED');
    const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    if (!reservation)
      throw new Error('Concurrent confirmation fixture reservation was not created');
    expect(await listTestQuestEscrowSettlements(reservation.id)).toHaveLength(2);
  });

  it('fails GROUP FCFS only after every Worker confirmation is not approved', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({
      v2Participation: 'GROUP',
      headcount: 2,
      proofRequired: false,
      questFundingTotalSatang: 2_000,
      questEscrowSatang: 2_040,
    });
    await reserveQuest(questId, 2_040);
    const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    if (!reservation) throw new Error('GROUP FCFS behavior fixture reservation was not created');
    for (const [index, member] of [worker, secondWorker].entries()) {
      const { response, body } = await createCompletionConfirmation(
        questId,
        member.id,
        `proof-v2-behavior-fcfs-all-fail-confirm-${index}-${questId}`
      );
      expect(response.status).toBe(200);
      const rejected = await reviewCompletionConfirmation(
        questId,
        body.data.id,
        'COMPLETION_CONFIRMATION_NOT_APPROVED',
        'The work is not complete',
        `proof-v2-behavior-fcfs-all-fail-review-${index}-${questId}`
      );
      expect(rejected.status).toBe(200);
      expect((await rejected.json()).data.questStatus).toBe(
        index === 0 ? 'QUEST_IN_PROGRESS' : 'QUEST_FAILED'
      );
    }
    expect(
      await db
        .select({ status: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(eq(questAssignment.questId, questId))
    ).toEqual([{ status: 'ASSIGNMENT_INCOMPLETE' }, { status: 'ASSIGNMENT_INCOMPLETE' }]);
    expect(await listTestQuestEscrowSettlements(reservation.id)).toEqual([]);
  });

  it('settles an underfilled 3-of-4 GROUP FCFS Quest against the fixed Escrow fee pool', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest(
      {
        v2Participation: 'GROUP',
        v2Mode: 'FIRST_COME_FIRST_SERVED',
        headcount: 4,
        proofRequired: false,
        questFundingTotalSatang: 4_000,
        questEscrowSatang: 4_080,
        platformFeePerWorkerSatang: 20,
      },
      [worker.id, secondWorker.id, unrelated.id]
    );
    await reserveQuest(questId, 4_080);
    const assignments = await db
      .select({
        id: questAssignment.id,
        workerId: questAssignment.workerId,
        createdAt: questAssignment.createdAt,
      })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId))
      .orderBy(asc(questAssignment.createdAt));
    const now = new Date();
    const decisionId = randomUUID();
    await db.insert(questV2UnderfilledDecision).values({
      id: decisionId,
      questId,
      activeWorkerCount: 3,
      workerRewardPoolSatang: 4_000,
      state: 'UNDERFILLED_COMPLETED',
      decision: 'PROCEED',
      decisionExpiresAt: now,
      consentExpiresAt: now,
      detectedAt: now,
      resolvedAt: now,
    });
    await db.insert(questV2UnderfilledConsent).values(
      assignments.map((assignment, index) => ({
        decisionId,
        questId,
        assignmentId: assignment.id,
        workerId: assignment.workerId,
        rewardSatang: index === 0 ? 1_334 : 1_333,
        decision: 'ACCEPT' as const,
        respondedAt: now,
        createdAt: assignment.createdAt,
      }))
    );
    const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    if (!reservation) throw new Error('Underfilled behavior fixture reservation was not created');

    const confirmations = await Promise.all(
      [worker, secondWorker, unrelated].map((member, index) =>
        createCompletionConfirmation(
          questId,
          member.id,
          `proof-v2-behavior-underfilled-confirm-${index}-${questId}`
        )
      )
    );
    expect(confirmations.map(({ response }) => response.status)).toEqual([200, 200, 200]);
    expect(confirmations.map(({ body }) => body.data.reviewStatus)).toEqual([
      'COMPLETION_CONFIRMATION_PENDING',
      'COMPLETION_CONFIRMATION_PENDING',
      'COMPLETION_CONFIRMATION_PENDING',
    ]);
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_IN_PROGRESS');
    expect(await listTestQuestEscrowSettlements(reservation.id)).toEqual([]);
    const reviews = await Promise.all(
      confirmations.map(({ body }, index) =>
        reviewCompletionConfirmation(
          questId,
          body.data.id,
          'COMPLETION_CONFIRMATION_APPROVED',
          undefined,
          `proof-v2-behavior-underfilled-review-${index}-${questId}`
        )
      )
    );
    expect(reviews.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_COMPLETED');

    const settlements = await listTestQuestEscrowSettlements(reservation.id);
    expect(settlements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientUserId: worker.id,
          recipientAmountSatang: 1_334,
          platformFeeSatang: 27,
        }),
        expect.objectContaining({
          recipientUserId: secondWorker.id,
          recipientAmountSatang: 1_333,
          platformFeeSatang: 27,
        }),
        expect.objectContaining({
          recipientUserId: unrelated.id,
          recipientAmountSatang: 1_333,
          platformFeeSatang: 26,
        }),
      ])
    );
    expect(
      settlements.reduce((total, settlement) => total + settlement.recipientAmountSatang, 0)
    ).toBe(4_000);
    expect(settlements.reduce((total, settlement) => total + settlement.platformFeeSatang, 0)).toBe(
      80
    );

    const ledgerTransactionIds = settlements.map(({ ledgerTransactionId }) => ledgerTransactionId);
    const ledgerPostings = await listTestLedgerPostings(ledgerTransactionIds);
    expect(ledgerPostings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: 'EARNINGS',
          ownerUserId: worker.id,
          amountSatang: 1_334,
        }),
        expect.objectContaining({
          accountType: 'EARNINGS',
          ownerUserId: secondWorker.id,
          amountSatang: 1_333,
        }),
        expect.objectContaining({
          accountType: 'EARNINGS',
          ownerUserId: unrelated.id,
          amountSatang: 1_333,
        }),
      ])
    );
    expect(ledgerPostings.reduce((total, posting) => total + posting.amountSatang, 0)).toBe(0);
  });

  it('covers SINGLE Candidate draft deletion, dueAt, and Assignment authorization', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const candidateQuest = await createQuest({
      mode: 'CANDIDATE',
      v2Mode: 'CANDIDATE',
      v2Participation: 'SINGLE',
      participation: 'SOLO',
      headcount: 1,
    });
    const draft = await jsonRequest(
      'POST',
      `/api/v2/quests/${candidateQuest.questId}/proof-submissions`,
      worker.id,
      { description: 'candidate draft' },
      { 'idempotency-key': 'proof-v2-behavior-single-candidate-create' }
    );
    expect(draft.status).toBe(201);
    const draftData = (await draft.json()).data as { id: string };

    const unauthorized = await jsonRequest(
      'POST',
      `/api/v2/quests/${candidateQuest.questId}/proof-submissions`,
      secondWorker.id,
      { description: 'not assigned' },
      { 'idempotency-key': 'proof-v2-behavior-single-candidate-unauthorized' }
    );
    expect(unauthorized.status).toBe(403);
    expect((await unauthorized.json()).error.code).toBe('PROOF_SUBMISSION_NOT_ALLOWED');

    const deleted = await request(
      'DELETE',
      `/api/v2/quests/${candidateQuest.questId}/proof-submissions/${draftData.id}`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-single-candidate-delete' }
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data).toMatchObject({
      deleted: true,
      proofSubmissionId: draftData.id,
    });
    const ownList = await request(
      'GET',
      `/api/v2/quests/${candidateQuest.questId}/proof-submissions`,
      worker.id
    );
    expect((await ownList.json()).data.items).toEqual([]);

    const dueQuest = await createQuest({
      startTime: new Date('2019-01-01T00:00:00.000Z'),
      dueAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const due = await jsonRequest(
      'POST',
      `/api/v2/quests/${dueQuest.questId}/proof-submissions`,
      worker.id,
      { description: 'too late' },
      { 'idempotency-key': 'proof-v2-behavior-due-at' }
    );
    expect(due.status).toBe(409);
    expect((await due.json()).error.code).toBe('PROOF_DUE_AT_PASSED');
  });

  it('accepts a Proof Submission at the exact dueAt boundary', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const dueAt = new Date('2030-01-01T11:00:00.000Z');
    const { questId } = await createQuest({ dueAt });
    const proofFileId = await createFile(worker.id);
    const result = await createQuestV2ProofSubmission(
      worker.id,
      questId,
      { description: 'exact boundary', fileIds: [proofFileId] },
      `proof-v2-behavior-exact-due-${questId}`,
      dueAt
    );
    expect('outcome' in result).toBe(false);
    if (!('outcome' in result)) expect(result.submittedAt).toBeNull();
  });

  it('waits for a Hirer decision before settling proof-free SINGLE completion', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    await reserveQuest(questId, 1_020);
    const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    if (!reservation)
      throw new Error('Proof-free SINGLE behavior fixture reservation was not created');

    const { response: confirmed, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-single-confirm-${questId}`
    );
    expect(confirmed.status).toBe(200);
    expect(body.data).toMatchObject({
      reviewStatus: 'COMPLETION_CONFIRMATION_PENDING',
      questStatus: 'QUEST_IN_PROGRESS',
      reviewDeadlineAt: expect.any(String),
    });
    expect(
      (
        await db
          .select({ status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
      )[0]?.status
    ).toBe('ASSIGNMENT_ACTIVE');
    expect(await listTestQuestEscrowSettlements(reservation.id)).toEqual([]);
    const missingReason = await reviewCompletionConfirmation(
      questId,
      body.data.id,
      'COMPLETION_CONFIRMATION_NOT_APPROVED',
      undefined,
      `proof-v2-behavior-single-missing-reason-${questId}`
    );
    expect(missingReason.status).toBe(400);
    expect((await missingReason.json()).error.code).toBe('COMPLETION_NOT_APPROVED_REASON_REQUIRED');
    const approvalCommandId = `proof-v2-behavior-single-approve-${questId}`;
    const approved = await reviewCompletionConfirmation(
      questId,
      body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      approvalCommandId
    );
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.data.questStatus).toBe('QUEST_COMPLETED');
    const replay = await reviewCompletionConfirmation(
      questId,
      body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      approvalCommandId
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(approvedBody);
    expect(await listTestQuestEscrowSettlements(reservation.id)).toHaveLength(1);
    const [stateChangeAudit] = await db
      .select()
      .from(auditRecord)
      .where(
        and(
          eq(auditRecord.action, 'QUEST_STATE_CHANGED'),
          eq(auditRecord.resourceType, 'QUEST'),
          eq(auditRecord.resourceId, questId)
        )
      );
    expect(stateChangeAudit).toMatchObject({
      actorType: 'MEMBER',
      actorUserId: hirer.id,
      newValue: { state: 'QUEST_COMPLETED' },
    });
    expect(
      await db
        .select()
        .from(questV2ProofSubmission)
        .where(eq(questV2ProofSubmission.questId, questId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(questV2ProofSubmissionFile)
        .where(eq(questV2ProofSubmissionFile.proofSubmissionId, questId))
    ).toEqual([]);
    expect(
      (
        await db
          .select({ status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
      )[0]?.status
    ).toBe('ASSIGNMENT_COMPLETED');
  });

  it("replaces the submitter's unsent Draft on create and refuses a create after send", async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const first = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      { description: 'lost draft' },
      { 'idempotency-key': `proof-v2-behavior-replace-first-${questId}` }
    );
    expect(first.status).toBe(201);
    const firstId = ((await first.json()).data as { id: string }).id;

    const proofFileId = await createFile(worker.id);
    const replacement = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      { description: 'replacement draft', fileIds: [proofFileId] },
      { 'idempotency-key': `proof-v2-behavior-replace-second-${questId}` }
    );
    expect(replacement.status).toBe(201);
    const replacementData = (await replacement.json()).data as { id: string; description: string };
    expect(replacementData.id).not.toBe(firstId);
    expect(replacementData.description).toBe('replacement draft');
    const rows = await db
      .select()
      .from(questV2ProofSubmission)
      .where(eq(questV2ProofSubmission.questId, questId));
    expect(rows.map(({ id }) => id)).toEqual([replacementData.id]);

    const sent = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${replacementData.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': `proof-v2-behavior-replace-send-${questId}` }
    );
    expect(sent.status).toBe(200);
    const afterSend = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      { description: 'after send' },
      { 'idempotency-key': `proof-v2-behavior-replace-after-send-${questId}` }
    );
    expect(afterSend.status).toBe(409);
    expect((await afterSend.json()).error.code).toBe('PROOF_SUBMISSION_ALREADY_EXISTS');
  });

  it('fails proof-free SINGLE in both modes and GROUP Candidate after Hirer non-approval', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const cases = [
      {
        name: 'single FCFS',
        overrides: { proofRequired: false },
        workerIds: [worker.id],
        escrowSatang: 1_020,
      },
      {
        name: 'single Candidate',
        overrides: { proofRequired: false, v2Mode: 'CANDIDATE' as const },
        workerIds: [worker.id],
        escrowSatang: 1_020,
      },
      {
        name: 'GROUP Candidate',
        overrides: {
          proofRequired: false,
          mode: 'CANDIDATE' as const,
          v2Mode: 'CANDIDATE' as const,
          v2Participation: 'GROUP' as const,
          headcount: 2,
          questFundingTotalSatang: 2_000,
          questEscrowSatang: 2_040,
        },
        workerIds: [worker.id, secondWorker.id],
        escrowSatang: 2_040,
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const { questId } = await createQuest(entry.overrides, entry.workerIds);
      if (entry.name === 'GROUP Candidate') {
        const teamId = randomUUID();
        await db.insert(questCandidateTeamV2).values({
          id: teamId,
          questId,
          leaderId: worker.id,
          name: 'Selected Team',
          headcount: 2,
          state: 'TEAM_SELECTED',
        });
        await db.insert(questCandidateTeamV2Member).values([
          { teamId, memberId: worker.id },
          { teamId, memberId: secondWorker.id },
        ]);
      }
      await reserveQuest(questId, entry.escrowSatang);
      const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
      if (!reservation) throw new Error(`${entry.name} Quest Escrow was not created`);

      const { response: confirmed, body } = await createCompletionConfirmation(
        questId,
        worker.id,
        `proof-v2-behavior-non-approval-confirm-${index}-${questId}`
      );
      expect(confirmed.status).toBe(200);
      const rejected = await reviewCompletionConfirmation(
        questId,
        body.data.id,
        'COMPLETION_CONFIRMATION_NOT_APPROVED',
        'The work is not complete',
        `proof-v2-behavior-non-approval-review-${index}-${questId}`
      );
      expect(rejected.status).toBe(200);
      expect((await rejected.json()).data.questStatus).toBe('QUEST_FAILED');
      expect(
        (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
          ?.status
      ).toBe('QUEST_FAILED');
      expect(
        await db
          .select({ status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
      ).toEqual(entry.workerIds.map(() => ({ status: 'ASSIGNMENT_INCOMPLETE' })));
      expect(await listTestQuestEscrowSettlements(reservation.id)).toEqual([]);
      expect(
        await db
          .select({
            proofSubmissionId: adminReviewItem.proofSubmissionId,
            completionConfirmationId: adminReviewItem.completionConfirmationId,
            reason: adminReviewItem.reason,
            evidenceReferences: adminReviewItem.evidenceReferences,
          })
          .from(adminReviewItem)
          .where(eq(adminReviewItem.questId, questId))
      ).toEqual([
        {
          proofSubmissionId: null,
          completionConfirmationId: body.data.id,
          reason: 'The work is not complete',
          evidenceReferences: [],
        },
      ]);
      expect(
        await db
          .select()
          .from(questV2ProofSubmission)
          .where(eq(questV2ProofSubmission.questId, questId))
      ).toEqual([]);
    }
  });

  it('auto-approves a proof-free Completion Confirmation after 24 hours', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    await reserveQuest(questId, 1_020);
    const { response, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-auto-approval-confirm-${questId}`
    );
    expect(response.status).toBe(200);
    const deadline = new Date(body.data.reviewDeadlineAt);
    expect(
      await autoApproveDueQuestV2CompletionConfirmations(new Date(deadline.getTime() - 1), 10)
    ).not.toContain(body.data.id);
    expect(await autoApproveDueQuestV2CompletionConfirmations(deadline, 10)).toContain(
      body.data.id
    );
    expect(
      (
        await db
          .select({ status: questV2CompletionConfirmation.reviewStatus })
          .from(questV2CompletionConfirmation)
          .where(eq(questV2CompletionConfirmation.id, body.data.id))
      )[0]?.status
    ).toBe('COMPLETION_CONFIRMATION_APPROVED');
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_COMPLETED');
  });

  it('allows only the Hirer to review and only the Hirer or submitter to read confirmations', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    await reserveQuest(questId, 1_020);
    const { response: confirmation, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-confirmation-auth-${questId}`
    );
    expect(confirmation.status).toBe(200);

    const submitterList = await request(
      'GET',
      `/api/v2/quests/${questId}/completion-confirmations`,
      worker.id
    );
    expect(submitterList.status).toBe(200);
    expect((await submitterList.json()).data.items).toEqual([
      expect.objectContaining({ id: body.data.id }),
    ]);
    const unrelatedList = await request(
      'GET',
      `/api/v2/quests/${questId}/completion-confirmations`,
      unrelated.id
    );
    expect(unrelatedList.status).toBe(403);
    expect((await unrelatedList.json()).error.code).toBe('COMPLETION_CONFIRMATION_NOT_ALLOWED');

    const workerReview = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmations/${body.data.id}/review`,
      worker.id,
      { decision: 'COMPLETION_CONFIRMATION_APPROVED' },
      { 'idempotency-key': `proof-v2-behavior-confirmation-auth-review-${questId}` }
    );
    expect(workerReview.status).toBe(403);
    expect((await workerReview.json()).error.code).toBe('COMPLETION_REVIEW_NOT_ALLOWED');
    expect(
      (
        await db
          .select({ status: questV2CompletionConfirmation.reviewStatus })
          .from(questV2CompletionConfirmation)
          .where(eq(questV2CompletionConfirmation.id, body.data.id))
      )[0]?.status
    ).toBe('COMPLETION_CONFIRMATION_PENDING');
  });

  it('returns a Completion Confirmation review conflict when the Quest is terminal', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    await reserveQuest(questId, 1_020);
    const { response: confirmation, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-terminal-review-${questId}`
    );
    expect(confirmation.status).toBe(200);
    await db.update(quest).set({ questStatus: 'QUEST_COMPLETED' }).where(eq(quest.id, questId));

    const review = await reviewCompletionConfirmation(
      questId,
      body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      `proof-v2-behavior-terminal-review-command-${questId}`
    );
    expect(review.status).toBe(409);
    expect((await review.json()).error.code).toBe('COMPLETION_CONFIRMATION_NOT_REVIEWABLE');
  });

  it('keeps concurrent Hirer decisions to one final Completion Confirmation outcome', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    await reserveQuest(questId, 1_020);
    const { response: confirmation, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-concurrent-review-confirm-${questId}`
    );
    expect(confirmation.status).toBe(200);
    const path = `/api/v2/quests/${questId}/completion-confirmations/${body.data.id}/review`;
    const [approval, nonApproval] = await Promise.all([
      jsonRequest(
        'POST',
        path,
        hirer.id,
        { decision: 'COMPLETION_CONFIRMATION_APPROVED' },
        { 'idempotency-key': `proof-v2-behavior-concurrent-approve-${questId}` }
      ),
      jsonRequest(
        'POST',
        path,
        hirer.id,
        {
          decision: 'COMPLETION_CONFIRMATION_NOT_APPROVED',
          reason: 'The work is not complete',
        },
        { 'idempotency-key': `proof-v2-behavior-concurrent-reject-${questId}` }
      ),
    ]);
    expect([approval.status, nonApproval.status].sort()).toEqual([200, 409]);
    const winner = approval.status === 200 ? approval : nonApproval;
    const conflictResponse = approval.status === 409 ? approval : nonApproval;
    expect((await conflictResponse.json()).error.code).toBe('COMPLETION_CONFIRMATION_NOT_PENDING');
    const winningDecision = (await winner.json()).data.confirmation.reviewStatus;
    expect(winningDecision).toBe(
      approval.status === 200
        ? 'COMPLETION_CONFIRMATION_APPROVED'
        : 'COMPLETION_CONFIRMATION_NOT_APPROVED'
    );
    expect(
      (
        await db
          .select({ status: questV2CompletionConfirmation.reviewStatus })
          .from(questV2CompletionConfirmation)
          .where(eq(questV2CompletionConfirmation.id, body.data.id))
      )[0]?.status
    ).toBe(winningDecision);
    expect(
      await db
        .select({ id: adminReviewItem.id })
        .from(adminReviewItem)
        .where(eq(adminReviewItem.completionConfirmationId, body.data.id))
    ).toHaveLength(winningDecision === 'COMPLETION_CONFIRMATION_NOT_APPROVED' ? 1 : 0);
  });

  it('serializes concurrent Draft creates into one Draft', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const responses = await Promise.all([
      jsonRequest(
        'POST',
        `/api/v2/quests/${questId}/proof-submissions`,
        worker.id,
        { description: 'first command' },
        { 'idempotency-key': 'proof-v2-behavior-concurrent-first' }
      ),
      jsonRequest(
        'POST',
        `/api/v2/quests/${questId}/proof-submissions`,
        worker.id,
        { description: 'second command' },
        { 'idempotency-key': 'proof-v2-behavior-concurrent-second' }
      ),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(
      await db
        .select()
        .from(questV2ProofSubmission)
        .where(eq(questV2ProofSubmission.questId, questId))
    ).toHaveLength(1);
  });

  it('rolls back proof-free completion when the Work Conversation transition fails', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    await reserveQuest(questId, 1_020);
    spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
      async (_transaction, transition) => {
        if (transition.type === 'questBecameReadOnly') throw new Error('chat unavailable');
        return { conversationId: 'proof-v2-behavior-rollback', outcome: 'APPLIED' as const };
      }
    );

    const { response: confirmation, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-rollback-confirm-${questId}`
    );
    expect(confirmation.status).toBe(200);
    const response = await reviewCompletionConfirmation(
      questId,
      body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      `proof-v2-behavior-rollback-review-${questId}`
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('QUEST_COMPLETION_UNAVAILABLE');
    expect(
      await db
        .select({ reviewStatus: questV2CompletionConfirmation.reviewStatus })
        .from(questV2CompletionConfirmation)
        .where(eq(questV2CompletionConfirmation.questId, questId))
    ).toEqual([{ reviewStatus: 'COMPLETION_CONFIRMATION_PENDING' }]);
    expect(
      (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
        ?.status
    ).toBe('QUEST_IN_PROGRESS');
    expect(
      (
        await db
          .select({ status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
      )[0]?.status
    ).toBe('ASSIGNMENT_ACTIVE');
  });

  it('closes the real Work Conversation at proof-free completion', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    const [assignment] = await db
      .select({ id: questAssignment.id, workerId: questAssignment.workerId })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId));
    if (!assignment) throw new Error('Behavior fixture Assignment was not created');
    const productionWriter = createWorkChatMembershipWriter();
    const acceptedAt = new Date();
    await db.transaction((transaction) =>
      productionWriter.applyQuestTransition(transaction, {
        producer: 'QUEST_ASSIGNMENT_V2',
        type: 'workersAccepted',
        commandId: `proof-v2-behavior-chat-accepted-${questId}`,
        eventId: `proof-v2-behavior-chat-accepted-event-${questId}`,
        questId,
        actorId: hirer.id,
        occurredAt: acceptedAt.toISOString(),
        hirerId: hirer.id,
        workers: [
          {
            workerId: assignment.workerId,
            assignmentId: assignment.id,
            joinedAt: acceptedAt.toISOString(),
          },
        ],
      })
    );
    applySpy?.mockRestore();
    await reserveQuest(questId, 1_020);

    const { response, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-real-chat-confirm-${questId}`
    );
    expect(response.status).toBe(200);
    const [pendingConversation] = await db
      .select({ readOnlyAt: chatConversation.readOnlyAt })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    expect(pendingConversation?.readOnlyAt).toBeNull();
    const approved = await reviewCompletionConfirmation(
      questId,
      body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      `proof-v2-behavior-real-chat-review-${questId}`
    );
    expect(approved.status).toBe(200);
    const [conversation] = await db
      .select({
        id: chatConversation.id,
        readOnlyAt: chatConversation.readOnlyAt,
        questStatus: chatConversation.questStatus,
      })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    expect(conversation?.readOnlyAt).toBeInstanceOf(Date);
    expect(conversation?.questStatus).toBe('QUEST_COMPLETED');
    expect(
      await db
        .select()
        .from(chatMembership)
        .where(eq(chatMembership.conversationId, conversation!.id))
    ).toHaveLength(2);
  });

  it('closes a completed Worker membership during partial Proof settlement', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest(
      {
        v2Mode: 'FIRST_COME_FIRST_SERVED',
        v2Participation: 'GROUP',
        questFundingTotalSatang: 2_000,
        questEscrowSatang: 2_040,
      },
      [worker.id, secondWorker.id]
    );
    const assignments = await db
      .select({ id: questAssignment.id, workerId: questAssignment.workerId })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId));
    const workerAssignment = assignments.find(({ workerId }) => workerId === worker.id);
    const secondWorkerAssignment = assignments.find(({ workerId }) => workerId === secondWorker.id);
    if (!workerAssignment || !secondWorkerAssignment)
      throw new Error('Behavior fixture Assignments were not created');

    const productionWriter = createWorkChatMembershipWriter();
    const acceptedAt = new Date();
    await db.transaction((transaction) =>
      productionWriter.applyQuestTransition(transaction, {
        producer: 'QUEST_ASSIGNMENT_V2',
        type: 'workersAccepted',
        commandId: `proof-v2-behavior-partial-chat-accepted-${questId}`,
        eventId: `proof-v2-behavior-partial-chat-accepted-event-${questId}`,
        questId,
        actorId: hirer.id,
        occurredAt: acceptedAt.toISOString(),
        hirerId: hirer.id,
        workers: [
          {
            workerId: workerAssignment.workerId,
            assignmentId: workerAssignment.id,
            joinedAt: acceptedAt.toISOString(),
          },
          {
            workerId: secondWorkerAssignment.workerId,
            assignmentId: secondWorkerAssignment.id,
            joinedAt: acceptedAt.toISOString(),
          },
        ],
      })
    );
    const { proofSubmissionId } = await createSentProofForQuest(questId, worker.id);
    await reserveQuest(questId, 2_040);
    applySpy?.mockRestore();

    const response = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      hirer.id,
      { decision: 'PROOF_APPROVED' },
      { 'idempotency-key': `proof-v2-behavior-partial-chat-review-${questId}` }
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.questStatus).toBe('QUEST_IN_PROGRESS');

    const [conversation] = await db
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    if (!conversation) throw new Error('Behavior fixture Work Conversation was not created');
    const [completedMembership] = await db
      .select({ leftAt: chatMembership.leftAt })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.conversationId, conversation.id),
          eq(chatMembership.assignmentId, workerAssignment.id)
        )
      );
    const [activeMembership] = await db
      .select({ leftAt: chatMembership.leftAt })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.conversationId, conversation.id),
          eq(chatMembership.assignmentId, secondWorkerAssignment.id)
        )
      );
    expect(completedMembership?.leftAt).toBeInstanceOf(Date);
    expect(activeMembership?.leftAt).toBeNull();
  });

  it('closes the completed Worker membership during partial proof-free settlement', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest(
      {
        proofRequired: false,
        v2Mode: 'FIRST_COME_FIRST_SERVED',
        v2Participation: 'GROUP',
        questFundingTotalSatang: 2_000,
        questEscrowSatang: 2_040,
      },
      [worker.id, secondWorker.id]
    );
    const [assignment] = await db
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, worker.id)));
    if (!assignment) throw new Error('Behavior fixture Assignment was not created');
    await reserveQuest(questId, 2_040);
    const transitions: unknown[] = [];
    spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
      async (_transaction, transition) => {
        transitions.push(transition);
        return {
          conversationId: 'proof-v2-behavior-partial-proof-free',
          outcome: 'APPLIED' as const,
        };
      }
    );

    const { response, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-partial-proof-free-${questId}`
    );
    expect(response.status).toBe(200);
    const approved = await reviewCompletionConfirmation(
      questId,
      body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      `proof-v2-behavior-partial-proof-free-review-${questId}`
    );
    expect(approved.status).toBe(200);
    expect((await approved.json()).data.questStatus).toBe('QUEST_IN_PROGRESS');
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'workerBecameInactive',
          assignmentId: assignment.id,
          assignmentStatus: 'ASSIGNMENT_COMPLETED',
        }),
      ])
    );
  });

  it('cleans replay-only uploads and rejects changed multipart metadata', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const upload = spyOn(questV2ProofStorage, 'upload').mockImplementation(
      async (memberId, input) => ({
        bucket: 'proof-v2-behavior-test',
        objectKey: `proof-submissions/${memberId}/${randomUUID()}`,
        contentType: 'application/pdf',
        sizeBytes: input.size,
        fileName: input.name,
      })
    );
    const remove = spyOn(questV2ProofStorage, 'delete').mockResolvedValue(undefined);

    const firstForm = new FormData();
    firstForm.append(
      'files',
      new File([new Uint8Array([1, 2, 3])], 'proof.pdf', { type: 'application/pdf' })
    );
    const first = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      firstForm,
      { 'idempotency-key': `proof-v2-behavior-multipart-replay-${questId}` }
    );
    expect(first.status).toBe(201);

    const replayForm = new FormData();
    replayForm.append(
      'files',
      new File([new Uint8Array([1, 2, 3])], 'proof.pdf', { type: 'application/pdf' })
    );
    const replay = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      replayForm,
      { 'idempotency-key': `proof-v2-behavior-multipart-replay-${questId}` }
    );
    expect(replay.status).toBe(201);
    expect(remove).toHaveBeenCalledTimes(1);

    const changedTypeForm = new FormData();
    changedTypeForm.append(
      'files',
      new File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' })
    );
    const changedType = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      changedTypeForm,
      { 'idempotency-key': `proof-v2-behavior-multipart-replay-${questId}` }
    );
    expect(changedType.status).toBe(409);
    expect((await changedType.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(upload).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('records failed object cleanup for a lifecycle-worker retry', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const upload = spyOn(questV2ProofStorage, 'upload').mockImplementation(
      async (memberId, input) => ({
        bucket: 'proof-v2-behavior-test',
        objectKey: `proof-submissions/${memberId}/${randomUUID()}`,
        contentType: 'application/pdf',
        sizeBytes: input.size,
        fileName: input.name,
      })
    );
    const remove = spyOn(questV2ProofStorage, 'delete').mockRejectedValueOnce(
      new Error('temporary cleanup failure')
    );
    const form = new FormData();
    form.append(
      'files',
      new File([new Uint8Array([1, 2, 3])], 'cleanup.pdf', { type: 'application/pdf' })
    );
    const key = `proof-v2-behavior-cleanup-${questId}`;
    const first = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      form,
      { 'idempotency-key': key }
    );
    expect(first.status).toBe(201);

    const replayForm = new FormData();
    replayForm.append(
      'files',
      new File([new Uint8Array([1, 2, 3])], 'cleanup.pdf', { type: 'application/pdf' })
    );
    const replay = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      replayForm,
      { 'idempotency-key': key }
    );
    expect(replay.status).toBe(201);
    const pending = await db
      .select({
        id: questCommand.id,
        status: questCommand.processingStatus,
      })
      .from(questCommand)
      .where(
        and(
          eq(questCommand.questId, questId),
          eq(questCommand.operationScope, 'quest.v2.proof.upload-cleanup'),
          eq(questCommand.processingStatus, 'PROCESSING')
        )
      );
    expect(pending).toHaveLength(1);

    remove.mockResolvedValue(undefined);
    expect(await retryQuestV2ProofUploadCleanup()).toBe(1);
    expect(
      await db
        .select({ status: questCommand.processingStatus })
        .from(questCommand)
        .where(eq(questCommand.id, pending[0]!.id))
    ).toEqual([{ status: 'COMPLETED' }]);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('enforces the five-file limit and the storage size boundary', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const countQuest = await createQuest();
    const tooManyForm = new FormData();
    for (let index = 0; index < 6; index += 1) {
      tooManyForm.append(
        'files',
        new File([new Uint8Array([index + 1])], `proof-${index}.pdf`, { type: 'application/pdf' })
      );
    }
    const tooMany = await request(
      'POST',
      `/api/v2/quests/${countQuest.questId}/proof-submissions`,
      worker.id,
      tooManyForm,
      { 'idempotency-key': `proof-v2-behavior-file-count-${countQuest.questId}` }
    );
    expect(tooMany.status).toBe(400);

    const sizeQuest = await createQuest();
    spyOn(questV2ProofStorage, 'upload').mockRejectedValue(
      new FileTooLargeError('Attachment must be 10 MB or smaller')
    );
    const tooLargeForm = new FormData();
    tooLargeForm.append(
      'files',
      new File([new Uint8Array([1])], 'large.pdf', { type: 'application/pdf' })
    );
    const tooLarge = await request(
      'POST',
      `/api/v2/quests/${sizeQuest.questId}/proof-submissions`,
      worker.id,
      tooLargeForm,
      { 'idempotency-key': `proof-v2-behavior-file-size-${sizeQuest.questId}` }
    );
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).error.code).toBe('PROOF_FILE_TOO_LARGE');
  });

  it('uses the real multipart content validator for an invalid declared file type', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const invalidTypeForm = new FormData();
    invalidTypeForm.append(
      'files',
      new File(['not-a-pdf'], 'invalid.pdf', { type: 'application/pdf' })
    );
    const response = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      invalidTypeForm,
      { 'idempotency-key': `proof-v2-behavior-invalid-type-${questId}` }
    );
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe('PROOF_FILE_TYPE_NOT_SUPPORTED');
  });

  it('serializes concurrent send commands so only one command locks the Draft', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const proofFileId = await createFile(worker.id);
    const created = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      { description: 'concurrent send', fileIds: [proofFileId] },
      { 'idempotency-key': `proof-v2-behavior-concurrent-send-create-${questId}` }
    );
    const submissionId = ((await created.json()).data as { id: string }).id;
    const responses = await Promise.all([
      request(
        'POST',
        `/api/v2/quests/${questId}/proof-submissions/${submissionId}/submit`,
        worker.id,
        undefined,
        { 'idempotency-key': `proof-v2-behavior-concurrent-send-one-${questId}` }
      ),
      request(
        'POST',
        `/api/v2/quests/${questId}/proof-submissions/${submissionId}/submit`,
        worker.id,
        undefined,
        { 'idempotency-key': `proof-v2-behavior-concurrent-send-two-${questId}` }
      ),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const failed = responses.find(({ status }) => status === 409);
    expect(failed).toBeDefined();
    expect((await failed!.json()).error.code).toBe('PROOF_SUBMISSION_LOCKED');
  });

  it('allows only the Team Leader to confirm proof-free GROUP Candidate work', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({
      mode: 'CANDIDATE',
      v2Mode: 'CANDIDATE',
      v2Participation: 'GROUP',
      headcount: 2,
      proofRequired: false,
      questFundingTotalSatang: 2_000,
      questEscrowSatang: 2_040,
    });
    const teamId = randomUUID();
    await db.insert(questCandidateTeamV2).values({
      id: teamId,
      questId,
      leaderId: worker.id,
      name: 'Selected Team',
      headcount: 2,
      state: 'TEAM_SELECTED',
    });
    await db.insert(questCandidateTeamV2Member).values([
      { teamId, memberId: worker.id },
      { teamId, memberId: secondWorker.id },
    ]);
    await reserveQuest(questId, 2_040);

    const memberAttempt = await request(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmation`,
      secondWorker.id,
      undefined,
      { 'idempotency-key': `proof-v2-behavior-candidate-member-${questId}` }
    );
    expect(memberAttempt.status).toBe(403);
    expect((await memberAttempt.json()).error.code).toBe('PROOF_SUBMISSION_NOT_ALLOWED');

    const { response: leaderConfirmation, body } = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-candidate-leader-${questId}`
    );
    expect(leaderConfirmation.status).toBe(200);
    expect(body.data.reviewStatus).toBe('COMPLETION_CONFIRMATION_PENDING');
    expect(
      (
        await db
          .select({ status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
      ).every(({ status }) => status === 'ASSIGNMENT_ACTIVE')
    ).toBe(true);
    const approved = await reviewCompletionConfirmation(
      questId,
      body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      `proof-v2-behavior-candidate-leader-review-${questId}`
    );
    expect(approved.status).toBe(200);
    expect((await approved.json()).data.questStatus).toBe('QUEST_COMPLETED');
    expect(
      await db
        .select({ status: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(eq(questAssignment.questId, questId))
    ).toEqual([{ status: 'ASSIGNMENT_COMPLETED' }, { status: 'ASSIGNMENT_COMPLETED' }]);
  });

  it('allows only the Team Leader to create and send proof-required GROUP Candidate work', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({
      mode: 'CANDIDATE',
      v2Mode: 'CANDIDATE',
      v2Participation: 'GROUP',
      headcount: 2,
    });
    const teamId = randomUUID();
    await db.insert(questCandidateTeamV2).values({
      id: teamId,
      questId,
      leaderId: worker.id,
      name: 'Proof Team',
      headcount: 2,
      state: 'TEAM_SELECTED',
    });
    await db.insert(questCandidateTeamV2Member).values([
      { teamId, memberId: worker.id },
      { teamId, memberId: secondWorker.id },
    ]);
    const proofFileId = await createFile(worker.id);

    const memberAttempt = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      secondWorker.id,
      { description: 'member proof' },
      { 'idempotency-key': `proof-v2-behavior-candidate-proof-member-${questId}` }
    );
    expect(memberAttempt.status).toBe(403);

    const created = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      { description: 'team proof', fileIds: [proofFileId] },
      { 'idempotency-key': `proof-v2-behavior-candidate-proof-create-${questId}` }
    );
    expect(created.status).toBe(201);
    const createdData = (await created.json()).data as { id: string; teamId: string };
    expect(createdData.teamId).toBe(teamId);

    const sent = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': `proof-v2-behavior-candidate-proof-send-${questId}` }
    );
    expect(sent.status).toBe(200);
    expect((await sent.json()).data.status).toBe('PROOF_PENDING');
    expect(
      await db
        .select({
          submissionStatus: questV2ProofSubmission.submissionStatus,
          teamId: questV2ProofSubmission.teamId,
        })
        .from(questV2ProofSubmission)
        .where(eq(questV2ProofSubmission.questId, questId))
    ).toEqual([{ submissionStatus: 'PROOF_PENDING', teamId }]);
  });
});

const createGroupFcfsQuest = async (overrides: Partial<typeof quest.$inferInsert> = {}) => {
  const { questId } = await createQuest({
    v2Participation: 'GROUP',
    v2Mode: 'FIRST_COME_FIRST_SERVED',
    ...overrides,
  });
  await reserveQuest(questId, overrides.questEscrowSatang ?? 2_040);
  const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
  await db
    .update(quest)
    .set({ fundingReservationId: reservation!.id })
    .where(eq(quest.id, questId));
  const assignments = await db
    .select({ id: questAssignment.id, workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(eq(questAssignment.questId, questId));
  const assignmentIdOf = (memberId: string) =>
    assignments.find(({ workerId }) => workerId === memberId)!.id;
  return { questId, assignmentIdOf };
};

const reviewOverHttp = (
  questId: string,
  proofSubmissionId: string,
  decision: 'PROOF_APPROVED' | 'PROOF_NOT_APPROVED',
  key = `proof-v2-behavior-per-worker-${proofSubmissionId}`
) =>
  jsonRequest(
    'POST',
    `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
    hirer.id,
    decision === 'PROOF_APPROVED'
      ? { decision }
      : { decision, reason: 'The submitted work is incomplete' },
    { 'idempotency-key': key }
  );

const questStatusOf = async (questId: string) =>
  (
    await db
      .select({ status: quest.questStatus, moneyHoldStartedAt: quest.moneyHoldStartedAt })
      .from(quest)
      .where(eq(quest.id, questId))
  )[0];

const assignmentStatusesOf = async (questId: string) =>
  Object.fromEntries(
    (
      await db
        .select({ workerId: questAssignment.workerId, status: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(eq(questAssignment.questId, questId))
    ).map(({ workerId, status }) => [workerId, status])
  );

type PushRow = { recipient: string; eventType: string; eventKey: string };

const sortedPushRows = (rows: PushRow[]) =>
  [...rows].sort((left, right) =>
    `${left.recipient}${left.eventType}`.localeCompare(`${right.recipient}${right.eventType}`)
  );

const pushRowsOf = async (questId: string) =>
  sortedPushRows(
    (
      await sql<PushRow[]>`
        select recipient_member_id as recipient, event_type as "eventType", event_key as "eventKey"
        from push_deliveries
        where data->>'questId' = ${questId}
      `
    ).map((row) => ({ ...row }))
  );

type QuestUpdateSeen = {
  changeType: string;
  recipientMemberIds: string[];
  closeMemberIds: string[];
};

const listenQuestUpdates = async (questId: string) => {
  const events: QuestUpdateSeen[] = [];
  let read = 0;
  let wake = () => {};
  const listener = await sql.listen('kuquest_quest_updates', (payload) => {
    const event = JSON.parse(payload);
    if (event.questId !== questId) return;
    events.push({
      changeType: event.changeType,
      recipientMemberIds: [...event.recipientMemberIds].sort(),
      closeMemberIds: [...(event.closeMemberIds ?? [])].sort(),
    });
    wake();
  });
  return {
    next: async (count: number) => {
      while (events.length < read + count) {
        await new Promise<void>((resolve) => (wake = resolve));
      }
      read += count;
      return events.slice(read - count, read);
    },
    stop: () => listener.unlisten(),
  };
};

describe('GROUP + FIRST_COME_FIRST_SERVED per-Worker Proof review', () => {
  it('keeps the Quest in progress after one Worker is not approved and lets another Worker submit', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, assignmentIdOf } = await createGroupFcfsQuest();
    const first = await createSentProofForQuest(questId, worker.id);

    const notApproved = await reviewOverHttp(
      questId,
      first.proofSubmissionId,
      'PROOF_NOT_APPROVED'
    );
    expect(notApproved.status).toBe(200);
    expect((await notApproved.json()).data.questStatus).toBe('QUEST_IN_PROGRESS');
    expect(await questStatusOf(questId)).toEqual({
      status: 'QUEST_IN_PROGRESS',
      moneyHoldStartedAt: null,
    });
    expect(await assignmentStatusesOf(questId)).toEqual({
      [worker.id]: 'ASSIGNMENT_INCOMPLETE',
      [secondWorker.id]: 'ASSIGNMENT_ACTIVE',
    });
    expect(
      await db
        .select({ assignmentId: adminReviewItem.assignmentId, workerId: adminReviewItem.workerId })
        .from(adminReviewItem)
        .where(eq(adminReviewItem.questId, questId))
    ).toEqual([{ assignmentId: assignmentIdOf(worker.id), workerId: worker.id }]);
    expect(await pushRowsOf(questId)).toEqual([
      {
        recipient: worker.id,
        eventType: 'PROOF_NOT_APPROVED',
        eventKey: `quest-v2:PROOF_NOT_APPROVED:${assignmentIdOf(worker.id)}`,
      },
    ]);

    const draft = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      secondWorker.id,
      { description: 'Second Worker proof' },
      { 'idempotency-key': `proof-v2-behavior-per-worker-draft-${questId}` }
    );
    expect(draft.status).toBe(201);
    const blocked = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      { description: 'Second try' },
      { 'idempotency-key': `proof-v2-behavior-per-worker-retry-${questId}` }
    );
    expect(blocked.status).toBe(403);
    expect(await readTestQuestEscrow({ ownerUserId: hirer.id, questId })).toMatchObject({
      status: 'ACTIVE',
      remainingSatang: 2_040,
    });
  });

  it('completes the Quest when a later Worker is approved, pays that Worker, and holds the unpaid slot', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, assignmentIdOf } = await createGroupFcfsQuest();
    const first = await createSentProofForQuest(questId, worker.id);
    const key = `proof-v2-behavior-per-worker-a-${questId}`;
    const notApproved = await reviewOverHttp(
      questId,
      first.proofSubmissionId,
      'PROOF_NOT_APPROVED',
      key
    );
    const notApprovedBody = await notApproved.json();
    const second = await createSentProofForQuest(questId, secondWorker.id);

    const approved = await reviewOverHttp(questId, second.proofSubmissionId, 'PROOF_APPROVED');
    expect(approved.status).toBe(200);
    expect((await approved.json()).data.questStatus).toBe('QUEST_COMPLETED');
    const completed = await questStatusOf(questId);
    expect(completed?.status).toBe('QUEST_COMPLETED');
    expect(completed?.moneyHoldStartedAt).toBeInstanceOf(Date);
    expect(await assignmentStatusesOf(questId)).toEqual({
      [worker.id]: 'ASSIGNMENT_INCOMPLETE',
      [secondWorker.id]: 'ASSIGNMENT_COMPLETED',
    });
    const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    expect(reservation).toMatchObject({ status: 'ACTIVE', remainingSatang: 1_020 });
    expect(
      (await listTestQuestEscrowSettlements(reservation!.id)).map(
        ({ recipientUserId, recipientAmountSatang, platformFeeSatang }) => ({
          recipientUserId,
          recipientAmountSatang,
          platformFeeSatang,
        })
      )
    ).toEqual([
      { recipientUserId: secondWorker.id, recipientAmountSatang: 1_000, platformFeeSatang: 20 },
    ]);

    await db.insert(questConditionItem).values({ questId, position: 0, text: 'Complete the work' });
    const readParticipation = async (memberId: string) =>
      (await (await request('GET', `/api/v2/quests/${questId}/participation`, memberId)).json())
        .data;
    expect((await readParticipation(worker.id)).workerSettlement).toEqual({
      status: 'NO_PAYMENT',
      amountSatang: 0,
      settledAt: null,
    });
    expect((await readParticipation(secondWorker.id)).workerSettlement).toMatchObject({
      status: 'PAID',
      amountSatang: 1_000,
    });
    const detail = await request('GET', `/api/v2/quests/${questId}`, hirer.id);
    expect((await detail.json()).data.moneyHold).toEqual({
      status: 'HELD',
      releasesAt: new Date(
        completed!.moneyHoldStartedAt!.getTime() + 7 * 24 * 60 * 60 * 1000
      ).toISOString(),
      heldSatang: 1_020,
    });

    const replay = await reviewOverHttp(
      questId,
      first.proofSubmissionId,
      'PROOF_NOT_APPROVED',
      key
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(notApprovedBody);
    expect((await reviewOverHttp(questId, second.proofSubmissionId, 'PROOF_APPROVED')).status).toBe(
      200
    );
    expect(await pushRowsOf(questId)).toEqual([
      {
        recipient: worker.id,
        eventType: 'PROOF_NOT_APPROVED',
        eventKey: `quest-v2:PROOF_NOT_APPROVED:${assignmentIdOf(worker.id)}`,
      },
      {
        recipient: worker.id,
        eventType: 'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN',
        eventKey: `quest-v2:QUEST_COMPLETED_DISPUTE_WINDOW_OPEN:${assignmentIdOf(worker.id)}`,
      },
    ]);
    expect(
      await db.select().from(adminReviewItem).where(eq(adminReviewItem.questId, questId))
    ).toHaveLength(1);
    expect(await listTestQuestEscrowSettlements(reservation!.id)).toHaveLength(1);
    expect(await readTestQuestEscrow({ ownerUserId: hirer.id, questId })).toMatchObject({
      status: 'ACTIVE',
      remainingSatang: 1_020,
    });
  });

  it('completes the Quest when the last Active Worker is not approved after another was approved', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, assignmentIdOf } = await createGroupFcfsQuest();
    const first = await createSentProofForQuest(questId, worker.id);
    const second = await createSentProofForQuest(questId, secondWorker.id);
    expect((await reviewOverHttp(questId, second.proofSubmissionId, 'PROOF_APPROVED')).status).toBe(
      200
    );

    const notApproved = await reviewOverHttp(
      questId,
      first.proofSubmissionId,
      'PROOF_NOT_APPROVED'
    );
    const notApprovedBody = await notApproved.json();
    expect(notApprovedBody.data.questStatus).toBe('QUEST_COMPLETED');
    const replay = await reviewOverHttp(questId, first.proofSubmissionId, 'PROOF_NOT_APPROVED');
    expect(await replay.json()).toEqual(notApprovedBody);
    expect((await questStatusOf(questId))?.moneyHoldStartedAt).toBeInstanceOf(Date);
    expect(await readTestQuestEscrow({ ownerUserId: hirer.id, questId })).toMatchObject({
      status: 'ACTIVE',
      remainingSatang: 1_020,
    });
    expect(await pushRowsOf(questId)).toEqual([
      {
        recipient: worker.id,
        eventType: 'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN',
        eventKey: `quest-v2:QUEST_COMPLETED_DISPUTE_WINDOW_OPEN:${assignmentIdOf(worker.id)}`,
      },
    ]);
  });

  it('closes only the not-approved Worker stream and opens the Dispute window at completion', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createGroupFcfsQuest();
    const first = await createSentProofForQuest(questId, worker.id);
    const second = await createSentProofForQuest(questId, secondWorker.id);
    const updates = await listenQuestUpdates(questId);
    try {
      await reviewOverHttp(questId, first.proofSubmissionId, 'PROOF_NOT_APPROVED');
      expect(await updates.next(1)).toEqual([
        {
          changeType: 'PROOF_REVIEWED',
          recipientMemberIds: [hirer.id, worker.id].sort(),
          closeMemberIds: [worker.id],
        },
      ]);
      await reviewOverHttp(questId, second.proofSubmissionId, 'PROOF_APPROVED');
      const everyone = [hirer.id, worker.id, secondWorker.id].sort();
      expect(await updates.next(3)).toEqual([
        {
          changeType: 'PROOF_REVIEWED',
          recipientMemberIds: [hirer.id, secondWorker.id].sort(),
          closeMemberIds: [],
        },
        { changeType: 'QUEST_COMPLETED', recipientMemberIds: everyone, closeMemberIds: [] },
        {
          changeType: 'DISPUTE_WINDOW_OPENED',
          recipientMemberIds: everyone,
          closeMemberIds: [secondWorker.id],
        },
      ]);
    } finally {
      await updates.stop();
    }
  });

  it('keeps the last not-approved Worker stream open and sends that Worker the Dispute window', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createGroupFcfsQuest();
    const first = await createSentProofForQuest(questId, worker.id);
    const second = await createSentProofForQuest(questId, secondWorker.id);
    await reviewOverHttp(questId, second.proofSubmissionId, 'PROOF_APPROVED');
    const updates = await listenQuestUpdates(questId);
    try {
      await reviewOverHttp(questId, first.proofSubmissionId, 'PROOF_NOT_APPROVED');
      const hirerAndWorker = [hirer.id, worker.id].sort();
      expect(await updates.next(3)).toEqual([
        { changeType: 'PROOF_REVIEWED', recipientMemberIds: hirerAndWorker, closeMemberIds: [] },
        { changeType: 'QUEST_COMPLETED', recipientMemberIds: hirerAndWorker, closeMemberIds: [] },
        {
          changeType: 'DISPUTE_WINDOW_OPENED',
          recipientMemberIds: hirerAndWorker,
          closeMemberIds: [],
        },
      ]);
    } finally {
      await updates.stop();
    }
  });

  it('keeps a not-approved proof-free Worker stream open and sends that Worker the Dispute window', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, assignmentIdOf } = await createGroupFcfsQuest({ proofRequired: false });
    const first = await createCompletionConfirmation(
      questId,
      worker.id,
      `proof-v2-behavior-proof-free-hold-first-${questId}`
    );
    const second = await createCompletionConfirmation(
      questId,
      secondWorker.id,
      `proof-v2-behavior-proof-free-hold-second-${questId}`
    );
    expect([first.response.status, second.response.status]).toEqual([200, 200]);
    const approved = await reviewCompletionConfirmation(
      questId,
      second.body.data.id,
      'COMPLETION_CONFIRMATION_APPROVED',
      undefined,
      `proof-v2-behavior-proof-free-hold-approve-${questId}`
    );
    expect(approved.status).toBe(200);
    const updates = await listenQuestUpdates(questId);
    try {
      const rejected = await reviewCompletionConfirmation(
        questId,
        first.body.data.id,
        'COMPLETION_CONFIRMATION_NOT_APPROVED',
        'The work is not complete',
        `proof-v2-behavior-proof-free-hold-reject-${questId}`
      );
      expect(rejected.status).toBe(200);
      expect((await rejected.json()).data.questStatus).toBe('QUEST_COMPLETED');
      const hirerAndWorker = [hirer.id, worker.id].sort();
      expect(await updates.next(3)).toEqual([
        {
          changeType: 'COMPLETION_REVIEWED',
          recipientMemberIds: hirerAndWorker,
          closeMemberIds: [],
        },
        { changeType: 'QUEST_COMPLETED', recipientMemberIds: hirerAndWorker, closeMemberIds: [] },
        {
          changeType: 'DISPUTE_WINDOW_OPENED',
          recipientMemberIds: hirerAndWorker,
          closeMemberIds: [],
        },
      ]);
    } finally {
      await updates.stop();
    }
    expect(await assignmentStatusesOf(questId)).toEqual({
      [worker.id]: 'ASSIGNMENT_INCOMPLETE',
      [secondWorker.id]: 'ASSIGNMENT_COMPLETED',
    });
    expect(
      (await pushRowsOf(questId)).filter(
        ({ eventType }) => eventType === 'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN'
      )
    ).toEqual([
      {
        recipient: worker.id,
        eventType: 'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN',
        eventKey: `quest-v2:QUEST_COMPLETED_DISPUTE_WINDOW_OPEN:${assignmentIdOf(worker.id)}`,
      },
    ]);
  });

  it('fails the Quest when every Worker is not approved and alerts each Worker once', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId, assignmentIdOf } = await createGroupFcfsQuest();
    const first = await createSentProofForQuest(questId, worker.id);
    const second = await createSentProofForQuest(questId, secondWorker.id);
    await reviewOverHttp(questId, first.proofSubmissionId, 'PROOF_NOT_APPROVED');

    const lastReview = await reviewOverHttp(
      questId,
      second.proofSubmissionId,
      'PROOF_NOT_APPROVED'
    );
    expect((await lastReview.json()).data.questStatus).toBe('QUEST_FAILED');
    expect((await questStatusOf(questId))?.status).toBe('QUEST_FAILED');
    expect(await assignmentStatusesOf(questId)).toEqual({
      [worker.id]: 'ASSIGNMENT_INCOMPLETE',
      [secondWorker.id]: 'ASSIGNMENT_INCOMPLETE',
    });
    expect(await readTestQuestEscrow({ ownerUserId: hirer.id, questId })).toMatchObject({
      status: 'ACTIVE',
      remainingSatang: 2_040,
    });
    expect(await pushRowsOf(questId)).toEqual(
      sortedPushRows([
        {
          recipient: worker.id,
          eventType: 'PROOF_NOT_APPROVED',
          eventKey: `quest-v2:PROOF_NOT_APPROVED:${assignmentIdOf(worker.id)}`,
        },
        {
          recipient: worker.id,
          eventType: 'QUEST_FAILED',
          eventKey: `quest-v2:QUEST_FAILED:${questId}`,
        },
        {
          recipient: secondWorker.id,
          eventType: 'QUEST_FAILED',
          eventKey: `quest-v2:QUEST_FAILED:${questId}`,
        },
      ])
    );
    expect(
      await db.select().from(adminReviewItem).where(eq(adminReviewItem.questId, questId))
    ).toHaveLength(2);
  });

  it('fails the Quest at dueAt when the other Worker sent no Proof after one was not approved', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const dueAt = new Date(Date.now() + 60_000);
    const { questId } = await createGroupFcfsQuest({
      startTime: new Date(dueAt.getTime() - 60 * 60 * 1000),
      dueAt,
    });
    const first = await createSentProofForQuest(questId, worker.id);
    await reviewOverHttp(questId, first.proofSubmissionId, 'PROOF_NOT_APPROVED');

    expect(await failQuestV2AtDueAt(questId, new Date(dueAt.getTime() + 1))).toBe(true);
    expect((await questStatusOf(questId))?.status).toBe('QUEST_FAILED');
    expect(await assignmentStatusesOf(questId)).toEqual({
      [worker.id]: 'ASSIGNMENT_INCOMPLETE',
      [secondWorker.id]: 'ASSIGNMENT_INCOMPLETE',
    });
    expect(
      (await pushRowsOf(questId))
        .filter(({ eventType }) => eventType === 'QUEST_FAILED')
        .map(({ recipient }) => recipient)
        .sort()
    ).toEqual([worker.id, secondWorker.id].sort());
  });

  it('refuses cancellation and Admin termination while a Worker is ASSIGNMENT_INCOMPLETE on the running Quest', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createGroupFcfsQuest();
    const first = await createSentProofForQuest(questId, worker.id);
    await reviewOverHttp(questId, first.proofSubmissionId, 'PROOF_NOT_APPROVED');

    const cancelled = await request(
      'POST',
      `/api/v2/quests/${questId}/cancel`,
      hirer.id,
      undefined,
      {
        'idempotency-key': `proof-v2-behavior-per-worker-cancel-${questId}`,
      }
    );
    expect(cancelled.status).toBe(409);
    expect((await cancelled.json()).error.code).toBe('QUEST_SETTLEMENT_NOT_ALLOWED');
    const preview = await request('GET', `/api/v2/quests/${questId}/cancel-preview`, hirer.id);
    expect((await preview.json()).error.code).toBe('QUEST_SETTLEMENT_NOT_ALLOWED');
    expect(
      await db.transaction((transaction) =>
        terminateQuestInTransaction(transaction, questId, randomUUID(), `terminate-${questId}`)
      )
    ).toEqual({ outcome: 'invalid-state' });
    expect((await questStatusOf(questId))?.status).toBe('QUEST_IN_PROGRESS');
    expect(await readTestQuestEscrow({ ownerUserId: hirer.id, questId })).toMatchObject({
      status: 'ACTIVE',
      remainingSatang: 2_040,
    });
  });

  it('holds the unpaid slot by its underfilled consent amount and fee share', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createGroupFcfsQuest({
      headcount: 4,
      questFundingTotalSatang: 4_000,
      questEscrowSatang: 4_080,
      platformFeePerWorkerSatang: 20,
    });
    await db.insert(questAssignment).values({
      questId,
      workerId: unrelated.id,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
      createdAt: new Date(Date.now() + 10),
    });
    const assignments = await db
      .select({
        id: questAssignment.id,
        workerId: questAssignment.workerId,
        createdAt: questAssignment.createdAt,
      })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId))
      .orderBy(asc(questAssignment.createdAt));
    const now = new Date();
    const decisionId = randomUUID();
    await db.insert(questV2UnderfilledDecision).values({
      id: decisionId,
      questId,
      activeWorkerCount: 3,
      workerRewardPoolSatang: 4_000,
      state: 'UNDERFILLED_COMPLETED',
      decision: 'PROCEED',
      decisionExpiresAt: now,
      consentExpiresAt: now,
      detectedAt: now,
      resolvedAt: now,
    });
    await db.insert(questV2UnderfilledConsent).values(
      assignments.map((assignment, index) => ({
        decisionId,
        questId,
        assignmentId: assignment.id,
        workerId: assignment.workerId,
        rewardSatang: index === 0 ? 1_334 : 1_333,
        decision: 'ACCEPT' as const,
        respondedAt: now,
        createdAt: assignment.createdAt,
      }))
    );
    expect(assignments[0]?.workerId).toBe(worker.id);
    const proofs = await Promise.all(
      [worker, secondWorker, unrelated].map(({ id }) => createSentProofForQuest(questId, id))
    );

    await reviewOverHttp(questId, proofs[0]!.proofSubmissionId, 'PROOF_NOT_APPROVED');
    await reviewOverHttp(questId, proofs[1]!.proofSubmissionId, 'PROOF_APPROVED');
    const last = await reviewOverHttp(questId, proofs[2]!.proofSubmissionId, 'PROOF_APPROVED');
    expect((await last.json()).data.questStatus).toBe('QUEST_COMPLETED');
    const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
    expect(reservation).toMatchObject({ status: 'ACTIVE', remainingSatang: 1_334 + 27 });
    expect(
      (await listTestQuestEscrowSettlements(reservation!.id))
        .map(({ recipientUserId, recipientAmountSatang, platformFeeSatang }) => ({
          recipientUserId,
          recipientAmountSatang,
          platformFeeSatang,
        }))
        .sort((left, right) => left.platformFeeSatang - right.platformFeeSatang)
    ).toEqual([
      { recipientUserId: unrelated.id, recipientAmountSatang: 1_333, platformFeeSatang: 26 },
      { recipientUserId: secondWorker.id, recipientAmountSatang: 1_333, platformFeeSatang: 27 },
    ]);
  });

  it('still fails a GROUP + CANDIDATE Quest at once on PROOF_NOT_APPROVED', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({
      mode: 'CANDIDATE',
      v2Mode: 'CANDIDATE',
      v2Participation: 'GROUP',
      headcount: 2,
    });
    await reserveQuest(questId, 2_040);
    const teamId = randomUUID();
    await db.insert(questCandidateTeamV2).values({
      id: teamId,
      questId,
      leaderId: worker.id,
      name: 'Proof Team',
      headcount: 2,
      state: 'TEAM_SELECTED',
    });
    await db.insert(questCandidateTeamV2Member).values([
      { teamId, memberId: worker.id },
      { teamId, memberId: secondWorker.id },
    ]);
    const proof = await createSentProofForQuest(questId, worker.id);

    const review = await reviewOverHttp(questId, proof.proofSubmissionId, 'PROOF_NOT_APPROVED');
    expect((await review.json()).data.questStatus).toBe('QUEST_FAILED');
    expect(await assignmentStatusesOf(questId)).toEqual({
      [worker.id]: 'ASSIGNMENT_INCOMPLETE',
      [secondWorker.id]: 'ASSIGNMENT_INCOMPLETE',
    });
    expect((await pushRowsOf(questId)).map(({ eventType }) => eventType)).toEqual([
      'QUEST_FAILED',
      'QUEST_FAILED',
    ]);
  });

  it('still fails a SINGLE Quest at once on PROOF_NOT_APPROVED', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({
      questFundingTotalSatang: 1_020,
      questEscrowSatang: 1_020,
    });
    await reserveQuest(questId, 1_020);
    const proof = await createSentProofForQuest(questId, worker.id);

    const review = await reviewOverHttp(questId, proof.proofSubmissionId, 'PROOF_NOT_APPROVED');
    expect((await review.json()).data.questStatus).toBe('QUEST_FAILED');
    expect(await pushRowsOf(questId)).toEqual([
      {
        recipient: worker.id,
        eventType: 'QUEST_FAILED',
        eventKey: `quest-v2:QUEST_FAILED:${questId}`,
      },
    ]);
  });
});
