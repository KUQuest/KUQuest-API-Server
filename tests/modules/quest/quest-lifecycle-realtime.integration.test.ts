import { app, createApp } from '@/app';
import { db, sql } from '@/database/client';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questCommand,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { runQuestLifecycleWorker } from '@/modules/quest/lifecycle';
import { createQuestV2, formatQuestV2ScheduleTime, type QuestV2CreateInput } from '@/modules/quest';
import { assignmentStatus, questStatus } from '@/modules/quest/shared';
import {
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  reserveSpending,
} from '@/modules/wallet';
import { workChatMembershipWriter } from '@/modules/work-chat';
import {
  fundTestWallet,
  readTestQuestEscrow,
  releaseTestQuestEscrows,
} from '../wallet/wallet-test-fixtures';

import { Elysia } from 'elysia';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import { QuestWebSocketClient } from './quest-update-test-client';
import { randomUUID } from 'node:crypto';

const testPassword = 'TestStudent1!';
const members = [
  {
    email: `quest-lifecycle-hirer-${randomUUID()}@ku.th`,
    firstName: 'Lifecycle',
    lastName: 'Hirer',
  },
  {
    email: `quest-lifecycle-worker-${randomUUID()}@ku.th`,
    firstName: 'Lifecycle',
    lastName: 'Worker',
  },
  {
    email: `quest-lifecycle-member-${randomUUID()}@ku.th`,
    firstName: 'Lifecycle',
    lastName: 'Member',
  },
];
const authApps = members.map((member) =>
  new Elysia({ name: `quest-lifecycle-auth-${member.firstName}-${member.lastName}` }).use(
    createStagingTestAuthRoute({
      enabled: true,
      deploymentEnv: 'staging',
      ...member,
      password: testPassword,
    })
  )
);
const sessions: Array<{ id: string; cookie: string }> = [];
const memberIds: string[] = [];
const questIds: string[] = [];
const tagId = randomUUID();
const baseInput: QuestV2CreateInput = {
  title: `Quest lifecycle ${randomUUID()}`,
  description: 'Lifecycle realtime integration fixture',
  condition: { items: ['Complete the assigned work'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 100,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: true,
  locations: [{ label: 'Lifecycle test location' }],
};

const cookieHeader = (response: Response) =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const signIn = async (authRoute: Elysia, email: string) => {
  const response = await authRoute.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: testPassword }),
    })
  );
  if (response.status !== 200) throw new Error(`Test authentication failed: ${response.status}`);
  const body = (await response.json()) as { user: { id: string } };
  return { id: body.user.id, cookie: cookieHeader(response) };
};

const createAssignedQuest = async (
  startTime = baseInput.startTime,
  state: typeof questStatus.assigned | typeof questStatus.inProgress = questStatus.assigned,
  options: {
    mode?: QuestV2CreateInput['mode'];
    participation?: QuestV2CreateInput['participation'];
    headcount?: number;
    workerIds?: string[];
    candidateTeamLeaderId?: string;
  } = {}
) => {
  const [hirer, defaultWorker] = sessions;
  if (!hirer || !defaultWorker) throw new Error('Lifecycle test sessions are missing');
  const workerIds = options.workerIds ?? [defaultWorker.id];
  const result = await createQuestV2(
    hirer.id,
    {
      ...baseInput,
      mode: options.mode ?? baseInput.mode,
      participation: options.participation ?? baseInput.participation,
      headcount: options.headcount ?? baseInput.headcount,
      startTime,
      dueAt: formatQuestV2ScheduleTime(
        new Date(new Date(startTime).getTime() + 2 * 60 * 60 * 1_000)
      ),
    },
    `quest-lifecycle-create-${randomUUID()}`
  );
  if (!('quest' in result)) throw new Error(`Quest creation failed: ${result.outcome}`);
  const questId = result.quest.id;
  questIds.push(questId);
  const [current] = await db
    .select({ fundingTotal: quest.questFundingTotalSatang })
    .from(quest)
    .where(eq(quest.id, questId));
  const fundingTotal = current?.fundingTotal;
  if (fundingTotal === null || fundingTotal === undefined) {
    throw new Error(`Quest funding terms are missing for ${questId}`);
  }
  await db.transaction((transaction) =>
    reserveSpending(transaction, {
      ownerUserId: hirer.id,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(fundingTotal),
    })
  );
  const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
  if (!reservation) throw new Error(`Quest Escrow was not reserved for ${questId}`);
  await db
    .update(quest)
    .set({
      questStatus: state,
      fundingReservationId: reservation.id,
      policyRevisionId: reservation.policyRevisionId,
      rewardSatang: fundingTotal - 20,
      platformFeePerWorkerSatang: 20,
      questEscrowSatang: fundingTotal,
    })
    .where(eq(quest.id, questId));
  if (options.candidateTeamLeaderId) {
    const teamId = randomUUID();
    await db.insert(questCandidateTeamV2).values({
      id: teamId,
      questId,
      leaderId: options.candidateTeamLeaderId,
      name: `Lifecycle Candidate team ${teamId}`,
      headcount: workerIds.length,
      state: 'TEAM_SELECTED',
    });
    await db
      .insert(questCandidateTeamV2Member)
      .values(workerIds.map((memberId) => ({ teamId, memberId })));
  }
  await db.insert(questAssignment).values(
    workerIds.map((workerId) => ({
      questId,
      workerId,
      assignmentStatus: assignmentStatus.active,
    }))
  );
  return questId;
};

const connectToApp = async (questId: string, cookie: string) => {
  const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
  const port = server.server?.port;
  if (port === undefined) {
    await server.stop();
    throw new Error('Quest lifecycle server did not start');
  }
  try {
    const client = await QuestWebSocketClient.connect(port, questId, cookie);
    return { server, client };
  } catch (error) {
    await server.stop();
    throw error;
  }
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
  for (const [index, member] of members.entries()) {
    const session = await signIn(authApps[index]!, member.email);
    sessions.push(session);
    memberIds.push(session.id);
    await ensureWallet(session.id);
  }
  await fundTestWallet(sessions[0]!.id, 100_000);
  await db.insert(tag).values({ id: tagId, name: `Lifecycle realtime ${tagId}` });
});

afterAll(async () => {
  if (memberIds.length > 0) await releaseTestQuestEscrows([memberIds[0]!]);
  if (questIds.length > 0) await db.delete(quest).where(inArray(quest.id, questIds));
  if (memberIds.length > 0) {
    await db.delete(questCommand).where(inArray(questCommand.principalUserId, memberIds));
    // Wallet history references its Idempotency Keys, so keep these members.
  }
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest lifecycle realtime updates', () => {
  it('does not announce or perform an automatic Start Work transition', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Lifecycle test sessions are missing');
    const questId = await createAssignedQuest('1900-08-26T10:00:00.000+07:00');
    const futureQuestId = await createAssignedQuest('3000-08-26T10:00:00.000+07:00');
    const hirerConnection = await connectToApp(questId, hirer.cookie);
    let workerSocket: QuestWebSocketClient | undefined;
    let futureSocket: QuestWebSocketClient | undefined;
    try {
      workerSocket = await QuestWebSocketClient.connect(
        hirerConnection.server.server!.port!,
        questId,
        worker.cookie
      );
      futureSocket = await QuestWebSocketClient.connect(
        hirerConnection.server.server!.port!,
        futureQuestId,
        worker.cookie
      );
      for (const socket of [hirerConnection.client, workerSocket, futureSocket]) {
        expect(JSON.parse((await socket.nextText())!)).toMatchObject({
          type: 'SUBSCRIBED',
          version: 1,
        });
      }

      await runQuestLifecycleWorker({
        batchSize: 1,
        clock: { now: () => new Date('1900-08-26T11:00:00.000+07:00') },
        autoApprove: async () => [],
      });
      for (const socket of [hirerConnection.client, workerSocket, futureSocket]) {
        expect(await socket.nextText(250)).toBeUndefined();
      }
      const response = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
          headers: { cookie: worker.cookie },
        })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { id: questId, state: 'QUEST_ASSIGNED' },
      });
    } finally {
      hirerConnection.client.destroy();
      workerSocket?.destroy();
      futureSocket?.destroy();
      await hirerConnection.server.stop();
    }
  });

  it('does not automatically start Candidate Group work', async () => {
    const [hirer, leader, member] = sessions;
    if (!hirer || !leader || !member) throw new Error('Lifecycle test sessions are missing');
    const questId = await createAssignedQuest(
      '1900-08-26T10:30:00.000+07:00',
      questStatus.assigned,
      {
        mode: 'CANDIDATE',
        participation: 'GROUP',
        headcount: 2,
        workerIds: [leader.id, member.id],
        candidateTeamLeaderId: leader.id,
      }
    );
    const hirerConnection = await connectToApp(questId, hirer.cookie);
    const workerSockets: QuestWebSocketClient[] = [];
    try {
      for (const participant of [leader, member]) {
        workerSockets.push(
          await QuestWebSocketClient.connect(
            hirerConnection.server.server!.port!,
            questId,
            participant.cookie
          )
        );
      }
      for (const socket of [hirerConnection.client, ...workerSockets]) {
        expect(JSON.parse((await socket.nextText())!)).toMatchObject({
          type: 'SUBSCRIBED',
          version: 1,
          questId,
        });
      }
      await runQuestLifecycleWorker({
        batchSize: 1,
        clock: { now: () => new Date('1900-08-26T11:00:00.000+07:00') },
        autoApprove: async () => [],
      });
      for (const socket of [hirerConnection.client, ...workerSockets]) {
        expect(await socket.nextText(250)).toBeUndefined();
      }
      for (const participant of [leader, member]) {
        const response = await app.handle(
          new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
            headers: { cookie: participant.cookie },
          })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          data: { id: questId, state: 'QUEST_ASSIGNED' },
        });
      }
    } finally {
      workerSockets.forEach((socket) => socket.destroy());
      hirerConnection.client.destroy();
      await hirerConnection.server.stop();
    }
  });

  it('notifies then closes a Worker after assigned-state Hirer cancellation', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Lifecycle test sessions are missing');
    const questId = await createAssignedQuest();
    const hirerConnection = await connectToApp(questId, hirer.cookie);
    let workerSocket: QuestWebSocketClient | undefined;
    const workChatSpy = spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
      async () => ({ conversationId: 'lifecycle-realtime-test', outcome: 'APPLIED' })
    );
    try {
      workerSocket = await QuestWebSocketClient.connect(
        hirerConnection.server.server!.port!,
        questId,
        worker.cookie
      );
      expect(JSON.parse((await hirerConnection.client.nextText())!)).toMatchObject({
        type: 'SUBSCRIBED',
        questId,
      });
      expect(JSON.parse((await workerSocket.nextText())!)).toMatchObject({
        type: 'SUBSCRIBED',
        questId,
      });

      const response = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/cancel`, {
          method: 'POST',
          headers: { cookie: hirer.cookie, 'idempotency-key': `quest-lifecycle-cancel-${questId}` },
        })
      );
      expect(response.status).toBe(200);
      const expected = {
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'QUEST_CANCELLED',
      };
      expect(JSON.parse((await hirerConnection.client.nextText())!)).toEqual(expected);
      expect(JSON.parse((await workerSocket.nextText())!)).toEqual(expected);
      const replay = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/cancel`, {
          method: 'POST',
          headers: { cookie: hirer.cookie, 'idempotency-key': `quest-lifecycle-cancel-${questId}` },
        })
      );
      expect(replay.status).toBe(200);
      expect(await hirerConnection.client.nextText(250)).toBeUndefined();
      const recovery = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
          headers: { cookie: worker.cookie },
        })
      );
      expect(recovery.status).toBe(200);
      expect(await recovery.json()).toMatchObject({
        data: {
          id: questId,
          state: 'QUEST_CANCELLED',
          assignmentStatus: 'ASSIGNMENT_CANCELLED',
        },
      });
    } finally {
      workChatSpy.mockRestore();
      hirerConnection.client.destroy();
      workerSocket?.destroy();
      await hirerConnection.server.stop();
    }
  });
  it('recovers cancellation from REST when the Worker is disconnected', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Lifecycle test sessions are missing');
    const questId = await createAssignedQuest();
    const hirerConnection = await connectToApp(questId, hirer.cookie);
    const workChatSpy = spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
      async () => ({ conversationId: 'lifecycle-realtime-test', outcome: 'APPLIED' })
    );
    try {
      expect(JSON.parse((await hirerConnection.client.nextText())!)).toMatchObject({
        type: 'SUBSCRIBED',
        questId,
      });
      const response = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/cancel`, {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'idempotency-key': `quest-lifecycle-offline-${questId}`,
          },
        })
      );
      expect(response.status).toBe(200);
      expect(JSON.parse((await hirerConnection.client.nextText())!)).toEqual({
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'QUEST_CANCELLED',
      });
      const recovery = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
          headers: { cookie: worker.cookie },
        })
      );
      expect(recovery.status).toBe(200);
      expect(await recovery.json()).toMatchObject({
        data: {
          id: questId,
          state: 'QUEST_CANCELLED',
          assignmentStatus: 'ASSIGNMENT_CANCELLED',
        },
      });
    } finally {
      workChatSpy.mockRestore();
      hirerConnection.client.destroy();
      await hirerConnection.server.stop();
    }
  });

  it('publishes cancellation while a Quest is in progress', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Lifecycle test sessions are missing');
    const questId = await createAssignedQuest(baseInput.startTime, questStatus.inProgress);
    const hirerConnection = await connectToApp(questId, hirer.cookie);
    let workerSocket: QuestWebSocketClient | undefined;
    const workChatSpy = spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
      async () => ({ conversationId: 'lifecycle-realtime-test', outcome: 'APPLIED' })
    );
    try {
      workerSocket = await QuestWebSocketClient.connect(
        hirerConnection.server.server!.port!,
        questId,
        worker.cookie
      );
      await hirerConnection.client.nextText();
      await workerSocket.nextText();
      const response = await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/cancel`, {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'idempotency-key': `quest-lifecycle-in-progress-${questId}`,
          },
        })
      );
      expect(response.status).toBe(200);
      expect(JSON.parse((await hirerConnection.client.nextText())!)).toMatchObject({
        type: 'QUEST_UPDATED',
        questId,
        changeType: 'QUEST_CANCELLED',
      });
      expect(JSON.parse((await workerSocket.nextText())!)).toMatchObject({
        type: 'QUEST_UPDATED',
        questId,
        changeType: 'QUEST_CANCELLED',
      });
      expect((await workerSocket.nextFrame())?.opcode).toBe(8);
    } finally {
      workChatSpy.mockRestore();
      hirerConnection.client.destroy();
      workerSocket?.destroy();
      await hirerConnection.server.stop();
    }
  });

  it('does not notify or cancel when the cancellation transaction rolls back', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Lifecycle test sessions are missing');
    const questId = await createAssignedQuest();
    const hirerConnection = await connectToApp(questId, hirer.cookie);
    let workerSocket: QuestWebSocketClient | undefined;
    const workChatFailure = spyOn(
      workChatMembershipWriter,
      'applyQuestTransition'
    ).mockImplementation(async () => {
      throw new Error('Work Chat write failed');
    });
    try {
      workerSocket = await QuestWebSocketClient.connect(
        hirerConnection.server.server!.port!,
        questId,
        worker.cookie
      );
      expect(JSON.parse((await hirerConnection.client.nextText())!)).toMatchObject({
        type: 'SUBSCRIBED',
        questId,
      });
      expect(JSON.parse((await workerSocket.nextText())!)).toMatchObject({
        type: 'SUBSCRIBED',
        questId,
      });
      await app.handle(
        new Request(`http://localhost/api/v2/quests/${questId}/cancel`, {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'idempotency-key': `quest-lifecycle-rollback-${questId}`,
          },
        })
      );
      const [storedQuest] = await db
        .select({ state: quest.questStatus })
        .from(quest)
        .where(eq(quest.id, questId));
      const [assignment] = await db
        .select({ state: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(eq(questAssignment.questId, questId));
      expect(storedQuest?.state).toBe('QUEST_ASSIGNED');
      expect(assignment?.state).toBe('ASSIGNMENT_ACTIVE');
      expect(await hirerConnection.client.nextText(250)).toBeUndefined();
      expect(await workerSocket.nextText(250)).toBeUndefined();
    } finally {
      workChatFailure.mockRestore();
      hirerConnection.client.destroy();
      workerSocket?.destroy();
      await hirerConnection.server.stop();
    }
  });
});
