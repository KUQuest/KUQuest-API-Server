import { app, createApp } from '@/app';
import { db, sql } from '@/database/client';
import { authSession } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { chatConversation, chatMembership } from '@/database/schema/work-chat.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2SubmissionFile,
  questCommand,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createQuestV2, type QuestV2CreateInput } from '@/modules/quest';
import { notifyQuestUpdate } from '@/modules/quest/v2/realtime';
import { assignmentStatus, questStatus, startQuestWork } from '@/modules/quest/shared';

import { QuestWebSocketClient } from './quest-update-test-client';
import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const testPassword = 'TestStudent1!';
const members = [
  { email: `quest-update-hirer-${randomUUID()}@ku.th`, firstName: 'Update', lastName: 'Hirer' },
  { email: `quest-update-worker-${randomUUID()}@ku.th`, firstName: 'Update', lastName: 'Worker' },
  {
    email: `quest-update-worker-two-${randomUUID()}@ku.th`,
    firstName: 'Second',
    lastName: 'Worker',
  },
  {
    email: `quest-update-outsider-${randomUUID()}@ku.th`,
    firstName: 'Update',
    lastName: 'Outsider',
  },
];
const authApps = members.map((member) =>
  new Elysia({ name: `quest-update-auth-${member.firstName}-${member.lastName}` }).use(
    createStagingTestAuthRoute({
      enabled: true,
      deploymentEnv: 'staging',
      ...member,
      password: testPassword,
    })
  )
);
const getCookieHeader = (response: Response) =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const signIn = async (auth: Elysia, email: string) => {
  const response = await auth.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: testPassword }),
    })
  );
  if (response.status !== 200) throw new Error(`Test authentication failed: ${response.status}`);
  const body = (await response.json()) as { user: { id: string } };
  return { id: body.user.id, cookie: getCookieHeader(response) };
};

const createFreshSessions = async () =>
  Promise.all(members.map((member, index) => signIn(authApps[index]!, member.email)));

const fixturePrefix = `Quest update ${randomUUID()}`;
const tagId = randomUUID();
const questIds: string[] = [];
const memberIds: string[] = [];
const fileIds: string[] = [];
const sessions: Array<{ id: string; cookie: string }> = [];
const baseInput: QuestV2CreateInput = {
  title: fixturePrefix,
  description: 'Quest update integration fixture',
  condition: { items: ['Complete the assigned work'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 20,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: true,
  locations: [{ label: 'Quest update location' }],
};

const createAssignedQuest = async (
  workerIds: string[],
  options: {
    mode?: QuestV2CreateInput['mode'];
    state?: 'QUEST_ASSIGNED' | 'QUEST_IN_PROGRESS';
  } = {}
) => {
  const hirerId = sessions[0]?.id;
  if (!hirerId) throw new Error('Hirer session is missing');
  const mode = options.mode ?? 'FIRST_COME_FIRST_SERVED';
  const state = options.state ?? 'QUEST_ASSIGNED';
  const result = await createQuestV2(
    hirerId,
    {
      ...baseInput,
      mode,
      participation: workerIds.length > 1 ? 'GROUP' : 'SINGLE',
      headcount: Math.max(workerIds.length, 1),
    },
    `quest-update-create-${randomUUID()}`
  );
  if (!('quest' in result)) throw new Error(`Quest creation failed: ${result.outcome}`);

  const questId = result.quest.id;
  questIds.push(questId);
  await db
    .update(quest)
    .set({
      questStatus: state,
      rewardSatang: 1234,
      ...(state === 'QUEST_IN_PROGRESS' ? { startTime: new Date(Date.now() - 60_000) } : {}),
    })
    .where(eq(quest.id, questId));
  await db.insert(questAssignment).values(
    workerIds.map((workerId) => ({
      questId,
      workerId,
      assignmentStatus: assignmentStatus.active,
      ...(state === 'QUEST_IN_PROGRESS' ? { startedAt: new Date() } : {}),
    }))
  );
  return questId;
};

const createOpenGroupQuest = async () => {
  const hirerId = sessions[0]?.id;
  if (!hirerId) throw new Error('Hirer session is missing');
  const result = await createQuestV2(
    hirerId,
    { ...baseInput, participation: 'GROUP', headcount: 2 },
    `quest-update-open-group-${randomUUID()}`
  );
  if (!('quest' in result)) throw new Error(`Quest creation failed: ${result.outcome}`);

  const questId = result.quest.id;
  questIds.push(questId);
  await db
    .update(quest)
    .set({ questStatus: questStatus.open, rewardSatang: 1234 })
    .where(eq(quest.id, questId));
  return questId;
};

const createOpenCandidateQuest = async (participation: QuestV2CreateInput['participation']) => {
  const hirerId = sessions[0]?.id;
  if (!hirerId) throw new Error('Hirer session is missing');
  const result = await createQuestV2(
    hirerId,
    {
      ...baseInput,
      mode: 'CANDIDATE',
      participation,
      headcount: participation === 'GROUP' ? 3 : 1,
    },
    `quest-update-open-candidate-${randomUUID()}`
  );
  if (!('quest' in result)) throw new Error(`Quest creation failed: ${result.outcome}`);

  const questId = result.quest.id;
  questIds.push(questId);
  await db
    .update(quest)
    .set({ questStatus: questStatus.open, rewardSatang: 1234 })
    .where(eq(quest.id, questId));
  return questId;
};

type QuestUpdateTestConnection = {
  server: { stop: () => Promise<unknown> };
  client: QuestWebSocketClient;
};

const connectToApp = async (
  questId: string,
  cookie: string,
  origin?: string | null,
  path = `/api/v2/quests/${questId}/events`
) => {
  const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
  const port = server.server?.port;
  if (port === undefined) {
    await server.stop();
    throw new Error('Quest update server did not start');
  }
  try {
    const client = await QuestWebSocketClient.connect(port, questId, cookie, origin, path);
    return { server, client };
  } catch (error) {
    await server.stop();
    throw error;
  }
};
const expectRealtimeSubscription = async (
  connection: QuestUpdateTestConnection,
  questId: string
) => {
  expect(JSON.parse((await connection.client.nextText())!)).toEqual({
    type: 'SUBSCRIBED',
    version: 1,
    questId,
  });
};

const expectCandidateRosterEvent = async (
  connection: QuestUpdateTestConnection,
  questId: string
) => {
  expect(JSON.parse((await connection.client.nextText())!)).toEqual({
    type: 'CANDIDATE_ROSTER_UPDATED',
    version: 1,
    questId,
  });
};

const expectSocketClosedWithCode = async (connection: QuestUpdateTestConnection, code: number) => {
  const frame = await connection.client.nextFrame();
  expect(frame?.opcode).toBe(8);
  expect(frame?.payload.readUInt16BE(0)).toBe(code);
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
beforeAll(async () => {
  await sql`select 1`;
  for (const [index, member] of members.entries()) {
    const signedIn = await signIn(authApps[index]!, member.email);
    sessions.push(signedIn);
    memberIds.push(signedIn.id);
  }
  await db.insert(tag).values({ id: tagId, name: `Quest update tag ${randomUUID()}` });
});

afterAll(async () => {
  if (questIds.length > 0) {
    await deleteWorkChatForQuests(questIds);
    await db.delete(quest).where(inArray(quest.id, questIds));
  }
  if (fileIds.length > 0) {
    await db.delete(file).where(inArray(file.id, fileIds));
  }
  if (memberIds.length > 0) {
    await db.delete(questCommand).where(inArray(questCommand.principalUserId, memberIds));
    // Keep members and Idempotency Keys referenced by immutable Wallet history.
  }
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest v2 realtime updates', () => {
  it('notifies Hirer and open-inquiry Members when a pre-participation Quest changes', async () => {
    const hirer = sessions[0];
    const prospectiveWorker = sessions[1];
    if (!hirer || !prospectiveWorker) throw new Error('Test sessions are missing');

    const questId = await createOpenCandidateQuest('SINGLE');
    const [conversation] = await db
      .insert(chatConversation)
      .values({
        questId,
        type: 'CONVERSATION_CANDIDATE_INQUIRY',
        questTitle: fixturePrefix,
        questStatus: questStatus.open,
        state: 'INQUIRY_OPEN',
        candidateWorkerId: prospectiveWorker.id,
      })
      .returning({ id: chatConversation.id });
    if (!conversation) throw new Error('Candidate Inquiry Conversation was not created');

    const joinedAt = new Date(Date.now() - 1000);
    await db.insert(chatMembership).values([
      {
        conversationId: conversation.id,
        memberId: hirer.id,
        role: 'HIRER',
        joinedAt,
      },
      {
        conversationId: conversation.id,
        memberId: prospectiveWorker.id,
        role: 'PROSPECTIVE_WORKER',
        joinedAt,
      },
    ]);

    const connection = await connectToApp(questId, prospectiveWorker.cookie);
    try {
      await expectRealtimeSubscription(connection, questId);
      const response = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `open-edit-${randomUUID()}`,
            'if-match': '1',
            cookie: hirer.cookie,
          },
          body: JSON.stringify({ title: 'Quest details changed' }),
        })
      );
      expect(response.status).toBe(200);
      const [updatedConversation] = await db
        .select({ questTitle: chatConversation.questTitle })
        .from(chatConversation)
        .where(eq(chatConversation.id, conversation.id));
      expect(updatedConversation?.questTitle).toBe('Quest details changed');
      expect(JSON.parse((await connection.client.nextText())!)).toEqual({
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'QUEST_OPEN_EDIT_UPDATED',
      });
    } finally {
      connection.client.destroy();
      await connection.server.stop();
    }
  });

  it('delivers roster-only updates to the Hirer and current Workers while a GROUP Quest is open', async () => {
    const [hirer, worker, otherWorker] = sessions;
    if (!hirer || !worker || !otherWorker) throw new Error('Test sessions are missing');
    const questId = await createOpenGroupQuest();
    const { server, client: hirerSocket } = await connectToApp(questId, hirer.cookie);
    let workerSocket: QuestWebSocketClient | undefined;

    try {
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });

      const firstJoin = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/join`, {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `quest-update-join-${randomUUID()}`,
          },
        })
      );
      expect(firstJoin.status).toBe(200);
      expect(await firstJoin.json()).toMatchObject({ data: { questState: 'QUEST_OPEN' } });
      const rosterUpdate = {
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'ASSIGNMENT_ROSTER_UPDATED',
      };
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual(rosterUpdate);
      const rosterRead = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/assignments`, {
          headers: { cookie: hirer.cookie },
        })
      );
      expect(rosterRead.status).toBe(200);
      expect((await rosterRead.json()).data.items).toMatchObject([{ workerId: worker.id }]);

      workerSocket = await QuestWebSocketClient.connect(
        server.server!.port!,
        questId,
        worker.cookie
      );
      expect(JSON.parse((await workerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });

      const finalJoin = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/join`, {
          method: 'POST',
          headers: {
            cookie: otherWorker.cookie,
            'idempotency-key': `quest-update-join-${randomUUID()}`,
          },
        })
      );
      expect(finalJoin.status).toBe(200);
      expect(await finalJoin.json()).toMatchObject({ data: { questState: 'QUEST_ASSIGNED' } });
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual(rosterUpdate);
      expect(JSON.parse((await workerSocket.nextText())!)).toEqual(rosterUpdate);

      const restResponse = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
          headers: { cookie: worker.cookie },
        })
      );
      expect(restResponse.status).toBe(200);
      expect(await restResponse.json()).toMatchObject({
        data: { id: questId, state: 'QUEST_ASSIGNED' },
      });
    } finally {
      hirerSocket.destroy();
      workerSocket?.destroy();
      await server.stop();
    }
  });

  it('authorizes assigned and in-progress Quests for both modes and participation shapes', async () => {
    const [, worker, otherWorker] = sessions;
    if (!worker || !otherWorker) throw new Error('Worker sessions are missing');
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest update server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];

    try {
      for (const mode of ['FIRST_COME_FIRST_SERVED', 'CANDIDATE'] as const) {
        for (const participation of ['SINGLE', 'GROUP'] as const) {
          for (const state of ['QUEST_ASSIGNED', 'QUEST_IN_PROGRESS'] as const) {
            const workerIds =
              participation === 'SINGLE' ? [worker.id] : [worker.id, otherWorker.id];
            const questId = await createAssignedQuest(workerIds, { mode, state });
            const socket = await QuestWebSocketClient.connect(port, questId, worker.cookie);
            sockets.push(socket);
            expect(JSON.parse((await socket.nextText())!)).toEqual({
              type: 'SUBSCRIBED',
              version: 1,
              questId,
            });

            const read = await app.handle(
              new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
                headers: { cookie: worker.cookie },
              })
            );
            expect(read.status).toBe(200);
            expect(await read.json()).toMatchObject({ data: { id: questId, state } });
          }
        }
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });

  it('keeps the Hirer live through terminal states and leaves former Worker recovery on REST', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest update server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];

    try {
      for (const [state, assignmentState] of [
        [questStatus.completed, assignmentStatus.completed],
        [questStatus.cancelled, assignmentStatus.cancelled],
      ] as const) {
        const questId = await createAssignedQuest([worker.id]);
        await db
          .update(quest)
          .set({
            questStatus: state,
            ...(state === questStatus.cancelled
              ? { cancelledAt: new Date(), cancelledByUserId: hirer.id }
              : {}),
          })
          .where(eq(quest.id, questId));
        await db
          .update(questAssignment)
          .set({ assignmentStatus: assignmentState })
          .where(eq(questAssignment.questId, questId));

        const hirerSocket = await QuestWebSocketClient.connect(port, questId, hirer.cookie);
        sockets.push(hirerSocket);
        expect(JSON.parse((await hirerSocket.nextText())!)).toEqual({
          type: 'SUBSCRIBED',
          version: 1,
          questId,
        });

        const workerDenied = await QuestWebSocketClient.connect(port, questId, worker.cookie)
          .then(async (socket) => {
            try {
              return (await socket.nextFrame())?.opcode === 8;
            } finally {
              socket.destroy();
            }
          })
          .catch(() => true);
        expect(workerDenied).toBe(true);

        const restResponse = await app.handle(
          new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
            headers: { cookie: worker.cookie },
          })
        );
        expect(restResponse.status).toBe(200);
        expect(await restResponse.json()).toMatchObject({ data: { id: questId, state } });
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });

  it('authorizes current participants and sends only committed, recipient-scoped updates', async () => {
    const [hirer, worker, otherWorker, outsider] = sessions;
    if (!hirer || !worker || !otherWorker || !outsider)
      throw new Error('Test sessions are missing');
    const questId = await createAssignedQuest([worker.id, otherWorker.id]);
    const { server, client: hirerSocket } = await connectToApp(questId, hirer.cookie);
    let workerSocket: QuestWebSocketClient | undefined;
    let otherWorkerSocket: QuestWebSocketClient | undefined;

    try {
      workerSocket = await QuestWebSocketClient.connect(
        server.server!.port!,
        questId,
        worker.cookie,
        null
      );
      otherWorkerSocket = await QuestWebSocketClient.connect(
        server.server!.port!,
        questId,
        otherWorker.cookie
      );

      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });
      expect(JSON.parse((await workerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });
      expect(JSON.parse((await otherWorkerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });

      const outsiderRejected = await QuestWebSocketClient.connect(
        server.server!.port!,
        questId,
        outsider.cookie
      )
        .then(async (socket) => {
          try {
            return (await socket.nextFrame())?.opcode === 8;
          } finally {
            socket.destroy();
          }
        })
        .catch(() => true);
      expect(outsiderRejected).toBe(true);

      const invalidSession = await QuestWebSocketClient.connect(
        server.server!.port!,
        questId,
        ''
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(invalidSession).toBeInstanceOf(Error);
      expect((invalidSession as Error).message).toContain(' 401 ');

      const invalidOriginCloseCode = await QuestWebSocketClient.connect(
        server.server!.port!,
        questId,
        worker.cookie,
        'https://untrusted.example'
      ).then(
        async (socket) => {
          try {
            const frame = await socket.nextFrame();
            return frame?.opcode === 8 ? frame.payload.readUInt16BE(0) : undefined;
          } finally {
            socket.destroy();
          }
        },
        () => undefined
      );
      expect(invalidOriginCloseCode).toBe(4403);

      const restResponse = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
          headers: { cookie: worker.cookie },
        })
      );
      expect(restResponse.status).toBe(200);
      expect(await restResponse.json()).toMatchObject({
        data: { id: questId, state: 'QUEST_ASSIGNED' },
      });

      await db.transaction((transaction) =>
        notifyQuestUpdate(transaction, {
          questId,
          recipientMemberIds: [hirer.id, worker.id],
          changeType: 'QUEST_STARTED',
        })
      );
      const expectedUpdate = {
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'QUEST_STARTED',
      };
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual(expectedUpdate);
      expect(JSON.parse((await workerSocket.nextText())!)).toEqual(expectedUpdate);
      // The short network timeout proves that a non-recipient gets no frame.
      expect(await otherWorkerSocket.nextText(250)).toBeUndefined();

      expect(
        db.transaction(async (transaction) => {
          await notifyQuestUpdate(transaction, {
            questId,
            recipientMemberIds: [worker.id],
            changeType: 'PROOF_SUBMITTED',
          });
          throw new Error('rollback notification');
        })
      ).rejects.toThrow('rollback notification');
      expect(await workerSocket.nextText(250)).toBeUndefined();

      otherWorkerSocket.sendText('{"type":"read","cursor":"ignored"}');
      const rejectedCommand = await otherWorkerSocket.nextFrame();
      expect(rejectedCommand?.opcode).toBe(8);
      expect(rejectedCommand?.payload.readUInt16BE(0)).toBe(1008);
    } finally {
      hirerSocket.destroy();
      workerSocket?.destroy();
      otherWorkerSocket?.destroy();
      await server.stop();
    }
  });

  it('allows a former Worker only while their on-time Proof is pending after failure', async () => {
    const [hirer, worker, otherWorker] = sessions;
    if (!hirer || !worker || !otherWorker) throw new Error('Test sessions are missing');
    const questId = await createAssignedQuest([worker.id, otherWorker.id]);
    const dueAt = new Date(Date.now() - 60_000);
    const failedAt = new Date();
    await db
      .update(quest)
      .set({
        questStatus: questStatus.failed,
        startTime: new Date(Date.now() - 120_000),
        dueAt,
        failedAt,
      })
      .where(eq(quest.id, questId));
    await db
      .update(questAssignment)
      .set({ assignmentStatus: assignmentStatus.incomplete })
      .where(eq(questAssignment.questId, questId));
    await db.insert(questV2ProofSubmission).values({
      questId,
      workerId: worker.id,
      submittedByUserId: worker.id,
      submissionStatus: 'PROOF_PENDING',
      sentAt: new Date(dueAt.getTime() - 1_000),
      description: 'Submitted before the deadline',
    });

    const { server, client: proofWorkerSocket } = await connectToApp(questId, worker.cookie);
    let hirerSocket: QuestWebSocketClient | undefined;
    try {
      hirerSocket = await QuestWebSocketClient.connect(server.server!.port!, questId, hirer.cookie);
      expect(JSON.parse((await proofWorkerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });

      const otherWorkerDenied = await QuestWebSocketClient.connect(
        server.server!.port!,
        questId,
        otherWorker.cookie
      )
        .then(async (socket) => {
          try {
            return (await socket.nextFrame())?.opcode === 8;
          } finally {
            socket.destroy();
          }
        })
        .catch(() => true);
      expect(otherWorkerDenied).toBe(true);
      const otherWorkerRead = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
          headers: { cookie: otherWorker.cookie },
        })
      );
      expect(otherWorkerRead.status).toBe(200);
      expect(await otherWorkerRead.json()).toMatchObject({
        data: { id: questId, state: 'QUEST_FAILED' },
      });

      await db.transaction((transaction) =>
        notifyQuestUpdate(transaction, {
          questId,
          recipientMemberIds: [worker.id],
          closeMemberIds: [worker.id],
          changeType: 'PROOF_REVIEWED',
        })
      );
      expect(JSON.parse((await proofWorkerSocket.nextText())!)).toEqual({
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'PROOF_REVIEWED',
      });
      const endedAccessClose = await proofWorkerSocket.nextFrame();
      expect(endedAccessClose?.opcode).toBe(8);
      expect(endedAccessClose?.payload.readUInt16BE(0)).toBe(1000);
    } finally {
      hirerSocket?.destroy();
      proofWorkerSocket.destroy();
      await server.stop();
    }
  });

  it('restores the listener after an API restart and starts with a REST read', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const questId = await createAssignedQuest([worker.id]);
    const first = await connectToApp(questId, hirer.cookie);

    try {
      expect(JSON.parse((await first.client.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });
      first.client.destroy();
      await first.server.stop();

      const second = await connectToApp(questId, worker.cookie);
      try {
        expect(JSON.parse((await second.client.nextText())!)).toEqual({
          type: 'SUBSCRIBED',
          version: 1,
          questId,
        });
        const restResponse = await app.handle(
          new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
            headers: { cookie: worker.cookie },
          })
        );
        expect(restResponse.status).toBe(200);
        expect(await restResponse.json()).toMatchObject({
          data: { id: questId, state: 'QUEST_ASSIGNED' },
        });

        await db.transaction((transaction) =>
          notifyQuestUpdate(transaction, {
            questId,
            recipientMemberIds: [worker.id],
            changeType: 'QUEST_STARTED',
          })
        );
        expect(JSON.parse((await second.client.nextText())!)).toMatchObject({
          type: 'QUEST_UPDATED',
          questId,
          changeType: 'QUEST_STARTED',
        });
        await db.delete(authSession).where(eq(authSession.userId, worker.id));
        await db.transaction((transaction) =>
          notifyQuestUpdate(transaction, {
            questId,
            recipientMemberIds: [worker.id],
            changeType: 'PROOF_REVIEWED',
          })
        );
        const revokedSessionClose = await second.client.nextFrame();
        expect(revokedSessionClose?.opcode).toBe(8);
        expect(revokedSessionClose?.payload.readUInt16BE(0)).toBe(4401);
      } finally {
        second.client.destroy();
        await second.server.stop();
      }
    } finally {
      first.client.destroy();
    }
  });
  it('delivers SINGLE Candidate invalidations only to Hirer and affected applications', async () => {
    const [hirer, candidate, otherCandidate, laterCandidate] = await createFreshSessions();
    if (!hirer || !candidate || !otherCandidate || !laterCandidate) {
      throw new Error('Test sessions are missing');
    }

    const questId = await createOpenCandidateQuest('SINGLE');
    const path = `/api/v2/quests/${questId}/candidate-roster/events`;
    const connections: QuestUpdateTestConnection[] = [];
    const apply = async (cookie: string) =>
      app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/applications`, {
          method: 'POST',
          headers: { cookie, 'idempotency-key': `candidate-apply-${randomUUID()}` },
        })
      );

    try {
      const hirerRoster = await connectToApp(questId, hirer.cookie, undefined, path);
      connections.push(hirerRoster);
      await expectRealtimeSubscription(hirerRoster, questId);
      const questUpdates = await connectToApp(questId, hirer.cookie);
      connections.push(questUpdates);
      await expectRealtimeSubscription(questUpdates, questId);

      const candidateApply = await apply(candidate.cookie);
      const otherCandidateApply = await apply(otherCandidate.cookie);
      expect(candidateApply.status).toBe(200);
      expect(otherCandidateApply.status).toBe(200);
      const applicationId = (await candidateApply.json()).data.id as string;
      const otherApplicationId = (await otherCandidateApply.json()).data.id as string;
      await expectCandidateRosterEvent(hirerRoster, questId);
      await expectCandidateRosterEvent(hirerRoster, questId);

      const candidateStream = await connectToApp(questId, candidate.cookie, undefined, path);
      connections.push(candidateStream);
      await expectRealtimeSubscription(candidateStream, questId);
      const otherCandidateStream = await connectToApp(
        questId,
        otherCandidate.cookie,
        undefined,
        path
      );
      connections.push(otherCandidateStream);
      await expectRealtimeSubscription(otherCandidateStream, questId);

      const outsiderStream = await connectToApp(questId, laterCandidate.cookie, undefined, path);
      connections.push(outsiderStream);
      await expectSocketClosedWithCode(outsiderStream, 4403);

      const rejection = await app.handle(
        new Request(
          `http://localhost/api/v2/quests/${questId}/applications/${applicationId}/reject`,
          {
            method: 'POST',
            headers: {
              cookie: hirer.cookie,
              'idempotency-key': `candidate-reject-${randomUUID()}`,
            },
          }
        )
      );
      expect(rejection.status).toBe(200);
      await expectCandidateRosterEvent(hirerRoster, questId);
      await expectCandidateRosterEvent(candidateStream, questId);
      expect(await otherCandidateStream.client.nextFrame(250)).toBeUndefined();

      const withdrawal = await app.handle(
        new Request(
          `http://localhost/api/v2/quests/${questId}/applications/${otherApplicationId}/withdraw`,
          {
            method: 'POST',
            headers: {
              cookie: otherCandidate.cookie,
              'idempotency-key': `candidate-withdraw-${randomUUID()}`,
            },
          }
        )
      );
      expect(withdrawal.status).toBe(200);
      await expectCandidateRosterEvent(hirerRoster, questId);
      await expectCandidateRosterEvent(otherCandidateStream, questId);
      expect(await candidateStream.client.nextFrame(250)).toBeUndefined();
      expect(await questUpdates.client.nextFrame(250)).toBeUndefined();

      const laterApply = await apply(laterCandidate.cookie);
      expect(laterApply.status).toBe(200);
      const laterApplicationId = (await laterApply.json()).data.id as string;
      await expectCandidateRosterEvent(hirerRoster, questId);
      const laterCandidateStream = await connectToApp(
        questId,
        laterCandidate.cookie,
        undefined,
        path
      );
      connections.push(laterCandidateStream);
      await expectRealtimeSubscription(laterCandidateStream, questId);

      const selection = await app.handle(
        new Request(
          `http://localhost/api/v2/quests/${questId}/applications/${laterApplicationId}/select`,
          {
            method: 'POST',
            headers: {
              cookie: hirer.cookie,
              'idempotency-key': `candidate-select-${randomUUID()}`,
            },
          }
        )
      );
      expect(selection.status).toBe(200);
      await expectCandidateRosterEvent(hirerRoster, questId);
      await expectCandidateRosterEvent(laterCandidateStream, questId);
      expect(await candidateStream.client.nextFrame(250)).toBeUndefined();
      expect(await otherCandidateStream.client.nextFrame(250)).toBeUndefined();

      const [candidateRoster, otherCandidateRoster, laterCandidateRoster, hirerRosterResponse] =
        await Promise.all([
          app.handle(
            new Request(`http://localhost/api/v2/quests/${questId}/applications`, {
              headers: { cookie: candidate.cookie },
            })
          ),
          app.handle(
            new Request(`http://localhost/api/v2/quests/${questId}/applications`, {
              headers: { cookie: otherCandidate.cookie },
            })
          ),
          app.handle(
            new Request(`http://localhost/api/v2/quests/${questId}/applications`, {
              headers: { cookie: laterCandidate.cookie },
            })
          ),
          app.handle(
            new Request(`http://localhost/api/v2/quests/${questId}/applications`, {
              headers: { cookie: hirer.cookie },
            })
          ),
        ]);
      expect(candidateRoster.status).toBe(200);
      expect((await candidateRoster.json()).data.items).toMatchObject([
        { id: applicationId, state: 'APPLICATION_REJECTED' },
      ]);
      expect(otherCandidateRoster.status).toBe(200);
      expect((await otherCandidateRoster.json()).data.items).toMatchObject([
        { id: otherApplicationId, state: 'APPLICATION_WITHDRAWN' },
      ]);
      expect(laterCandidateRoster.status).toBe(200);
      expect((await laterCandidateRoster.json()).data.items).toMatchObject([
        { id: laterApplicationId, state: 'APPLICATION_SELECTED' },
      ]);
      expect(hirerRosterResponse.status).toBe(200);
      expect((await hirerRosterResponse.json()).data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: applicationId, state: 'APPLICATION_REJECTED' }),
          expect.objectContaining({ id: otherApplicationId, state: 'APPLICATION_WITHDRAWN' }),
          expect.objectContaining({ id: laterApplicationId, state: 'APPLICATION_SELECTED' }),
        ])
      );

      const now = new Date();
      await db
        .update(quest)
        .set({
          startTime: new Date(now.getTime() - 1_000),
          dueAt: new Date(now.getTime() + 60_000),
        })
        .where(eq(quest.id, questId));
      const started = await startQuestWork(
        'v2',
        laterCandidate.id,
        questId,
        `candidate-start-${randomUUID()}`,
        now
      );
      expect(started).toMatchObject({ questId, questStatus: 'QUEST_IN_PROGRESS' });
      for (const connection of [
        hirerRoster,
        candidateStream,
        otherCandidateStream,
        laterCandidateStream,
      ]) {
        await expectCandidateRosterEvent(connection, questId);
        await expectSocketClosedWithCode(connection, 4403);
      }
      const closedRoster = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/applications`, {
          headers: { cookie: laterCandidate.cookie },
        })
      );
      expect(closedRoster.status).toBe(404);
    } finally {
      for (const connection of connections) {
        connection.client.destroy();
        await connection.server.stop();
      }
    }
  });

  it('invalidates GROUP Candidate Team changes and closes members who leave', async () => {
    const [hirer, teamLeader, teamMember, outsider] = await createFreshSessions();
    if (!hirer || !teamLeader || !teamMember || !outsider) {
      throw new Error('Test sessions are missing');
    }

    const questId = await createOpenCandidateQuest('GROUP');
    const path = `/api/v2/quests/${questId}/candidate-roster/events`;
    const connections: QuestUpdateTestConnection[] = [];

    try {
      const hirerStream = await connectToApp(questId, hirer.cookie, undefined, path);
      connections.push(hirerStream);
      await expectRealtimeSubscription(hirerStream, questId);

      const teamCreate = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/teams`, {
          method: 'POST',
          headers: {
            cookie: teamLeader.cookie,
            'content-type': 'application/json',
            'idempotency-key': `candidate-team-create-${randomUUID()}`,
          },
          body: JSON.stringify({ name: 'Roster Team', headcount: 3 }),
        })
      );
      expect(teamCreate.status).toBe(201);
      const team = (await teamCreate.json()).data;
      await expectCandidateRosterEvent(hirerStream, questId);

      const leaderStream = await connectToApp(questId, teamLeader.cookie, undefined, path);
      connections.push(leaderStream);
      await expectRealtimeSubscription(leaderStream, questId);

      const rename = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/teams/${team.id}`, {
          method: 'PATCH',
          headers: {
            cookie: teamLeader.cookie,
            'content-type': 'application/json',
            'idempotency-key': `candidate-team-rename-${randomUUID()}`,
          },
          body: JSON.stringify({ name: 'Renamed Roster Team' }),
        })
      );
      expect(rename.status).toBe(200);
      await expectCandidateRosterEvent(hirerStream, questId);
      await expectCandidateRosterEvent(leaderStream, questId);

      const join = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/teams/${team.id}/join`, {
          method: 'POST',
          headers: {
            cookie: teamMember.cookie,
            'content-type': 'application/json',
            'idempotency-key': `candidate-team-join-${randomUUID()}`,
          },
          body: JSON.stringify({ joinCode: team.joinCode }),
        })
      );
      expect(join.status).toBe(200);
      await expectCandidateRosterEvent(hirerStream, questId);
      await expectCandidateRosterEvent(leaderStream, questId);

      const memberStream = await connectToApp(questId, teamMember.cookie, undefined, path);
      connections.push(memberStream);
      await expectRealtimeSubscription(memberStream, questId);
      const outsiderStream = await connectToApp(questId, outsider.cookie, undefined, path);
      connections.push(outsiderStream);
      await expectSocketClosedWithCode(outsiderStream, 4403);

      const memberLeave = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/teams/${team.id}/leave`, {
          method: 'POST',
          headers: {
            cookie: teamMember.cookie,
            'idempotency-key': `candidate-team-leave-${randomUUID()}`,
          },
        })
      );
      expect(memberLeave.status).toBe(200);
      await expectCandidateRosterEvent(hirerStream, questId);
      await expectCandidateRosterEvent(leaderStream, questId);
      await expectSocketClosedWithCode(memberStream, 4403);

      const memberRead = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/teams/${team.id}`, {
          headers: { cookie: teamMember.cookie },
        })
      );
      expect(memberRead.status).toBe(404);

      const leaderLeave = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/teams/${team.id}/leave`, {
          method: 'POST',
          headers: {
            cookie: teamLeader.cookie,
            'idempotency-key': `candidate-team-final-leave-${randomUUID()}`,
          },
        })
      );
      expect(leaderLeave.status).toBe(200);
      await expectCandidateRosterEvent(hirerStream, questId);
      await expectSocketClosedWithCode(leaderStream, 4403);
    } finally {
      for (const connection of connections) {
        connection.client.destroy();
        await connection.server.stop();
      }
    }
  });
  it('sends a final GROUP Candidate invalidation before closing sockets on selection', async () => {
    const [hirer, teamLeader, teamMember] = await createFreshSessions();
    if (!hirer || !teamLeader || !teamMember) {
      throw new Error('Test sessions are missing');
    }

    const questId = await createOpenCandidateQuest('GROUP');
    const path = `/api/v2/quests/${questId}/candidate-roster/events`;
    const connections: QuestUpdateTestConnection[] = [];
    const teamCreate = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}/teams`, {
        method: 'POST',
        headers: {
          cookie: teamLeader.cookie,
          'content-type': 'application/json',
          'idempotency-key': `candidate-team-create-${randomUUID()}`,
        },
        body: JSON.stringify({ name: 'Selection Team', headcount: 2 }),
      })
    );
    expect(teamCreate.status).toBe(201);
    const team = (await teamCreate.json()).data;

    const join = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}/teams/${team.id}/join`, {
        method: 'POST',
        headers: {
          cookie: teamMember.cookie,
          'content-type': 'application/json',
          'idempotency-key': `candidate-team-join-${randomUUID()}`,
        },
        body: JSON.stringify({ joinCode: team.joinCode }),
      })
    );
    expect(join.status).toBe(200);

    const fileId = randomUUID();
    fileIds.push(fileId);
    const submittedAt = new Date();
    await db.transaction(async (transaction) => {
      await transaction.insert(file).values({
        id: fileId,
        bucket: 'test',
        objectKey: `candidate-roster-realtime/${fileId}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 4,
        uploadedByUserId: teamLeader.id,
        deletedAt: null,
        objectDeletedAt: null,
      });
      await transaction.insert(questCandidateTeamV2SubmissionFile).values({
        teamId: team.id,
        fileId,
        position: 0,
        attachedAt: submittedAt,
      });
      await transaction
        .update(questCandidateTeamV2)
        .set({
          state: 'TEAM_SUBMITTED',
          submissionText: 'Candidate Team submission',
          submittedAt,
          joinCodeHash: null,
          joinCodeExpiresAt: null,
        })
        .where(eq(questCandidateTeamV2.id, team.id));
    });

    const teamRead = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}/teams/${team.id}`, {
        headers: { cookie: teamLeader.cookie },
      })
    );
    expect(teamRead.status).toBe(200);
    expect((await teamRead.json()).data).toMatchObject({ state: 'TEAM_SUBMITTED' });

    try {
      const hirerStream = await connectToApp(questId, hirer.cookie, undefined, path);
      connections.push(hirerStream);
      await expectRealtimeSubscription(hirerStream, questId);
      const leaderStream = await connectToApp(questId, teamLeader.cookie, undefined, path);
      connections.push(leaderStream);
      await expectRealtimeSubscription(leaderStream, questId);
      const memberStream = await connectToApp(questId, teamMember.cookie, undefined, path);
      connections.push(memberStream);
      await expectRealtimeSubscription(memberStream, questId);

      const selection = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/teams/${team.id}/select`, {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'idempotency-key': `candidate-team-select-${randomUUID()}`,
          },
        })
      );
      expect(selection.status).toBe(200);
      expect((await selection.json()).data).toMatchObject({ questState: 'QUEST_ASSIGNED' });
      for (const connection of connections) {
        await expectCandidateRosterEvent(connection, questId);
        await expectSocketClosedWithCode(connection, 4403);
      }
    } finally {
      for (const connection of connections) {
        connection.client.destroy();
        await connection.server.stop();
      }
    }
  });
});
