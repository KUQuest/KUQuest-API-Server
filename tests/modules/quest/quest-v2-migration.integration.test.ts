import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

type OpenApiOperation = {
  operationId?: string;
  parameters?: Array<{ in?: string; name?: string; required?: boolean }>;
  requestBody?: unknown;
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
  });

  it('replaces targeted invitations with Join Code flow and keeps v1 and v2 surfaces isolated', async () => {
    const document = await getDocument();
    const paths = Object.keys(document.paths);

    expect(paths.some((path) => path.startsWith('/api/v2/') && path.includes('/invitations'))).toBe(false);
    expect(document.paths['/api/v2/quests/invitations']?.get).toBeUndefined();
    expect(document.paths['/api/v2/quests/invitations/{invitationId}']?.get).toBeUndefined();
    expect(document.paths['/api/v2/quests/{questId}/reviews/{reviewId}']?.delete).toBeUndefined();

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
});
