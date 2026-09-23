import { app, createApp } from '@/app';
import { db, sql } from '@/database/client';
import { authSession } from '@/database/schema/auth.schema';
import { chatConversation, chatMembership } from '@/database/schema/work-chat.schema';
import {
  quest,
  questAssignment,
  questCommand,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createQuestV2, type QuestV2CreateInput } from '@/modules/quest';
import { notifyQuestUpdate } from '@/modules/quest/v2/realtime';
import { assignmentStatus, questStatus } from '@/modules/quest/shared';

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

const fixturePrefix = `Quest update ${randomUUID()}`;
const tagId = randomUUID();
const questIds: string[] = [];
const memberIds: string[] = [];
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

const connectToApp = async (questId: string, cookie: string, origin?: string | null) => {
  const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
  const port = server.server?.port;
  if (port === undefined) {
    await server.stop();
    throw new Error('Quest update server did not start');
  }
  try {
    const client = await QuestWebSocketClient.connect(port, questId, cookie, origin);
    return { server, client };
  } catch (error) {
    await server.stop();
    throw error;
  }
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
  if (memberIds.length > 0) {
    await db.delete(questCommand).where(inArray(questCommand.principalUserId, memberIds));
    // Keep members and Idempotency Keys referenced by immutable Wallet history.
  }
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest v2 realtime updates', () => {
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
});
