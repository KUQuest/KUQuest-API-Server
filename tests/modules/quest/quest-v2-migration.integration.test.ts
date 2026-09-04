import { app } from '@/app';
import { db, sql as postgresSql } from '@/database/client';
import { adminReviewItem } from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2ProofSubmission,
  review as questReview,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  walletFundingReservation,
  walletFundingReservationOperation,
  walletFundingReservationSettlement,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  chatConversation,
  chatMembership,
  chatMessage,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import { auth } from '@/modules/auth';
import {
  configureQuestWorkChatMembershipWriter,
  type QuestTransaction,
} from '@/modules/quest';
import { createWorkChatMembershipWriter } from '@/modules/work-chat';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  releaseFundingReservation,
  reserveSpending,
  signedSatang,
} from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirer = {
  id: randomUUID(),
  email: `migration-v2-hirer-${randomUUID()}@ku.th`,
  firstName: 'Migration',
  lastName: 'Hirer',
};
const worker = {
  id: randomUUID(),
  email: `migration-v2-worker-${randomUUID()}@ku.th`,
  firstName: 'Migration',
  lastName: 'Worker',
};
const secondWorker = {
  id: randomUUID(),
  email: `migration-v2-worker-two-${randomUUID()}@ku.th`,
  firstName: 'Second',
  lastName: 'Worker',
};
const thirdWorker = {
  id: randomUUID(),
  email: `migration-v2-worker-three-${randomUUID()}@ku.th`,
  firstName: 'Third',
  lastName: 'Worker',
};
const fourthWorker = {
  id: randomUUID(),
  email: `migration-v2-worker-four-${randomUUID()}@ku.th`,
  firstName: 'Fourth',
  lastName: 'Worker',
};
const members = [hirer, worker, secondWorker, thirdWorker, fourthWorker];
const tagId = randomUUID();
const questIds: string[] = [];
const fileIds: string[] = [];
let writerFailure: Error | undefined;

type JsonSchema = {
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
};

type OpenApiOperation = {
  operationId?: string;
  parameters?: Array<{ in?: string; name?: string; required?: boolean }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, {
    content?: Record<string, { schema?: unknown }>;
  }>;
  security?: unknown;
};

type OpenApiDocument = {
  paths: Record<string, Partial<Record<'delete' | 'get' | 'patch' | 'post', OpenApiOperation>>>;
};

type V2Target = {
  method: 'delete' | 'get' | 'patch' | 'post';
  operationId: string;
  path: string;
};

type MigrationRow = {
  disposition: 'FOLDED' | 'INTENTIONALLY_NOT_MIGRATED' | 'REPLACED' | 'V2_CONTRACT_REQUIRED';
  legacy: {
    method: 'delete' | 'get' | 'patch' | 'post';
    operationId: string;
    path: string;
    field?: 'name' | 'reworkLimit';
  };
  v2?: V2Target | V2Target[];
};

const migrationRows: MigrationRow[] = [
  {
    disposition: 'INTENTIONALLY_NOT_MIGRATED',
    legacy: {
      method: 'patch',
      operationId: 'updateQuestApplication',
      path: '/api/v1/quests/{questId}/applications/{applicationId}',
    },
  },
  {
    disposition: 'V2_CONTRACT_REQUIRED',
    legacy: {
      method: 'patch',
      operationId: 'updateQuestTeam',
      path: '/api/v1/quests/{questId}/teams/{teamId}',
      field: 'name',
    },
    v2: {
      method: 'patch',
      operationId: 'updateQuestCandidateTeamV2',
      path: '/api/v2/quests/{questId}/teams/{teamId}',
    },
  },
  {
    disposition: 'INTENTIONALLY_NOT_MIGRATED',
    legacy: {
      method: 'patch',
      operationId: 'updateQuestTeam',
      path: '/api/v1/quests/{questId}/teams/{teamId}',
      field: 'reworkLimit',
    },
  },
  {
    disposition: 'FOLDED',
    legacy: {
      method: 'get',
      operationId: 'listQuestTeamMembers',
      path: '/api/v1/quests/{questId}/teams/{teamId}/members',
    },
    v2: {
      method: 'get',
      operationId: 'getQuestCandidateTeamV2',
      path: '/api/v2/quests/{questId}/teams/{teamId}',
    },
  },
  {
    disposition: 'REPLACED',
    legacy: {
      method: 'post',
      operationId: 'createQuestTeamInvitation',
      path: '/api/v1/quests/{questId}/teams/{teamId}/invitations',
    },
    v2: {
      method: 'post',
      operationId: 'createQuestCandidateTeamV2',
      path: '/api/v2/quests/{questId}/teams',
    },
  },
  {
    disposition: 'REPLACED',
    legacy: {
      method: 'get',
      operationId: 'listQuestTeamInvitations',
      path: '/api/v1/quests/{questId}/teams/{teamId}/invitations',
    },
    v2: {
      method: 'get',
      operationId: 'getQuestCandidateTeamV2',
      path: '/api/v2/quests/{questId}/teams/{teamId}',
    },
  },
  {
    disposition: 'REPLACED',
    legacy: {
      method: 'delete',
      operationId: 'revokeQuestTeamInvitation',
      path: '/api/v1/quests/{questId}/teams/{teamId}/invitations/{invitationId}',
    },
    v2: {
      method: 'post',
      operationId: 'regenerateQuestCandidateTeamJoinCodeV2',
      path: '/api/v2/quests/{questId}/teams/{teamId}/join-code',
    },
  },
  {
    disposition: 'REPLACED',
    legacy: {
      method: 'get',
      operationId: 'listOwnQuestInvitations',
      path: '/api/v1/quests/invitations',
    },
  },
  {
    disposition: 'REPLACED',
    legacy: {
      method: 'get',
      operationId: 'getOwnQuestInvitation',
      path: '/api/v1/quests/invitations/{invitationId}',
    },
  },
  {
    disposition: 'REPLACED',
    legacy: {
      method: 'post',
      operationId: 'acceptQuestTeamInvitation',
      path: '/api/v1/quests/invitations/{invitationId}/accept',
    },
    v2: {
      method: 'post',
      operationId: 'joinQuestCandidateTeamV2',
      path: '/api/v2/quests/{questId}/teams/{teamId}/join',
    },
  },
  {
    disposition: 'REPLACED',
    legacy: {
      method: 'post',
      operationId: 'declineQuestTeamInvitation',
      path: '/api/v1/quests/invitations/{invitationId}/decline',
    },
  },
  {
    disposition: 'V2_CONTRACT_REQUIRED',
    legacy: {
      method: 'post',
      operationId: 'submitQuestProof',
      path: '/api/v1/quests/{questId}/proof',
    },
    v2: [
      {
        method: 'post',
        operationId: 'createQuestV2ProofSubmission',
        path: '/api/v2/quests/{questId}/proof-submissions',
      },
      {
        method: 'post',
        operationId: 'submitQuestV2ProofSubmission',
        path: '/api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}/submit',
      },
    ],
  },
  {
    disposition: 'V2_CONTRACT_REQUIRED',
    legacy: {
      method: 'get',
      operationId: 'listQuestProofs',
      path: '/api/v1/quests/{questId}/proof',
    },
    v2: {
      method: 'get',
      operationId: 'listQuestV2ProofSubmissions',
      path: '/api/v2/quests/{questId}/proof-submissions',
    },
  },
  {
    disposition: 'V2_CONTRACT_REQUIRED',
    legacy: {
      method: 'post',
      operationId: 'confirmQuestWork',
      path: '/api/v1/quests/{questId}/proof/confirm',
    },
    v2: {
      method: 'post',
      operationId: 'confirmQuestV2Completion',
      path: '/api/v2/quests/{questId}/completion-confirmation',
    },
  },
  {
    disposition: 'V2_CONTRACT_REQUIRED',
    legacy: {
      method: 'post',
      operationId: 'reviewQuestProof',
      path: '/api/v1/quests/{questId}/proof/{proofId}/review',
    },
    v2: {
      method: 'post',
      operationId: 'reviewQuestV2ProofSubmission',
      path: '/api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}/review',
    },
  },
  {
    disposition: 'V2_CONTRACT_REQUIRED',
    legacy: {
      method: 'post',
      operationId: 'createQuestReview',
      path: '/api/v1/quests/{questId}/reviews',
    },
    v2: {
      method: 'post',
      operationId: 'createQuestReviewV2',
      path: '/api/v2/quests/{questId}/reviews',
    },
  },
  {
    disposition: 'V2_CONTRACT_REQUIRED',
    legacy: {
      method: 'patch',
      operationId: 'updateQuestReview',
      path: '/api/v1/quests/{questId}/reviews/{reviewId}',
    },
    v2: {
      method: 'patch',
      operationId: 'updateQuestReviewV2',
      path: '/api/v2/quests/{questId}/reviews/{reviewId}',
    },
  },
  {
    disposition: 'INTENTIONALLY_NOT_MIGRATED',
    legacy: {
      method: 'delete',
      operationId: 'deleteQuestReview',
      path: '/api/v1/quests/{questId}/reviews/{reviewId}',
    },
  },
  {
    disposition: 'V2_CONTRACT_REQUIRED',
    legacy: {
      method: 'post',
      operationId: 'cancelQuest',
      path: '/api/v1/quests/{questId}/cancel',
    },
    v2: {
      method: 'post',
      operationId: 'cancelQuestV2',
      path: '/api/v2/quests/{questId}/cancel',
    },
  },
];

const requiredV2CanonicalValues = [
  'FIRST_COME_FIRST_SERVED',
  'CANDIDATE',
  'SINGLE',
  'GROUP',
  'QUEST_DRAFT',
  'QUEST_OPEN',
  'QUEST_ASSIGNED',
  'QUEST_IN_PROGRESS',
  'QUEST_COMPLETED',
  'QUEST_CANCELLED',
  'QUEST_FAILED',
  'PROOF_PENDING',
  'PROOF_APPROVED',
  'PROOF_NOT_APPROVED',
];

const stateChangingMethods = new Set(['delete', 'patch', 'post']);

const getDocument = async (): Promise<OpenApiDocument> => {
  const response = await app.handle(new Request('http://localhost/openapi/json'));
  return response.json() as Promise<OpenApiDocument>;
};

const targetsFor = (row: MigrationRow): V2Target[] =>
  row.v2 ? (Array.isArray(row.v2) ? row.v2 : [row.v2]) : [];

const assertDocumentedOperation = (
  document: OpenApiDocument,
  target: V2Target,
) => {
  const operation = document.paths[target.path]?.[target.method];
  expect(operation).toBeDefined();
  expect(operation?.operationId).toBe(target.operationId);
  expect(operation?.security).toEqual([{ betterAuthSession: [] }]);

  for (const parameterName of [...target.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name)) {
    expect(operation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'path', name: parameterName, required: true }),
    ]));
  }

  if (stateChangingMethods.has(target.method)) {
    expect(operation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true }),
    ]));
  }

  expect(Object.keys(operation?.responses ?? {})).not.toHaveLength(0);
  for (const response of Object.values(operation?.responses ?? {})) {
    expect(response.content?.['application/json']?.schema).toBeDefined();
  }
};

type CandidateTeam = {
  id: string;
  leaderId: string;
  name: string;
  headcount: number;
  joinCode: string;
  joinCodeExpiresAt: string;
};

const successfulWriter = {
  applyQuestTransition: async (_transaction: QuestTransaction) => {
    if (writerFailure) throw writerFailure;
    return { conversationId: 'migration-test-conversation', outcome: 'APPLIED' as const };
  },
};

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
  const memberId = headers.get('x-member-id') ?? worker.id;
  const member = members.find(({ id }) => id === memberId) ?? worker;
  return { user: member, session: { userId: member.id } } as never;
}) as never);

const request = (
  path: string,
  method = 'GET',
  memberId: string = worker.id,
  headers: HeadersInit = {},
  body?: BodyInit,
) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { 'x-member-id': memberId, ...headers },
  body,
}));

const jsonRequest = (
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  memberId: string,
  body: unknown,
  idempotencyKey: string,
) => request(
  path,
  method,
  memberId,
  { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
  JSON.stringify(body),
);

const createOpenGroupCandidateQuest = async (
  overrides: Partial<typeof quest.$inferInsert> = {},
) => {
  const id = randomUUID();
  questIds.push(id);
  await db.insert(quest).values({
    id,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Quest migration verification',
    condition: 'Complete the work',
    mode: 'CANDIDATE',
    participation: 'GROUP',
    v2Mode: 'CANDIDATE',
    v2Participation: 'GROUP',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1_000,
    questFundingTotalSatang: 2_000,
    platformFeeBps: 200,
    platformFeePerWorkerSatang: 20,
    questEscrowSatang: 2_040,
    tagId,
    headcount: 2,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
    dueAt: new Date('2030-01-01T11:00:00.000Z'),
    proofRequired: true,
    ...overrides,
  });
  return id;
};

const createTeam = async (
  questId: string,
  leaderId: string,
  headcount: number,
  key: string,
  name = 'Migration Team',
) => {
  const response = await jsonRequest(
    `/api/v2/quests/${questId}/teams`,
    'POST',
    leaderId,
    { name, headcount },
    key,
  );
  expect(response.status).toBe(201);
  return (await response.json()).data as CandidateTeam;
};

const joinTeam = (
  questId: string,
  teamId: string,
  memberId: string,
  joinCode: string,
  key: string,
  body: Record<string, unknown> = { joinCode },
) => jsonRequest(
  `/api/v2/quests/${questId}/teams/${teamId}/join`,
  'POST',
  memberId,
  body,
  key,
);

const createFile = async (uploadedByUserId: string) => {
  const id = randomUUID();
  fileIds.push(id);
  await db.insert(file).values({
    id,
    bucket: 'quest-migration-verification',
    objectKey: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 100,
    uploadedByUserId,
  });
  return id;
};

const fundHirer = async (amountSatang: number) => {
  const [wallet] = await db
    .select({ id: walletWallet.id })
    .from(walletWallet)
    .where(eq(walletWallet.userId, hirer.id));
  const [spending] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(eq(walletLedgerAccount.walletId, wallet!.id), eq(walletLedgerAccount.type, 'SPENDING')));
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  if (!spending || !suspense) throw new Error('Migration verification ledger accounts are missing');

  await createSealedLedgerTransaction({
    businessReference: `quest-migration-verification-top-up-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spending.id, amountSatang: signedSatang(amountSatang) },
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
  const [reservation] = await db
    .select({ id: walletFundingReservation.id, policyRevisionId: walletFundingReservation.policyRevisionId })
    .from(walletFundingReservation)
    .where(and(
      eq(walletFundingReservation.ownerUserId, hirer.id),
      eq(walletFundingReservation.callerScope, 'quest'),
      eq(walletFundingReservation.callerReference, questId),
    ));
  if (!reservation) throw new Error('Migration verification Funding Reservation was not created');
  await db.update(quest).set({
    fundingReservationId: reservation.id,
    policyRevisionId: reservation.policyRevisionId,
  }).where(eq(quest.id, questId));
  return reservation.id;
};

const createInProgressSingleQuest = async () => {
  const questId = randomUUID();
  const assignmentId = randomUUID();
  questIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Quest migration proof verification',
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    v2Mode: 'FIRST_COME_FIRST_SERVED',
    v2Participation: 'SINGLE',
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 1_000,
    questFundingTotalSatang: 1_020,
    platformFeeBps: 200,
    platformFeePerWorkerSatang: 20,
    questEscrowSatang: 1_020,
    tagId,
    headcount: 1,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
    dueAt: new Date('2030-01-01T11:00:00.000Z'),
    proofRequired: true,
  });
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId,
    workerId: worker.id,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
  });
  return { questId, assignmentId };
};

const createWorkConversation = async (questId: string, assignmentId: string) => {
  const productionWriter = createWorkChatMembershipWriter();
  const acceptedAt = new Date();
  await db.transaction((transaction) => productionWriter.applyQuestTransition(transaction, {
    producer: 'QUEST_ASSIGNMENT_V2',
    type: 'workersAccepted',
    commandId: `quest-migration-verification-accepted-${questId}`,
    eventId: `quest-migration-verification-accepted-event-${questId}`,
    questId,
    actorId: hirer.id,
    occurredAt: acceptedAt.toISOString(),
    hirerId: hirer.id,
    workers: [{
      workerId: worker.id,
      assignmentId,
      joinedAt: acceptedAt.toISOString(),
    }],
  }));
  configureQuestWorkChatMembershipWriter(productionWriter);
};

const deleteWorkChatForQuests = async (ids: string[]) => {
  if (ids.length === 0) return;
  const conversations = await db
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(inArray(chatConversation.questId, ids));
  const conversationIds = conversations.map(({ id }) => id);
  if (conversationIds.length === 0) return;
  await db.delete(chatMessage).where(inArray(chatMessage.conversationId, conversationIds));
  await db.delete(chatMembership).where(inArray(chatMembership.conversationId, conversationIds));
  await db.delete(chatTransitionCommand).where(inArray(chatTransitionCommand.questId, ids));
  await db.delete(chatConversation).where(inArray(chatConversation.id, conversationIds));
};

const releaseActiveReservations = async (ids: string[]) => {
  if (ids.length === 0) return;
  const reservations = await db
    .select({ id: walletFundingReservation.id, ownerUserId: walletFundingReservation.ownerUserId })
    .from(walletFundingReservation)
    .where(and(
      eq(walletFundingReservation.ownerUserId, hirer.id),
      eq(walletFundingReservation.callerScope, 'quest'),
      inArray(walletFundingReservation.callerReference, ids),
      eq(walletFundingReservation.status, 'ACTIVE'),
    ));
  await Promise.all(reservations.map((reservation) => db.transaction((transaction) =>
    releaseFundingReservation(transaction, {
      ownerUserId: reservation.ownerUserId,
      reservationId: reservation.id,
      operationReference: `quest-migration-verification-cleanup-${randomUUID()}`,
    }),
  )));
};

beforeAll(async () => {
  await postgresSql`select 1`;
  await ensureInitialMoneyPolicy();
  await db.insert(authUser).values(members);
  await db.insert(tag).values({ id: tagId, name: 'Quest migration verification tag' });
  await Promise.all(members.map(({ id }) => ensureWallet(id)));
  await fundHirer(100_000);
});

beforeEach(() => {
  writerFailure = undefined;
  configureQuestWorkChatMembershipWriter(successfulWriter);
});

afterEach(async () => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
  const ids = [...questIds];
  await releaseActiveReservations(ids);
  await deleteWorkChatForQuests(ids);
  if (ids.length > 0) {
    await db.delete(questReview).where(inArray(questReview.questId, ids));
    await db.delete(quest).where(inArray(quest.id, ids));
    questIds.splice(0, questIds.length);
  }
  if (fileIds.length > 0) {
    await db.delete(file).where(inArray(file.id, fileIds));
    fileIds.splice(0, fileIds.length);
  }
});

afterAll(async () => {
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest API v1 to v2 migration verification', () => {
  it('covers the final 18-operation disposition matrix and every concrete v2 target', async () => {
    const document = await getDocument();

    expect(migrationRows).toHaveLength(19);
    expect(new Set(migrationRows.map(({ legacy }) => `${legacy.method} ${legacy.path}`))).toHaveLength(18);
    expect(migrationRows.filter(({ disposition }) => disposition === 'REPLACED')).toHaveLength(7);

    for (const row of migrationRows) {
      const legacyOperation = document.paths[row.legacy.path]?.[row.legacy.method];
      expect(legacyOperation?.operationId).toBe(row.legacy.operationId);

      for (const target of targetsFor(row)) assertDocumentedOperation(document, target);
    }

    const candidateTeamResponse = JSON.stringify(
      document.paths['/api/v2/quests/{questId}/teams/{teamId}']?.get?.responses,
    );
    expect(candidateTeamResponse).toContain('members');
    expect(candidateTeamResponse).toContain('name');
    expect(document.paths['/api/v2/quests/{questId}/teams/{teamId}/members']?.get).toBeUndefined();

    const candidateTeamUpdateSchema = document.paths['/api/v2/quests/{questId}/teams/{teamId}']
      ?.patch?.requestBody?.content?.['application/json']?.schema;
    expect(migrationRows
      .filter(({ legacy }) => legacy.operationId === 'updateQuestTeam')
      .map(({ legacy }) => legacy.field)).toEqual(['name', 'reworkLimit']);
    expect(candidateTeamUpdateSchema).toMatchObject({
      additionalProperties: false,
      required: ['name'],
      properties: { name: expect.any(Object) },
    });
    expect(Object.keys(candidateTeamUpdateSchema?.properties ?? {})).toEqual(['name']);
  });

  it('replaces targeted invitations with Join Code flow and keeps v1 and v2 surfaces isolated', async () => {
    const document = await getDocument();
    const paths = Object.keys(document.paths);

    expect(paths.some((path) => path.startsWith('/api/v2/') && path.includes('/invitations'))).toBe(false);
    expect(document.paths['/api/v2/quests/invitations']?.get).toBeUndefined();
    expect(document.paths['/api/v2/quests/invitations/{invitationId}']?.get).toBeUndefined();
    expect(document.paths['/api/v2/quests/{questId}/reviews/{reviewId}']?.delete).toBeUndefined();
    expect(JSON.stringify(Object.fromEntries(
      Object.entries(document.paths).filter(([path]) => path.startsWith('/api/v2/')),
    ))).not.toContain('invitationId');

    expect(document.paths['/api/v2/quests/{questId}/teams']?.post?.operationId).toBe(
      'createQuestCandidateTeamV2',
    );
    expect(document.paths['/api/v2/quests/{questId}/teams/{teamId}/join']?.post?.operationId).toBe(
      'joinQuestCandidateTeamV2',
    );
    expect(document.paths['/api/v2/quests/{questId}/teams/{teamId}/join-code']?.post?.operationId).toBe(
      'regenerateQuestCandidateTeamJoinCodeV2',
    );
  });

  it('documents only canonical v2 vocabulary and requires Idempotency-Key on every v2 write', async () => {
    const document = await getDocument();
    const v2Text = JSON.stringify(
      Object.fromEntries(Object.entries(document.paths).filter(([path]) => path.startsWith('/api/v2/'))),
    );

    expect(v2Text).not.toMatch(/NO_CANDIDATE|SOLO|QUEST_REWORK|PROOF_REJECTED|PROOF_AUTO_APPROVED|reworkLimit|INVITATION_/);
    for (const value of requiredV2CanonicalValues) expect(v2Text).toContain(value);

    for (const [path, methods] of Object.entries(document.paths)) {
      if (!path.startsWith('/api/v2/')) continue;
      for (const [method, operation] of Object.entries(methods)) {
        if (!stateChangingMethods.has(method)) continue;
        expect(operation.parameters).toEqual(expect.arrayContaining([
          expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true }),
        ]));
        expect(operation.security).toEqual([{ betterAuthSession: [] }]);
      }
    }
  });

  it('enforces the Candidate Team field split and the 24-hour Join Code boundary at the HTTP seam', async () => {
    authenticate();
    const questId = await createOpenGroupCandidateQuest({
      headcount: 3,
      questFundingTotalSatang: 3_000,
      questEscrowSatang: 3_060,
    });

    const oldField = await jsonRequest(
      `/api/v2/quests/${questId}/teams`,
      'POST',
      worker.id,
      { name: 'Legacy field attempt', headcount: 3, reworkLimit: 1 },
      'quest-migration-field-split-create',
    );
    expect(oldField.status).toBe(400);
    expect((await oldField.json()).error.code).toBe('VALIDATION');
    expect(await db.select().from(questCandidateTeamV2).where(eq(questCandidateTeamV2.questId, questId))).toHaveLength(0);

    const team = await createTeam(questId, worker.id, 3, 'quest-migration-join-code-create');
    expect(new Date(team.joinCodeExpiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1_000);
    expect(new Date(team.joinCodeExpiresAt).getTime() - Date.now()).toBeLessThan(25 * 60 * 60 * 1_000);

    const oldInvitationField = await joinTeam(
      questId,
      team.id,
      secondWorker.id,
      team.joinCode,
      'quest-migration-invitation-field',
      { joinCode: team.joinCode, invitationId: randomUUID() },
    );
    expect(oldInvitationField.status).toBe(400);
    expect(await db.select().from(questCandidateTeamV2Member).where(eq(questCandidateTeamV2Member.teamId, team.id))).toHaveLength(1);

    const joined = await joinTeam(
      questId,
      team.id,
      secondWorker.id,
      team.joinCode,
      'quest-migration-join-code-member',
    );
    expect(joined.status).toBe(200);

    const regenerated = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/join-code`,
      'POST',
      worker.id,
      { 'idempotency-key': 'quest-migration-join-code-regenerate' },
    );
    expect(regenerated.status).toBe(200);
    const regeneratedBody = (await regenerated.json()).data as {
      joinCode: string;
      joinCodeExpiresAt: string;
    };
    expect(regeneratedBody.joinCode).not.toBe(team.joinCode);
    expect(new Date(regeneratedBody.joinCodeExpiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1_000);
    expect(new Date(regeneratedBody.joinCodeExpiresAt).getTime() - Date.now()).toBeLessThan(25 * 60 * 60 * 1_000);

    const staleCode = await joinTeam(
      questId,
      team.id,
      thirdWorker.id,
      team.joinCode,
      'quest-migration-stale-join-code',
    );
    expect(staleCode.status).toBe(409);
    expect((await staleCode.json()).error.code).toBe('JOIN_CODE_INVALID');

    await db.update(questCandidateTeamV2)
      .set({ joinCodeExpiresAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(questCandidateTeamV2.id, team.id));
    const expiredCode = await joinTeam(
      questId,
      team.id,
      thirdWorker.id,
      regeneratedBody.joinCode,
      'quest-migration-expired-join-code',
    );
    expect(expiredCode.status).toBe(409);
    expect((await expiredCode.json()).error.code).toBe('JOIN_CODE_EXPIRED');
    expect(await db.select().from(questCandidateTeamV2Member).where(eq(questCandidateTeamV2Member.teamId, team.id))).toHaveLength(2);

    const refreshed = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/join-code`,
      'POST',
      worker.id,
      { 'idempotency-key': 'quest-migration-join-code-refresh-after-expiry' },
    );
    expect(refreshed.status).toBe(200);
    const refreshedBody = (await refreshed.json()).data as {
      joinCode: string;
      joinCodeExpiresAt: string;
    };
    expect(new Date(refreshedBody.joinCodeExpiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1_000);
    expect(new Date(refreshedBody.joinCodeExpiresAt).getTime() - Date.now()).toBeLessThan(25 * 60 * 60 * 1_000);

    const currentCode = await joinTeam(
      questId,
      team.id,
      thirdWorker.id,
      refreshedBody.joinCode,
      'quest-migration-current-join-code',
    );
    expect(currentCode.status).toBe(200);
    expect(await db.select().from(questCandidateTeamV2Member).where(eq(questCandidateTeamV2Member.teamId, team.id))).toHaveLength(3);
  });

  it('verifies real PostgreSQL effects across Candidate Team, Assignment, Work Conversation, Proof, Reward, and Reputation', async () => {
    authenticate();
    const questId = await createOpenGroupCandidateQuest();
    const firstTeam = await createTeam(questId, worker.id, 2, 'quest-migration-concurrent-team-one');
    await joinTeam(
      questId,
      firstTeam.id,
      secondWorker.id,
      firstTeam.joinCode,
      'quest-migration-concurrent-team-one-join',
    );
    const secondTeam = await createTeam(questId, thirdWorker.id, 2, 'quest-migration-concurrent-team-two');
    await joinTeam(
      questId,
      secondTeam.id,
      fourthWorker.id,
      secondTeam.joinCode,
      'quest-migration-concurrent-team-two-join',
    );

    const firstFileId = await createFile(worker.id);
    const secondFileId = await createFile(thirdWorker.id);
    const firstSubmit = await jsonRequest(
      `/api/v2/quests/${questId}/teams/${firstTeam.id}/submit`,
      'POST',
      worker.id,
      { text: 'First team work', fileIds: [firstFileId] },
      'quest-migration-concurrent-team-one-submit',
    );
    const secondSubmit = await jsonRequest(
      `/api/v2/quests/${questId}/teams/${secondTeam.id}/submit`,
      'POST',
      thirdWorker.id,
      { text: 'Second team work', fileIds: [secondFileId] },
      'quest-migration-concurrent-team-two-submit',
    );
    expect(firstSubmit.status).toBe(200);
    expect(secondSubmit.status).toBe(200);

    configureQuestWorkChatMembershipWriter(createWorkChatMembershipWriter());
    const selectionKeys = [
      'quest-migration-concurrent-team-one-select',
      'quest-migration-concurrent-team-two-select',
    ];
    const selectionResponses = await Promise.all([
      request(
        `/api/v2/quests/${questId}/teams/${firstTeam.id}/select`,
        'POST',
        hirer.id,
        { 'idempotency-key': selectionKeys[0] },
      ),
      request(
        `/api/v2/quests/${questId}/teams/${secondTeam.id}/select`,
        'POST',
        hirer.id,
        { 'idempotency-key': selectionKeys[1] },
      ),
    ]);
    expect(selectionResponses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winnerIndex = selectionResponses.findIndex(({ status }) => status === 200);
    if (winnerIndex < 0) throw new Error('Candidate Team selection did not commit');
    const winningTeam = winnerIndex === 0 ? firstTeam : secondTeam;
    const winningSelection = selectionResponses[winnerIndex];
    const winningSelectionBody = await winningSelection!.json();
    const losingResponse = selectionResponses[1 - winnerIndex];
    expect((await losingResponse!.json()).error.code).toBe('QUEST_NOT_OPEN');

    const selectionReplay = await request(
      `/api/v2/quests/${questId}/teams/${winningTeam.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': selectionKeys[winnerIndex] },
    );
    expect(selectionReplay.status).toBe(200);
    expect(await selectionReplay.json()).toEqual(winningSelectionBody);

    const [conversation] = await db
      .select({ id: chatConversation.id, questStatus: chatConversation.questStatus, readOnlyAt: chatConversation.readOnlyAt })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    expect(conversation).toMatchObject({ questStatus: 'QUEST_ASSIGNED', readOnlyAt: null });
    const memberships = await db
      .select({ memberId: chatMembership.memberId, role: chatMembership.role })
      .from(chatMembership)
      .where(eq(chatMembership.conversationId, conversation!.id));
    expect(memberships).toEqual(expect.arrayContaining([
      { memberId: hirer.id, role: 'HIRER' },
      { memberId: winningTeam.leaderId, role: 'WORKER' },
    ]));
    expect(memberships).toHaveLength(3);
    expect(await db.select({ kind: chatMessage.kind }).from(chatMessage)
      .where(eq(chatMessage.conversationId, conversation!.id))).toHaveLength(3);
    expect(await db.select({ processingStatus: chatTransitionCommand.processingStatus })
      .from(chatTransitionCommand).where(eq(chatTransitionCommand.questId, questId))).toEqual([
      { processingStatus: 'COMPLETED' },
    ]);

    await db.update(quest).set({ questStatus: 'QUEST_IN_PROGRESS' }).where(eq(quest.id, questId));
    await reserveQuest(questId, 2_040);
    const proofFileId = await createFile(winningTeam.leaderId);
    const proofCreated = await jsonRequest(
      `/api/v2/quests/${questId}/proof-submissions`,
      'POST',
      winningTeam.leaderId,
      { description: 'Final team proof', fileIds: [proofFileId] },
      'quest-migration-proof-create',
    );
    expect(proofCreated.status).toBe(201);
    const proofSubmissionId = (await proofCreated.json()).data.id as string;
    const proofSent = await request(
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/submit`,
      'POST',
      winningTeam.leaderId,
      { 'idempotency-key': 'quest-migration-proof-submit' },
    );
    expect(proofSent.status).toBe(200);
    expect((await proofSent.json()).data.status).toBe('PROOF_PENDING');

    const approved = await jsonRequest(
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      'POST',
      hirer.id,
      { decision: 'PROOF_APPROVED' },
      'quest-migration-proof-review',
    );
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.data).toMatchObject({
      proof: { id: proofSubmissionId, status: 'PROOF_APPROVED' },
      questStatus: 'QUEST_COMPLETED',
    });
    const approvedReplay = await jsonRequest(
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      'POST',
      hirer.id,
      { decision: 'PROOF_APPROVED' },
      'quest-migration-proof-review',
    );
    expect(approvedReplay.status).toBe(200);
    expect(await approvedReplay.json()).toEqual(approvedBody);

    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status)
      .toBe('QUEST_COMPLETED');
    const assignments = await db
      .select({ workerId: questAssignment.workerId, status: questAssignment.assignmentStatus })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId));
    expect(assignments).toHaveLength(2);
    expect(assignments.every(({ status }) => status === 'ASSIGNMENT_COMPLETED')).toBe(true);
    expect(await db.select({ state: questCandidateTeamV2.state })
      .from(questCandidateTeamV2).where(eq(questCandidateTeamV2.id, winningTeam.id))).toEqual([
      { state: 'TEAM_SELECTED' },
    ]);
    expect(await db.select({ memberId: questCandidateTeamV2Member.memberId })
      .from(questCandidateTeamV2Member).where(eq(questCandidateTeamV2Member.teamId, winningTeam.id))).toHaveLength(2);
    expect(await db.select({ status: questV2ProofSubmission.submissionStatus })
      .from(questV2ProofSubmission).where(eq(questV2ProofSubmission.id, proofSubmissionId))).toEqual([
      { status: 'PROOF_APPROVED' },
    ]);

    const [reservation] = await db
      .select({
        id: walletFundingReservation.id,
        status: walletFundingReservation.status,
        remainingSatang: walletFundingReservation.remainingSatang,
        createdLedgerTransactionId: walletFundingReservation.createdLedgerTransactionId,
      })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.callerReference, questId));
    expect(reservation).toMatchObject({ status: 'SETTLED', remainingSatang: 0 });
    const [reserveLedger] = await db.select({ eventType: walletLedgerTransaction.eventType })
      .from(walletLedgerTransaction).where(eq(walletLedgerTransaction.id, reservation!.createdLedgerTransactionId));
    expect(reserveLedger?.eventType).toBe('FUNDING_RESERVE');
    const settlements = await db
      .select({
        recipientUserId: walletFundingReservationSettlement.recipientUserId,
        recipientAmountSatang: walletFundingReservationSettlement.recipientAmountSatang,
        platformFeeSatang: walletFundingReservationSettlement.platformFeeSatang,
        ledgerTransactionId: walletFundingReservationSettlement.ledgerTransactionId,
      })
      .from(walletFundingReservationSettlement)
      .where(eq(walletFundingReservationSettlement.reservationId, reservation!.id));
    expect(settlements).toHaveLength(2);
    expect(settlements.every(({ recipientUserId }) => recipientUserId === winningTeam.leaderId)).toBe(true);
    expect(settlements.reduce((total, settlement) => total + settlement.recipientAmountSatang, 0)).toBe(2_000);
    expect(settlements.reduce((total, settlement) => total + settlement.platformFeeSatang, 0)).toBe(40);
    const settlementLedgerIds = settlements.map(({ ledgerTransactionId }) => ledgerTransactionId);
    const settlementLedgers = await db.select({
      id: walletLedgerTransaction.id,
      eventType: walletLedgerTransaction.eventType,
    }).from(walletLedgerTransaction).where(inArray(walletLedgerTransaction.id, settlementLedgerIds));
    expect(settlementLedgers).toHaveLength(2);
    expect(settlementLedgers.every(({ eventType }) => eventType === 'FUNDING_SETTLEMENT')).toBe(true);
    const postings = await db.select({
      transactionId: walletLedgerPosting.transactionId,
      amountSatang: walletLedgerPosting.amountSatang,
    }).from(walletLedgerPosting).where(inArray(walletLedgerPosting.transactionId, settlementLedgerIds));
    expect(postings).toHaveLength(6);
    expect(settlementLedgerIds.every((transactionId) => postings
      .filter((posting) => posting.transactionId === transactionId)
      .reduce((total, { amountSatang }) => total + amountSatang, 0) === 0)).toBe(true);

    const reviewResponse = await jsonRequest(
      `/api/v2/quests/${questId}/reviews`,
      'POST',
      hirer.id,
      { revieweeId: winningTeam.leaderId, rating: 5 },
      'quest-migration-review-create',
    );
    expect(reviewResponse.status).toBe(200);
    const reviewBody = await reviewResponse.json();
    const reviewReplays = await Promise.all([
      jsonRequest(
        `/api/v2/quests/${questId}/reviews`,
        'POST',
        hirer.id,
        { revieweeId: winningTeam.leaderId, rating: 5 },
        'quest-migration-review-create',
      ),
      jsonRequest(
        `/api/v2/quests/${questId}/reviews`,
        'POST',
        hirer.id,
        { revieweeId: winningTeam.leaderId, rating: 5 },
        'quest-migration-review-create',
      ),
    ]);
    expect(reviewReplays.map(({ status }) => status)).toEqual([200, 200]);
    expect(await Promise.all(reviewReplays.map((response) => response.json()))).toEqual([reviewBody, reviewBody]);
    expect(await db.select({ reviewerId: questReview.reviewerId, revieweeId: questReview.revieweeId })
      .from(questReview).where(eq(questReview.questId, questId))).toEqual([
      { reviewerId: hirer.id, revieweeId: winningTeam.leaderId },
    ]);
    const reputation = await request('/api/v1/profile/reputation', 'GET', winningTeam.leaderId);
    expect(reputation.status).toBe(200);
    expect((await reputation.json()).data).toMatchObject({
      rating: { average: 5, count: 1 },
    });

    const v1Read = await request(`/api/v1/quests/${questId}`, 'GET', hirer.id);
    expect(v1Read.status).toBe(404);
    expect((await v1Read.json()).error.code).toBe('QUEST_NOT_FOUND');
    const [completedConversation] = await db.select({ readOnlyAt: chatConversation.readOnlyAt })
      .from(chatConversation).where(eq(chatConversation.questId, questId));
    expect(completedConversation?.readOnlyAt).toBeInstanceOf(Date);
  });

  it('rolls back Candidate Team selection atomically and retries the same command after Work Chat failure', async () => {
    authenticate();
    const questId = await createOpenGroupCandidateQuest();
    const team = await createTeam(questId, worker.id, 2, 'quest-migration-rollback-team-create');
    await joinTeam(
      questId,
      team.id,
      secondWorker.id,
      team.joinCode,
      'quest-migration-rollback-team-join',
    );
    const submissionFileId = await createFile(worker.id);
    const submitted = await jsonRequest(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      worker.id,
      { text: 'Rollback team work', fileIds: [submissionFileId] },
      'quest-migration-rollback-team-submit',
    );
    expect(submitted.status).toBe(200);

    const key = 'quest-migration-rollback-team-select';
    writerFailure = new Error('Work Conversation unavailable');
    const failed = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': key },
    );
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status)
      .toBe('QUEST_OPEN');
    expect((await db.select({ state: questCandidateTeamV2.state })
      .from(questCandidateTeamV2).where(eq(questCandidateTeamV2.id, team.id)))[0]?.state)
      .toBe('TEAM_SUBMITTED');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(0);
    expect(await db.select().from(chatConversation).where(eq(chatConversation.questId, questId))).toHaveLength(0);

    writerFailure = undefined;
    configureQuestWorkChatMembershipWriter(createWorkChatMembershipWriter());
    const retry = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': key },
    );
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    const concurrentReplays = await Promise.all([
      request(
        `/api/v2/quests/${questId}/teams/${team.id}/select`,
        'POST',
        hirer.id,
        { 'idempotency-key': key },
      ),
      request(
        `/api/v2/quests/${questId}/teams/${team.id}/select`,
        'POST',
        hirer.id,
        { 'idempotency-key': key },
      ),
    ]);
    expect(concurrentReplays.map(({ status }) => status)).toEqual([200, 200]);
    expect(await Promise.all(concurrentReplays.map((response) => response.json()))).toEqual([retryBody, retryBody]);
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(2);
    expect(await db.select().from(chatConversation).where(eq(chatConversation.questId, questId))).toHaveLength(1);
  });

  it('records one Admin Review Item for a real non-approved Proof and keeps the Funding Reservation active', async () => {
    authenticate();
    const { questId, assignmentId } = await createInProgressSingleQuest();
    await createWorkConversation(questId, assignmentId);
    await reserveQuest(questId, 1_020);
    const proofFileId = await createFile(worker.id);
    const proofCreated = await jsonRequest(
      `/api/v2/quests/${questId}/proof-submissions`,
      'POST',
      worker.id,
      { description: 'Incomplete proof', fileIds: [proofFileId] },
      'quest-migration-failed-proof-create',
    );
    expect(proofCreated.status).toBe(201);
    const proofSubmissionId = (await proofCreated.json()).data.id as string;
    const sent = await request(
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/submit`,
      'POST',
      worker.id,
      { 'idempotency-key': 'quest-migration-failed-proof-submit' },
    );
    expect(sent.status).toBe(200);

    const key = 'quest-migration-failed-proof-review';
    const decision = { decision: 'PROOF_NOT_APPROVED', reason: 'The submitted work is incomplete' };
    const first = await jsonRequest(
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      'POST',
      hirer.id,
      decision,
      key,
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data).toMatchObject({
      proof: { id: proofSubmissionId, status: 'PROOF_NOT_APPROVED' },
      questStatus: 'QUEST_FAILED',
    });
    const replay = await jsonRequest(
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      'POST',
      hirer.id,
      decision,
      key,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const changed = await jsonRequest(
      `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`,
      'POST',
      hirer.id,
      { decision: 'PROOF_NOT_APPROVED', reason: 'Changed reason' },
      key,
    );
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await db.select({ status: questV2ProofSubmission.submissionStatus })
      .from(questV2ProofSubmission).where(eq(questV2ProofSubmission.id, proofSubmissionId))).toEqual([
      { status: 'PROOF_NOT_APPROVED' },
    ]);
    expect(await db.select({ status: questAssignment.assignmentStatus })
      .from(questAssignment).where(eq(questAssignment.id, assignmentId))).toEqual([
      { status: 'ASSIGNMENT_INCOMPLETE' },
    ]);
    expect(await db.select({ reason: adminReviewItem.reason, evidenceReferences: adminReviewItem.evidenceReferences })
      .from(adminReviewItem).where(eq(adminReviewItem.proofSubmissionId, proofSubmissionId))).toEqual([
      { reason: 'The submitted work is incomplete', evidenceReferences: [proofFileId] },
    ]);
    expect(await db.select({ status: walletFundingReservation.status, remainingSatang: walletFundingReservation.remainingSatang })
      .from(walletFundingReservation).where(eq(walletFundingReservation.callerReference, questId))).toEqual([
      { status: 'ACTIVE', remainingSatang: 1_020 },
    ]);
    expect(await db.select().from(walletFundingReservationSettlement)
      .where(eq(walletFundingReservationSettlement.reservationId, (await db.select({ id: walletFundingReservation.id })
        .from(walletFundingReservation).where(eq(walletFundingReservation.callerReference, questId)))[0]!.id))).toHaveLength(0);
  });

  it('keeps the v2 cancellation settlement matrix isolated from v1', async () => {
    authenticate();
    const questId = await createOpenGroupCandidateQuest();
    const reservationId = await reserveQuest(questId, 2_040);
    const key = 'quest-migration-cancel-open';
    const first = await request(
      `/api/v2/quests/${questId}/cancel`,
      'POST',
      hirer.id,
      { 'idempotency-key': key },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data).toEqual({
      questStatus: 'QUEST_CANCELLED',
      outcome: 'CANCELLED',
      paidSatang: 0,
      refundedSatang: 2_040,
    });
    const replay = await request(
      `/api/v2/quests/${questId}/cancel`,
      'POST',
      hirer.id,
      { 'idempotency-key': key },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status)
      .toBe('QUEST_CANCELLED');
    expect(await db.select({ status: walletFundingReservation.status, remainingSatang: walletFundingReservation.remainingSatang })
      .from(walletFundingReservation).where(eq(walletFundingReservation.id, reservationId))).toEqual([
      { status: 'RELEASED', remainingSatang: 0 },
    ]);
    const [release] = await db.select({ ledgerTransactionId: walletFundingReservationOperation.ledgerTransactionId })
      .from(walletFundingReservationOperation).where(and(
        eq(walletFundingReservationOperation.reservationId, reservationId),
        eq(walletFundingReservationOperation.operationType, 'RELEASE'),
      ));
    expect(release).toBeDefined();
    expect(await db.select({ eventType: walletLedgerTransaction.eventType })
      .from(walletLedgerTransaction).where(eq(walletLedgerTransaction.id, release!.ledgerTransactionId))).toEqual([
      { eventType: 'FUNDING_RELEASE' },
    ]);
    const v1Read = await request(`/api/v1/quests/${questId}`, 'GET', hirer.id);
    expect(v1Read.status).toBe(404);
  });
});
