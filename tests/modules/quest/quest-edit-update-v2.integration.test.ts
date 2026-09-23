import { app, createApp } from '@/app';
import { db, sql } from '@/database/client';
import {
  quest,
  questAssignment,
  questCommand,
  questV2EditRequest,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { runQuestLifecycleWorker } from '@/modules/quest/lifecycle/quest-lifecycle.worker';
import { createQuestV2, type QuestV2CreateInput } from '@/modules/quest';
import { assignmentStatus, questStatus } from '@/modules/quest/shared';

import { Elysia } from 'elysia';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { QuestWebSocketClient } from './quest-update-test-client';

const password = 'TestStudent1!';
const members = [
  {
    email: `quest-edit-update-hirer-${crypto.randomUUID()}@ku.th`,
    firstName: 'Edit',
    lastName: 'Hirer',
  },
  {
    email: `quest-edit-update-worker-${crypto.randomUUID()}@ku.th`,
    firstName: 'Edit',
    lastName: 'Worker',
  },
  {
    email: `quest-edit-update-worker-two-${crypto.randomUUID()}@ku.th`,
    firstName: 'Second',
    lastName: 'Worker',
  },
];
const authApps = members.map((member) =>
  new Elysia({ name: `quest-edit-update-auth-${member.firstName}-${member.lastName}` }).use(
    createStagingTestAuthRoute({
      enabled: true,
      deploymentEnv: 'staging',
      ...member,
      password,
    })
  )
);
const cookieHeader = (response: Response) =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');
const signIn = async (auth: Elysia, email: string) => {
  const response = await auth.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  );
  if (response.status !== 200) throw new Error(`Test authentication failed: ${response.status}`);
  const body = (await response.json()) as { user: { id: string } };
  return { id: body.user.id, cookie: cookieHeader(response) };
};

const fixturePrefix = `Quest Edit update ${crypto.randomUUID()}`;
const tagId = crypto.randomUUID();
const questIds: string[] = [];
const memberSessions: Array<{ id: string; cookie: string }> = [];
const baseInput: QuestV2CreateInput = {
  title: fixturePrefix,
  description: 'Quest Edit realtime fixture',
  condition: { items: ['Original condition'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'GROUP',
  questFundingTotal: 40,
  headcount: 2,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: true,
  locations: [],
};

const createAssignedQuest = async () => {
  const hirer = memberSessions[0];
  const firstWorker = memberSessions[1];
  const secondWorker = memberSessions[2];
  if (!hirer || !firstWorker || !secondWorker) throw new Error('Test sessions are missing');
  const result = await createQuestV2(
    hirer.id,
    { ...baseInput, title: `${fixturePrefix} ${crypto.randomUUID()}` },
    `quest-edit-update-create-${crypto.randomUUID()}`
  );
  if (!('quest' in result)) throw new Error(`Quest creation failed: ${result.outcome}`);
  const questId = result.quest.id;
  questIds.push(questId);
  await db
    .update(quest)
    .set({ questStatus: questStatus.assigned, rewardSatang: 1234 })
    .where(eq(quest.id, questId));
  await db.insert(questAssignment).values(
    [firstWorker, secondWorker].map(({ id }) => ({
      questId,
      workerId: id,
      assignmentStatus: assignmentStatus.active,
    }))
  );
  return questId;
};

const createEdit = (questId: string, condition: string) => {
  const hirer = memberSessions[0];
  if (!hirer) throw new Error('Hirer session is missing');
  return app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/edit-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `quest-edit-update-${crypto.randomUUID()}`,
        cookie: hirer.cookie,
      },
      body: JSON.stringify({ condition: { items: [condition] } }),
    })
  );
};

const readEdit = (requestId: string, cookie: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/edit-requests/${requestId}`, {
      headers: { cookie },
    })
  );

const respondToEdit = (requestId: string, cookie: string, decision: string, reason?: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/edit-requests/${requestId}/respond`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `quest-edit-update-response-${crypto.randomUUID()}`,
        cookie,
      },
      body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
    })
  );

const readParticipation = (questId: string, cookie: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
      headers: { cookie },
    })
  );

const connectParticipants = async (questId: string) => {
  const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
  const port = server.server?.port;
  if (port === undefined) {
    await server.stop();
    throw new Error('Quest Edit update server did not start');
  }
  const sockets: QuestWebSocketClient[] = [];
  try {
    for (const member of memberSessions) {
      sockets.push(await QuestWebSocketClient.connect(port, questId, member.cookie));
    }
    for (const socket of sockets) {
      expect(JSON.parse((await socket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });
    }
    return { server, sockets };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await server.stop();
    throw error;
  }
};

const expectEditUpdate = async (
  socket: QuestWebSocketClient,
  questId: string,
  editRequestId: string
) => {
  expect(JSON.parse((await socket.nextText())!)).toEqual({
    type: 'QUEST_UPDATED',
    version: 1,
    questId,
    changeType: 'QUEST_EDIT_UPDATED',
    editRequestId,
  });
};

beforeAll(async () => {
  await sql`select 1`;
  for (const [index, member] of members.entries()) {
    const auth = authApps[index];
    if (!auth) throw new Error('Test auth app is missing');
    memberSessions.push(await signIn(auth, member.email));
  }
  await db.insert(tag).values({ id: tagId, name: fixturePrefix });
});

afterAll(async () => {
  if (questIds.length > 0) await db.delete(quest).where(inArray(quest.id, questIds));
  const memberIds = memberSessions.map(({ id }) => id);
  if (memberIds.length > 0) {
    await db.delete(questCommand).where(inArray(questCommand.principalUserId, memberIds));
  }
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest Edit v2 realtime updates', () => {
  it('notifies participants on creation, each response, and application without leaking responses', async () => {
    const questId = await createAssignedQuest();
    const { server, sockets } = await connectParticipants(questId);
    const [hirer, worker, otherWorker] = sockets;
    const [hirerSession, workerSession, otherWorkerSession] = memberSessions;
    if (
      !hirer ||
      !worker ||
      !otherWorker ||
      !hirerSession ||
      !workerSession ||
      !otherWorkerSession
    ) {
      throw new Error('Test clients are missing');
    }
    try {
      const created = await createEdit(questId, 'Updated condition');
      expect(created.status).toBe(201);
      const requestId = (await created.json()).data.requestId as string;
      await Promise.all(sockets.map((socket) => expectEditUpdate(socket, questId, requestId)));

      const accepted = await respondToEdit(
        requestId,
        workerSession.cookie,
        'EDIT_RESPONSE_ACCEPTED'
      );
      expect(accepted.status).toBe(200);
      await Promise.all(sockets.map((socket) => expectEditUpdate(socket, questId, requestId)));

      const workerRead = await readEdit(requestId, workerSession.cookie);
      const workerData = (await workerRead.json()).data;
      expect(workerData).toMatchObject({
        status: 'EDIT_REQUEST_PENDING',
        ownResponse: { decision: 'EDIT_RESPONSE_ACCEPTED', reason: null },
      });
      expect(workerData).not.toHaveProperty('responses');
      const otherWorkerRead = await readEdit(requestId, otherWorkerSession.cookie);
      const otherWorkerData = (await otherWorkerRead.json()).data;
      expect(otherWorkerData).toMatchObject({
        status: 'EDIT_REQUEST_PENDING',
        ownResponse: { decision: null, reason: null },
      });
      expect(otherWorkerData).not.toHaveProperty('responses');

      const finalAcceptance = await respondToEdit(
        requestId,
        otherWorkerSession.cookie,
        'EDIT_RESPONSE_ACCEPTED'
      );
      expect(finalAcceptance.status).toBe(200);
      await Promise.all(sockets.map((socket) => expectEditUpdate(socket, questId, requestId)));
      const duplicateResponse = await respondToEdit(
        requestId,
        otherWorkerSession.cookie,
        'EDIT_RESPONSE_ACCEPTED'
      );
      expect(duplicateResponse.status).toBe(409);
      expect(await Promise.all(sockets.map((socket) => socket.nextText(250)))).toEqual([
        undefined,
        undefined,
        undefined,
      ]);

      const ownerRead = await readEdit(requestId, hirerSession.cookie);
      expect((await ownerRead.json()).data).toMatchObject({
        status: 'EDIT_REQUEST_APPLIED',
        responseSummary: { acceptedCount: 2, pendingCount: 0 },
      });
      const participation = await readParticipation(questId, workerSession.cookie);
      expect((await participation.json()).data.condition.items).toEqual([
        { position: 0, text: 'Updated condition' },
      ]);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await server.stop();
    }
  });

  it('notifies a failed resolution without exposing the declining Worker response', async () => {
    const questId = await createAssignedQuest();
    const { server, sockets } = await connectParticipants(questId);
    const [hirer, worker, otherWorker] = sockets;
    const [hirerSession, workerSession, otherWorkerSession] = memberSessions;
    if (
      !hirer ||
      !worker ||
      !otherWorker ||
      !hirerSession ||
      !workerSession ||
      !otherWorkerSession
    ) {
      throw new Error('Test clients are missing');
    }
    try {
      const created = await createEdit(questId, 'Declinable condition');
      const requestId = (await created.json()).data.requestId as string;
      await Promise.all(sockets.map((socket) => expectEditUpdate(socket, questId, requestId)));

      const declined = await respondToEdit(
        requestId,
        workerSession.cookie,
        'EDIT_RESPONSE_DECLINED',
        'Private response detail'
      );
      expect(declined.status).toBe(200);
      await Promise.all(sockets.map((socket) => expectEditUpdate(socket, questId, requestId)));

      const workerRead = await readEdit(requestId, otherWorkerSession.cookie);
      const workerData = (await workerRead.json()).data;
      expect(workerData).toMatchObject({
        status: 'EDIT_REQUEST_FAILED',
        responseSummary: { declinedCount: 1 },
        ownResponse: { decision: null, reason: null },
      });
      expect(JSON.stringify(workerData)).not.toContain('Private response detail');
      const ownerRead = await readEdit(requestId, hirerSession.cookie);
      const responses = (await ownerRead.json()).data.responses;
      expect(responses).toEqual(
        expect.arrayContaining([
          {
            workerId: workerSession.id,
            decision: 'EDIT_RESPONSE_DECLINED',
            reason: 'Private response detail',
            respondedAt: expect.any(String),
          },
          { workerId: otherWorkerSession.id, decision: null, reason: null, respondedAt: null },
        ])
      );
      const participation = await readParticipation(questId, workerSession.cookie);
      expect((await participation.json()).data.condition.items).toEqual([
        { position: 0, text: 'Original condition' },
      ]);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await server.stop();
    }
  });

  it('serializes concurrent Edit expiry and Start Work, then rejects late responses', async () => {
    const questId = await createAssignedQuest();
    const { server, sockets } = await connectParticipants(questId);
    const [hirer, worker, otherWorker] = sockets;
    const [hirerSession, workerSession, otherWorkerSession] = memberSessions;
    if (
      !hirer ||
      !worker ||
      !otherWorker ||
      !hirerSession ||
      !workerSession ||
      !otherWorkerSession
    ) {
      throw new Error('Test clients are missing');
    }
    try {
      const created = await createEdit(questId, 'Expired condition');
      const requestId = (await created.json()).data.requestId as string;
      await Promise.all(sockets.map((socket) => expectEditUpdate(socket, questId, requestId)));
      const lifecycleNow = new Date('1970-01-01T00:00:00.000Z');
      await db
        .update(quest)
        .set({ startTime: new Date(lifecycleNow.getTime() - 1_000) })
        .where(eq(quest.id, questId));
      await db
        .update(questV2EditRequest)
        .set({
          createdAt: new Date(lifecycleNow.getTime() - 2_000),
          expiresAt: new Date(lifecycleNow.getTime() - 1_000),
        })
        .where(eq(questV2EditRequest.id, requestId));

      const sweeps = await Promise.all([
        runQuestLifecycleWorker({
          clock: { now: () => lifecycleNow },
          batchSize: 1,
        }),
        runQuestLifecycleWorker({
          clock: { now: () => lifecycleNow },
          batchSize: 1,
        }),
      ]);
      expect(sweeps.flatMap(({ startedQuestIds }) => startedQuestIds)).toEqual([questId]);
      expect(sweeps.flatMap(({ timedOutEditRequestIds }) => timedOutEditRequestIds)).toEqual([
        requestId,
      ]);
      await Promise.all(sockets.map((socket) => expectEditUpdate(socket, questId, requestId)));
      const startedUpdate = {
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'QUEST_STARTED',
      };
      await Promise.all(
        sockets.map(async (socket) => {
          expect(JSON.parse((await socket.nextText())!)).toEqual(startedUpdate);
        })
      );

      const ownerRead = await readEdit(requestId, hirerSession.cookie);
      expect((await ownerRead.json()).data).toMatchObject({
        status: 'EDIT_REQUEST_FAILED',
        failureCode: 'EDIT_REQUEST_TIMEOUT',
      });
      const workerRead = await readEdit(requestId, otherWorkerSession.cookie);
      expect((await workerRead.json()).data).toMatchObject({
        status: 'EDIT_REQUEST_FAILED',
        ownResponse: { decision: null, reason: null },
      });
      const participation = await readParticipation(questId, workerSession.cookie);
      const participationData = (await participation.json()).data;
      expect(participationData).toMatchObject({
        state: 'QUEST_IN_PROGRESS',
        condition: { items: [{ position: 0, text: 'Original condition' }] },
      });
      const lateResponse = await respondToEdit(
        requestId,
        workerSession.cookie,
        'EDIT_RESPONSE_ACCEPTED'
      );
      expect(lateResponse.status).toBe(409);
      const ownerAfterLateResponse = await readEdit(requestId, hirerSession.cookie);
      expect((await ownerAfterLateResponse.json()).data).toMatchObject({
        status: 'EDIT_REQUEST_FAILED',
        failureCode: 'EDIT_REQUEST_TIMEOUT',
      });
      const participationAfterLateResponse = await readParticipation(questId, workerSession.cookie);
      expect((await participationAfterLateResponse.json()).data).toMatchObject({
        state: 'QUEST_IN_PROGRESS',
        condition: { items: [{ position: 0, text: 'Original condition' }] },
      });
      expect(await Promise.all(sockets.map((socket) => socket.nextText(250)))).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await server.stop();
    }
  });
});
