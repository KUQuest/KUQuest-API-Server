import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { chatConversation, chatMembership } from '@/database/schema/work-chat.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2CompletionConfirmation,
  questV2ProofSubmission,
  questV2ProofSubmissionFile,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { auth } from '@/modules/auth';
import {
  configureQuestWorkChatMembershipWriter,
  type QuestTransaction,
} from '@/modules/quest';
import { questV2ProofStorage } from '@/modules/quest/quest-proof-v2.storage';
import {
  UnsupportedWorkChatAttachmentError,
  WorkChatAttachmentTooLargeError,
} from '@/modules/work-chat/work-chat.storage';
import { createWorkChatMembershipWriter } from '@/modules/work-chat';
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

const successfulWriter = {
  applyQuestTransition: async (
    _transaction: QuestTransaction,
    _transition: unknown,
  ) => ({ conversationId: 'proof-v2-behavior-conversation', outcome: 'APPLIED' as const }),
};

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
  const memberId = headers.get('x-member-id') ?? worker.id;
  const member = members.find(({ id }) => id === memberId) ?? worker;
  return { user: member, session: { userId: member.id } } as never;
}) as never);

const request = (
  method: string,
  path: string,
  memberId: string,
  body?: BodyInit,
  headers: HeadersInit = {},
) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: {
    'x-member-id': memberId,
    ...(body instanceof FormData ? {} : body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  },
  body,
}));

const jsonRequest = (
  method: string,
  path: string,
  memberId: string,
  body: unknown,
  headers: HeadersInit = {},
) => request(method, path, memberId, JSON.stringify(body), headers);

const createQuest = async (overrides: Partial<typeof quest.$inferInsert> = {}) => {
  const questId = randomUUID();
  questIds.push(questId);
  const group = overrides.v2Participation === 'GROUP';
  const workerIds = group ? [worker.id, secondWorker.id] : [worker.id];
  await db.insert(quest).values({
    id: questId,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Proof Submission v2 behavior Quest',
    condition: 'Complete the work',
    mode: group && overrides.v2Mode === 'CANDIDATE' ? 'CANDIDATE' : 'NO_CANDIDATE',
    participation: group ? 'GROUP' : 'SOLO',
    v2Mode: group ? 'FIRST_COME_FIRST_SERVED' : 'FIRST_COME_FIRST_SERVED',
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
  await db.insert(questAssignment).values(workerIds.map((workerId, index) => ({
    questId,
    workerId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: new Date(Date.now() + index),
  })));
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

const account = async (userId: string, type: 'SPENDING' | 'FUNDING_RESERVED') => {
  const [wallet] = await db.select({ id: walletWallet.id })
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));
  const [ledgerAccount] = await db.select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, type)));
  return ledgerAccount.id;
};

const fundHirer = async (amountSatang: number) => {
  const spending = await account(hirer.id, 'SPENDING');
  const [suspense] = await db.select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  await createSealedLedgerTransaction({
    businessReference: `proof-v2-behavior-top-up-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spending, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const reserveQuest = async (questId: string, amountSatang: number) => {
  await db.transaction((transaction) => reserveSpending(transaction, {
    ownerUserId: hirer.id,
    callerScope: 'quest',
    callerReference: questId,
    amountSatang: positiveSatang(amountSatang),
  }));
};

const deleteWorkChatForQuests = async (ids: string[]) => {
  if (ids.length === 0) return;
  const conversations = await db.select({ id: chatConversation.id })
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

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
    const [tables] = await sql<{ command: string | null; submission: string | null }[]>`
      select
        to_regclass('public.quest_v2_proof_command') as command,
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
  await fundHirer(100_000);
});

beforeEach(() => {
  authenticate();
  configureQuestWorkChatMembershipWriter(successfulWriter);
});

afterEach(async () => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
  if (!postgresAvailable || !proofSchemaAvailable) return;
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
    const { questId } = await createQuest({
      v2Participation: 'GROUP',
      headcount: 2,
      questFundingTotalSatang: 2_000,
      questEscrowSatang: 2_040,
    });
    const firstFileId = await createFile(worker.id);
    const secondFileId = await createFile(worker.id);

    const created = await jsonRequest(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      { description: 'draft', fileIds: [firstFileId] },
      { 'idempotency-key': 'proof-v2-behavior-create' },
    );
    expect(created.status).toBe(201);
    const createdData = (await created.json()).data as Record<string, unknown>;
    expect(createdData).toMatchObject({
      description: 'draft',
      status: null,
      visibility: 'FULL',
      fileIds: [firstFileId],
    });

    const hirerDrafts = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions`,
      hirer.id,
    );
    expect(hirerDrafts.status).toBe(200);
    expect((await hirerDrafts.json()).data.items).toEqual([]);

    const workerDrafts = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
    );
    expect((await workerDrafts.json()).data.items).toEqual([expect.objectContaining({
      id: createdData.id,
      visibility: 'FULL',
      description: 'draft',
    })]);

    const updated = await jsonRequest(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}`,
      worker.id,
      { description: 'edited', fileIds: [secondFileId] },
      { 'idempotency-key': 'proof-v2-behavior-edit' },
    );
    expect(updated.status).toBe(200);
    const updatedData = (await updated.json()).data as Record<string, unknown>;
    expect(updatedData).toMatchObject({ description: 'edited', fileIds: [secondFileId] });

    const replay = await jsonRequest(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}`,
      worker.id,
      { description: 'edited', fileIds: [secondFileId] },
      { 'idempotency-key': 'proof-v2-behavior-edit' },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(updatedData);

    const reused = await jsonRequest(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}`,
      worker.id,
      { description: 'different', fileIds: [secondFileId] },
      { 'idempotency-key': 'proof-v2-behavior-edit' },
    );
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const sent = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-submit' },
    );
    expect(sent.status).toBe(200);
    expect((await sent.json()).data.status).toBe('PROOF_PENDING');

    const hirerSent = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions`,
      hirer.id,
    );
    expect((await hirerSent.json()).data.items).toEqual([expect.objectContaining({
      id: createdData.id,
      visibility: 'FULL',
      description: 'edited',
      fileIds: [secondFileId],
    })]);

    const otherWorkerView = await request(
      'GET',
      `/api/v2/quests/${questId}/proof-submissions`,
      secondWorker.id,
    );
    expect((await otherWorkerView.json()).data.items).toEqual([expect.objectContaining({
      id: createdData.id,
      visibility: 'SUMMARY',
      description: null,
      fileIds: [],
      files: [],
      status: 'PROOF_PENDING',
    })]);

    const lockedEdit = await jsonRequest(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${createdData.id}`,
      worker.id,
      { description: 'locked' },
      { 'idempotency-key': 'proof-v2-behavior-locked-edit' },
    );
    expect(lockedEdit.status).toBe(409);
    expect((await lockedEdit.json()).error.code).toBe('PROOF_SUBMISSION_LOCKED');

    const crossActorQuest = await createQuest();
    const crossActorFirst = await jsonRequest(
      'POST',
      `/api/v2/quests/${crossActorQuest.questId}/proof-submissions`,
      worker.id,
      { description: 'worker command' },
      { 'idempotency-key': 'proof-v2-behavior-cross-actor' },
    );
    expect(crossActorFirst.status).toBe(201);
    const crossActorReuse = await jsonRequest(
      'POST',
      `/api/v2/quests/${crossActorQuest.questId}/proof-submissions`,
      secondWorker.id,
      { description: 'second command' },
      { 'idempotency-key': 'proof-v2-behavior-cross-actor' },
    );
    expect(crossActorReuse.status).toBe(409);
    expect((await crossActorReuse.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('preserves valid files, identifies failed files, and blocks send until retry', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const upload = spyOn(questV2ProofStorage, 'upload').mockImplementation(async (memberId, input) => {
      if (input.name === 'bad.pdf') throw new UnsupportedWorkChatAttachmentError('bad file');
      return {
        bucket: 'proof-v2-behavior-test',
        objectKey: `proof-submissions/${memberId}/${input.name}`,
        contentType: 'application/pdf',
        sizeBytes: input.size,
        fileName: input.name,
      };
    });
    spyOn(questV2ProofStorage, 'remove').mockResolvedValue(undefined);

    const form = new FormData();
    form.append('files', new File([new Uint8Array([1, 2, 3])], 'good.pdf', { type: 'application/pdf' }));
    form.append('files', new File([new Uint8Array([4, 5, 6])], 'bad.pdf', { type: 'application/pdf' }));
    const partial = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      form,
      { 'idempotency-key': 'proof-v2-behavior-partial' },
    );
    expect(partial.status).toBe(415);
    expect((await partial.json()).error.code).toBe('PROOF_FILE_TYPE_NOT_SUPPORTED');
    expect(upload).toHaveBeenCalledTimes(2);

    const [submission] = await db.select({ id: questV2ProofSubmission.id })
      .from(questV2ProofSubmission)
      .where(eq(questV2ProofSubmission.questId, questId));
    const attachments = await db.select({
      fileId: questV2ProofSubmissionFile.fileId,
      status: questV2ProofSubmissionFile.uploadStatus,
      failureCode: questV2ProofSubmissionFile.failureCode,
    }).from(questV2ProofSubmissionFile)
      .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submission.id));
    expect(attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'PROOF_FILE_READY', failureCode: null }),
      expect.objectContaining({ status: 'PROOF_FILE_FAILED', fileId: null, failureCode: 'PROOF_FILE_TYPE_NOT_SUPPORTED' }),
    ]));

    const failedRetryForm = new FormData();
    failedRetryForm.append('files', new File([new Uint8Array([10, 11, 12])], 'bad.pdf', { type: 'application/pdf' }));
    const failedRetry = await request(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}`,
      worker.id,
      failedRetryForm,
      { 'idempotency-key': 'proof-v2-behavior-partial-failed-retry' },
    );
    expect(failedRetry.status).toBe(415);
    const failedRetryAttachments = await db.select({
      status: questV2ProofSubmissionFile.uploadStatus,
    }).from(questV2ProofSubmissionFile)
      .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submission.id));
    expect(failedRetryAttachments).toHaveLength(2);
    expect(failedRetryAttachments.filter(({ status }) => status === 'PROOF_FILE_FAILED')).toHaveLength(1);

    const blocked = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-partial-submit' },
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe('PROOF_FILES_UPLOAD_FAILED');

    const retryForm = new FormData();
    retryForm.append('files', new File([new Uint8Array([7, 8, 9])], 'retry.pdf', { type: 'application/pdf' }));
    const retried = await request(
      'PATCH',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}`,
      worker.id,
      retryForm,
      { 'idempotency-key': 'proof-v2-behavior-partial-retry' },
    );
    expect(retried.status).toBe(200);
    const retriedData = (await retried.json()).data;
    expect(retriedData.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ uploadStatus: 'PROOF_FILE_READY', failureCode: null }),
    ]));
    expect(retriedData.files).toHaveLength(2);
    expect(retriedData.files.every((entry: { uploadStatus: string }) => entry.uploadStatus === 'PROOF_FILE_READY')).toBe(true);

    const sent = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions/${submission.id}/submit`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-partial-submit-retry' },
    );
    expect(sent.status).toBe(200);
    expect((await sent.json()).data.status).toBe('PROOF_PENDING');
  });

  it('settles proof-free GROUP FCFS completion after every Active Worker confirms', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({
      v2Participation: 'GROUP',
      headcount: 2,
      proofRequired: false,
      questFundingTotalSatang: 2_000,
      questEscrowSatang: 2_040,
    });
    await reserveQuest(questId, 2_040);

    const first = await request(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmation`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-fcfs-first' },
    );
    expect(first.status).toBe(200);
    expect((await first.json()).data.questStatus).toBe('QUEST_IN_PROGRESS');
    expect(await db.select({ workerId: questAssignment.workerId, status: questAssignment.assignmentStatus })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId))).toEqual(expect.arrayContaining([
      { workerId: worker.id, status: 'ASSIGNMENT_COMPLETED' },
      { workerId: secondWorker.id, status: 'ASSIGNMENT_ACTIVE' },
    ]));

    const second = await request(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmation`,
      secondWorker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-fcfs-second' },
    );
    expect(second.status).toBe(200);
    expect((await second.json()).data.questStatus).toBe('QUEST_COMPLETED');
    expect(await db.select().from(questV2ProofSubmission).where(eq(questV2ProofSubmission.questId, questId))).toEqual([]);
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_COMPLETED');
    expect((await db.select({ status: questAssignment.assignmentStatus }).from(questAssignment).where(eq(questAssignment.questId, questId)))).toEqual([
      { status: 'ASSIGNMENT_COMPLETED' },
      { status: 'ASSIGNMENT_COMPLETED' },
    ]);
    expect(await db.select().from(questV2CompletionConfirmation).where(eq(questV2CompletionConfirmation.questId, questId))).toHaveLength(2);
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
      { 'idempotency-key': 'proof-v2-behavior-single-candidate-create' },
    );
    expect(draft.status).toBe(201);
    const draftData = (await draft.json()).data as { id: string };

    const unauthorized = await jsonRequest(
      'POST',
      `/api/v2/quests/${candidateQuest.questId}/proof-submissions`,
      secondWorker.id,
      { description: 'not assigned' },
      { 'idempotency-key': 'proof-v2-behavior-single-candidate-unauthorized' },
    );
    expect(unauthorized.status).toBe(403);
    expect((await unauthorized.json()).error.code).toBe('PROOF_SUBMISSION_NOT_ALLOWED');

    const deleted = await request(
      'DELETE',
      `/api/v2/quests/${candidateQuest.questId}/proof-submissions/${draftData.id}`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-single-candidate-delete' },
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data).toMatchObject({ deleted: true, proofSubmissionId: draftData.id });
    const ownList = await request(
      'GET',
      `/api/v2/quests/${candidateQuest.questId}/proof-submissions`,
      worker.id,
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
      { 'idempotency-key': 'proof-v2-behavior-due-at' },
    );
    expect(due.status).toBe(409);
    expect((await due.json()).error.code).toBe('PROOF_DUE_AT_PASSED');
  });

  it('settles proof-free SINGLE completion without creating a Proof Submission', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    await reserveQuest(questId, 1_020);

    const confirmed = await request(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmation`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-single-confirm' },
    );
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).data.questStatus).toBe('QUEST_COMPLETED');
    expect(await db.select().from(questV2ProofSubmission).where(eq(questV2ProofSubmission.questId, questId))).toEqual([]);
    expect(await db.select().from(questV2ProofSubmissionFile).where(eq(questV2ProofSubmissionFile.proofSubmissionId, questId))).toEqual([]);
    expect((await db.select({ status: questAssignment.assignmentStatus }).from(questAssignment).where(eq(questAssignment.questId, questId)))[0]?.status).toBe('ASSIGNMENT_COMPLETED');
  });

  it('uses first-commit-wins for concurrent Draft commands', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const responses = await Promise.all([
      jsonRequest(
        'POST',
        `/api/v2/quests/${questId}/proof-submissions`,
        worker.id,
        { description: 'first command' },
        { 'idempotency-key': 'proof-v2-behavior-concurrent-first' },
      ),
      jsonRequest(
        'POST',
        `/api/v2/quests/${questId}/proof-submissions`,
        worker.id,
        { description: 'second command' },
        { 'idempotency-key': 'proof-v2-behavior-concurrent-second' },
      ),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect((await db.select().from(questV2ProofSubmission).where(eq(questV2ProofSubmission.questId, questId)))).toHaveLength(1);
  });

  it('rolls back proof-free completion when the Work Conversation transition fails', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    await reserveQuest(questId, 1_020);
    configureQuestWorkChatMembershipWriter({
      applyQuestTransition: async (_transaction, transition) => {
        if (transition.type === 'questBecameReadOnly') throw new Error('chat unavailable');
        return { conversationId: 'proof-v2-behavior-rollback', outcome: 'APPLIED' as const };
      },
    });

    const response = await request(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmation`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-rollback-confirm' },
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('QUEST_COMPLETION_UNAVAILABLE');
    expect(await db.select().from(questV2CompletionConfirmation).where(eq(questV2CompletionConfirmation.questId, questId))).toEqual([]);
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_IN_PROGRESS');
    expect((await db.select({ status: questAssignment.assignmentStatus }).from(questAssignment).where(eq(questAssignment.questId, questId)))[0]?.status).toBe('ASSIGNMENT_ACTIVE');
  });

  it('closes the real Work Conversation at proof-free completion', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest({ proofRequired: false });
    const [assignment] = await db.select({ id: questAssignment.id, workerId: questAssignment.workerId })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId));
    if (!assignment) throw new Error('Behavior fixture Assignment was not created');
    const productionWriter = createWorkChatMembershipWriter();
    const acceptedAt = new Date();
    await db.transaction((transaction) => productionWriter.applyQuestTransition(transaction, {
      producer: 'QUEST_ASSIGNMENT_V2',
      type: 'workersAccepted',
      commandId: `proof-v2-behavior-chat-accepted-${questId}`,
      eventId: `proof-v2-behavior-chat-accepted-event-${questId}`,
      questId,
      actorId: hirer.id,
      occurredAt: acceptedAt.toISOString(),
      hirerId: hirer.id,
      workers: [{
        workerId: assignment.workerId,
        assignmentId: assignment.id,
        joinedAt: acceptedAt.toISOString(),
      }],
    }));
    configureQuestWorkChatMembershipWriter(productionWriter);
    await reserveQuest(questId, 1_020);

    const response = await request(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmation`,
      worker.id,
      undefined,
      { 'idempotency-key': `proof-v2-behavior-real-chat-confirm-${questId}` },
    );
    expect(response.status).toBe(200);
    const [conversation] = await db.select({ id: chatConversation.id, readOnlyAt: chatConversation.readOnlyAt, questStatus: chatConversation.questStatus })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    expect(conversation?.readOnlyAt).toBeInstanceOf(Date);
    expect(conversation?.questStatus).toBe('QUEST_COMPLETED');
    expect(await db.select().from(chatMembership).where(eq(chatMembership.conversationId, conversation!.id))).toHaveLength(2);
  });

  it('cleans replay-only uploads and rejects changed multipart metadata', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const { questId } = await createQuest();
    const upload = spyOn(questV2ProofStorage, 'upload').mockImplementation(async (memberId, input) => ({
      bucket: 'proof-v2-behavior-test',
      objectKey: `proof-submissions/${memberId}/${randomUUID()}`,
      contentType: 'application/pdf',
      sizeBytes: input.size,
      fileName: input.name,
    }));
    const remove = spyOn(questV2ProofStorage, 'remove').mockResolvedValue(undefined);

    const firstForm = new FormData();
    firstForm.append('files', new File([new Uint8Array([1, 2, 3])], 'proof.pdf', { type: 'application/pdf' }));
    const first = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      firstForm,
      { 'idempotency-key': `proof-v2-behavior-multipart-replay-${questId}` },
    );
    expect(first.status).toBe(201);

    const replayForm = new FormData();
    replayForm.append('files', new File([new Uint8Array([1, 2, 3])], 'proof.pdf', { type: 'application/pdf' }));
    const replay = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      replayForm,
      { 'idempotency-key': `proof-v2-behavior-multipart-replay-${questId}` },
    );
    expect(replay.status).toBe(201);
    expect(remove).toHaveBeenCalledTimes(1);

    const changedTypeForm = new FormData();
    changedTypeForm.append('files', new File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' }));
    const changedType = await request(
      'POST',
      `/api/v2/quests/${questId}/proof-submissions`,
      worker.id,
      changedTypeForm,
      { 'idempotency-key': `proof-v2-behavior-multipart-replay-${questId}` },
    );
    expect(changedType.status).toBe(409);
    expect((await changedType.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(upload).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('enforces the five-file limit and the storage size boundary', async () => {
    if (!postgresAvailable || !proofSchemaAvailable) return;
    const countQuest = await createQuest();
    const tooManyForm = new FormData();
    for (let index = 0; index < 6; index += 1) {
      tooManyForm.append('files', new File([new Uint8Array([index + 1])], `proof-${index}.pdf`, { type: 'application/pdf' }));
    }
    const tooMany = await request(
      'POST',
      `/api/v2/quests/${countQuest.questId}/proof-submissions`,
      worker.id,
      tooManyForm,
      { 'idempotency-key': `proof-v2-behavior-file-count-${countQuest.questId}` },
    );
    expect(tooMany.status).toBe(400);

    const sizeQuest = await createQuest();
    spyOn(questV2ProofStorage, 'upload').mockRejectedValue(
      new WorkChatAttachmentTooLargeError('Attachment must be 10 MB or smaller'),
    );
    const tooLargeForm = new FormData();
    tooLargeForm.append('files', new File([new Uint8Array([1])], 'large.pdf', { type: 'application/pdf' }));
    const tooLarge = await request(
      'POST',
      `/api/v2/quests/${sizeQuest.questId}/proof-submissions`,
      worker.id,
      tooLargeForm,
      { 'idempotency-key': `proof-v2-behavior-file-size-${sizeQuest.questId}` },
    );
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).error.code).toBe('PROOF_FILE_TOO_LARGE');
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
      { 'idempotency-key': `proof-v2-behavior-candidate-member-${questId}` },
    );
    expect(memberAttempt.status).toBe(403);
    expect((await memberAttempt.json()).error.code).toBe('PROOF_SUBMISSION_NOT_ALLOWED');

    const leaderConfirmation = await request(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmation`,
      worker.id,
      undefined,
      { 'idempotency-key': `proof-v2-behavior-candidate-leader-${questId}` },
    );
    expect(leaderConfirmation.status).toBe(200);
    expect((await leaderConfirmation.json()).data.questStatus).toBe('QUEST_COMPLETED');
    expect((await db.select({ status: questAssignment.assignmentStatus }).from(questAssignment).where(eq(questAssignment.questId, questId)))).toEqual([
      { status: 'ASSIGNMENT_COMPLETED' },
      { status: 'ASSIGNMENT_COMPLETED' },
    ]);
  });
});
