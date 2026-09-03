import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
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
} from '@/modules/work-chat/work-chat.storage';
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
  await db.insert(tag).values({ id: tagId, name: 'Proof v2 behavior test tag' });
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
      { 'idempotency-key': 'proof-v2-behavior-candidate-member' },
    );
    expect(memberAttempt.status).toBe(403);
    expect((await memberAttempt.json()).error.code).toBe('PROOF_SUBMISSION_NOT_ALLOWED');

    const leaderConfirmation = await request(
      'POST',
      `/api/v2/quests/${questId}/completion-confirmation`,
      worker.id,
      undefined,
      { 'idempotency-key': 'proof-v2-behavior-candidate-leader' },
    );
    expect(leaderConfirmation.status).toBe(200);
    expect((await leaderConfirmation.json()).data.questStatus).toBe('QUEST_COMPLETED');
    expect((await db.select({ status: questAssignment.assignmentStatus }).from(questAssignment).where(eq(questAssignment.questId, questId)))).toEqual([
      { status: 'ASSIGNMENT_COMPLETED' },
      { status: 'ASSIGNMENT_COMPLETED' },
    ]);
  });
});
