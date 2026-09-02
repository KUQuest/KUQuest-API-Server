import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

type OpenApiOperation = {
  operationId?: string;
  security?: unknown;
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
  requestBody?: unknown;
  responses?: Record<string, {
    content?: Record<string, { schema?: unknown }>;
  }>;
};

const routeContracts = [
  ['get', '/api/v2/assignments/mine', 'listMyQuestAssignmentsV2', [200, 401, 500], false, false],
  ['get', '/api/v2/quests/{questId}/assignments', 'listQuestAssignmentsV2', [200, 400, 401, 404, 500], true, false],
  ['post', '/api/v2/quests/{questId}/join', 'joinQuestV2', [200, 400, 401, 404, 409, 503], true, true],
  ['get', '/api/v2/quests/{questId}/underfilled', 'getQuestUnderfilledV2', [200, 400, 401, 404, 409, 500, 503], true, false],
  ['post', '/api/v2/quests/{questId}/underfilled/decision', 'decideQuestUnderfilledV2', [200, 400, 401, 404, 409, 500, 503], true, true],
  ['post', '/api/v2/quests/{questId}/underfilled/consent', 'respondToQuestUnderfilledV2', [200, 400, 401, 404, 409, 500, 503], true, true],
  ['post', '/api/v2/quests/{questId}/applications', 'createQuestApplicationV2', [200, 400, 401, 404, 409, 503], true, true],
  ['get', '/api/v2/quests/{questId}/applications', 'listQuestApplicationsV2', [200, 401, 404, 500], true, false],
  ['get', '/api/v2/quests/{questId}/applications/{applicationId}', 'getQuestApplicationV2', [200, 401, 404, 500], true, false],
  ['post', '/api/v2/quests/{questId}/applications/{applicationId}/withdraw', 'withdrawQuestApplicationV2', [200, 400, 401, 404, 409, 503], true, true],
  ['post', '/api/v2/quests/{questId}/applications/{applicationId}/select', 'selectQuestApplicationV2', [200, 400, 401, 404, 409, 503], true, true],
  ['post', '/api/v2/quests/{questId}/teams', 'createQuestCandidateTeamV2', [201, 400, 401, 404, 409, 503], true, true],
  ['get', '/api/v2/quests/{questId}/teams', 'listQuestCandidateTeamsV2', [200, 401, 404, 500], true, false],
  ['get', '/api/v2/quests/{questId}/teams/{teamId}', 'getQuestCandidateTeamV2', [200, 401, 404, 500], true, false],
  ['post', '/api/v2/quests/{questId}/teams/{teamId}/join', 'joinQuestCandidateTeamV2', [200, 400, 401, 404, 409, 503], true, true],
  ['post', '/api/v2/quests/{questId}/teams/{teamId}/leave', 'leaveQuestCandidateTeamV2', [200, 400, 401, 404, 409, 503], true, true],
  ['delete', '/api/v2/quests/{questId}/teams/{teamId}/members/{memberId}', 'removeQuestCandidateTeamMemberV2', [200, 400, 401, 404, 409, 503], true, true],
  ['post', '/api/v2/quests/{questId}/teams/{teamId}/join-code', 'regenerateQuestCandidateTeamJoinCodeV2', [200, 400, 401, 404, 409, 503], true, true],
  ['post', '/api/v2/quests/{questId}/teams/{teamId}/submit', 'submitQuestCandidateTeamV2', [200, 400, 401, 404, 409, 503], true, true],
  ['post', '/api/v2/quests/{questId}/teams/{teamId}/select', 'selectQuestCandidateTeamV2', [200, 400, 401, 404, 409, 503], true, true],
] as const;

const bodyPaths = new Set([
  'post /api/v2/quests/{questId}/underfilled/decision',
  'post /api/v2/quests/{questId}/underfilled/consent',
  'post /api/v2/quests/{questId}/teams',
  'post /api/v2/quests/{questId}/teams/{teamId}/join',
  'post /api/v2/quests/{questId}/teams/{teamId}/submit',
]);

describe('Quest Assignment API v2 contract', () => {
  it('publishes the complete 20-route contract with validation and canonical schemas', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, OpenApiOperation>>;
    };

    expect(routeContracts).toHaveLength(20);
    for (const [method, path, operationId, statuses, hasQuestId, requiresIdempotency] of routeContracts) {
      const operation = document.paths[path]?.[method];
      expect(operation).toBeDefined();
      expect(operation?.operationId).toBe(operationId);
      expect(operation?.security).toEqual([{ betterAuthSession: [] }]);
      expect(Object.keys(operation?.responses ?? {}).map(Number).sort((a, b) => a - b)).toEqual(statuses.slice().sort((a, b) => a - b));

      if (hasQuestId) {
        const pathParameters = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name);
        for (const name of pathParameters) {
          expect(operation?.parameters).toEqual(expect.arrayContaining([
            expect.objectContaining({ name, in: 'path', required: true }),
          ]));
        }
      }
      if (requiresIdempotency) {
        expect(operation?.parameters).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
        ]));
      }
      expect(Boolean(operation?.requestBody)).toBe(bodyPaths.has(`${method} ${path}`));
      for (const documentedResponse of Object.values(operation?.responses ?? {})) {
        expect(documentedResponse.content?.['application/json']?.schema).toBeDefined();
      }

      const successStatus = (statuses as readonly number[]).includes(201) ? '201' : '200';
      const successSchema = operation?.responses?.[successStatus]?.content?.['application/json']?.schema;
      expect(JSON.stringify(successSchema)).not.toMatch(/NO_CANDIDATE|SOLO|INVITATION/);
    }

  });
});
