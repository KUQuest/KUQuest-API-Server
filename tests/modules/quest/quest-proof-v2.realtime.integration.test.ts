import { createApp } from '@/app';
import { db, sql } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questCommand,
  questV2CompletionConfirmation,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createQuestV2, formatQuestV2ScheduleTime, type QuestV2CreateInput } from '@/modules/quest';
import { runQuestLifecycleWorker } from '@/modules/quest/lifecycle';
import { positiveSatang, reserveSpending } from '@/modules/wallet';
import { workChatMembershipWriter } from '@/modules/work-chat';

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { randomUUID } from 'node:crypto';

import { QuestWebSocketClient } from './quest-update-test-client';
import {
  fundTestWallet,
  readTestQuestEscrow,
  releaseTestQuestEscrows,
} from '../wallet/wallet-test-fixtures';

const password = 'TestStudent1!';
const members = [
  { email: `proof-live-hirer-${randomUUID()}@ku.th`, firstName: 'Proof', lastName: 'Hirer' },
  { email: `proof-live-worker-${randomUUID()}@ku.th`, firstName: 'Proof', lastName: 'Worker' },
  { email: `proof-live-worker-two-${randomUUID()}@ku.th`, firstName: 'Second', lastName: 'Worker' },
];
const authApps = members.map((member) =>
  new Elysia().use(
    createStagingTestAuthRoute({ enabled: true, deploymentEnv: 'staging', ...member, password })
  )
);
const sessions: Array<{ id: string; cookie: string }> = [];
const questIds: string[] = [];
const fileIds: string[] = [];
let failWorkChatTransition = false;
let restoreWorkChatSpy: (() => void) | undefined;
const tagId = randomUUID();
const baseInput: QuestV2CreateInput = {
  title: `Proof realtime ${randomUUID()}`,
  description: 'Proof realtime integration fixture',
  condition: { items: ['Complete the work'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 20,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: true,
  locations: [{ label: 'Proof realtime location' }],
};

const cookieHeader = (response: Response) =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const signIn = async (authApp: Elysia, email: string) => {
  const response = await authApp.handle(
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

beforeAll(async () => {
  await sql`select 1`;
  for (const [index, member] of members.entries()) {
    const session = await signIn(authApps[index]!, member.email);
    sessions.push(session);
  }
  const hirer = sessions[0];
  if (!hirer) throw new Error('Proof realtime Hirer session is missing');
  await fundTestWallet(hirer.id, 100_000);
  const workChatSpy = spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
    async (_transaction, _transition) => {
      if (failWorkChatTransition) throw new Error('chat unavailable');
      return { conversationId: 'proof-realtime-test', outcome: 'APPLIED' as const };
    }
  );
  restoreWorkChatSpy = () => workChatSpy.mockRestore();
  await db.insert(tag).values({ id: tagId, name: `Proof realtime tag ${tagId}` });
});

afterAll(async () => {
  restoreWorkChatSpy?.();
  if (sessions[0]) await releaseTestQuestEscrows([sessions[0].id]);
  if (questIds.length) await db.delete(quest).where(inArray(quest.id, questIds));
  if (fileIds.length) await db.delete(file).where(inArray(file.id, fileIds));
  if (sessions.length > 0) {
    await db.delete(questCommand).where(
      inArray(
        questCommand.principalUserId,
        sessions.map(({ id }) => id)
      )
    );
  }
  await db.delete(tag).where(eq(tag.id, tagId));
});

const activateQuest = async (questId: string, workerIds: string[]) => {
  const hirer = sessions[0];
  if (!hirer) throw new Error('Proof realtime Hirer session is missing');
  const rewardSatang = 1_000;
  const platformFeePerWorkerSatang = 20;
  const questFundingTotalSatang = rewardSatang * workerIds.length;
  const questEscrowSatang = questFundingTotalSatang + platformFeePerWorkerSatang * workerIds.length;
  await db.transaction((transaction) =>
    reserveSpending(transaction, {
      ownerUserId: hirer.id,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(questEscrowSatang),
    })
  );
  const reservation = await readTestQuestEscrow({ ownerUserId: hirer.id, questId });
  if (!reservation) throw new Error(`Proof realtime Quest Escrow is missing for ${questId}`);
  await db
    .update(quest)
    .set({
      questStatus: 'QUEST_IN_PROGRESS',
      fundingReservationId: reservation.id,
      policyRevisionId: reservation.policyRevisionId,
      questFundingTotalSatang,
      rewardSatang,
      platformFeePerWorkerSatang,
      questEscrowSatang,
    })
    .where(eq(quest.id, questId));
  await db.insert(questAssignment).values(
    workerIds.map((workerId) => ({
      questId,
      workerId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
    }))
  );
};
describe('Quest Proof v2 realtime source updates', () => {
  it('notifies the Hirer only after REST send commits and allows the authorized Proof read', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(hirer.id, baseInput, `proof-live-create-${randomUUID()}`);
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id]);

    const fileId = randomUUID();
    fileIds.push(fileId);
    await db.insert(file).values({
      id: fileId,
      bucket: 'proof-realtime-test',
      objectKey: `${fileId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedByUserId: worker.id,
    });

    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    let hirerSocket: QuestWebSocketClient | undefined;
    let workerSocket: QuestWebSocketClient | undefined;
    try {
      hirerSocket = await QuestWebSocketClient.connect(port, questId, hirer.cookie);
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });
      workerSocket = await QuestWebSocketClient.connect(port, questId, worker.cookie);
      expect(JSON.parse((await workerSocket.nextText())!)).toEqual({
        type: 'SUBSCRIBED',
        version: 1,
        questId,
      });
      const origin = `http://127.0.0.1:${port}`;
      const draftResponse = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        method: 'POST',
        headers: {
          cookie: worker.cookie,
          'content-type': 'application/json',
          'idempotency-key': `proof-live-draft-${randomUUID()}`,
        },
        body: JSON.stringify({ description: 'Sent proof description', fileIds: [fileId] }),
      });
      expect(draftResponse.status).toBe(201);
      const draft = (await draftResponse.json()) as { data: { id: string } };
      const sentResponse = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/submit`,
        {
          method: 'POST',
          headers: { cookie: worker.cookie, 'idempotency-key': `proof-live-send-${randomUUID()}` },
        }
      );
      expect(sentResponse.status).toBe(200);
      const update = JSON.parse((await hirerSocket.nextText())!);
      expect(update).toEqual({
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'PROOF_SUBMITTED',
      });
      expect(JSON.stringify(update)).not.toMatch(/description|reason|reward|evidence|file/i);
      expect(JSON.parse((await workerSocket.nextText())!)).toEqual(update);
      const pendingRead = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        headers: { cookie: hirer.cookie },
      });
      expect(pendingRead.status).toBe(200);
      expect(JSON.stringify(await pendingRead.json())).toContain('PROOF_PENDING');
      workerSocket.destroy();
      const reviewResponse = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/review`,
        {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'content-type': 'application/json',
            'idempotency-key': `proof-live-review-${randomUUID()}`,
          },
          body: JSON.stringify({ decision: 'PROOF_APPROVED', reason: null }),
        }
      );
      expect(reviewResponse.status).toBe(200);
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual({
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'PROOF_REVIEWED',
      });
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual({
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'QUEST_COMPLETED',
      });

      const readResponse = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        headers: { cookie: hirer.cookie },
      });
      expect(readResponse.status).toBe(200);
      const readBody = await readResponse.json();
      expect(JSON.stringify(readBody)).toContain('PROOF_APPROVED');
      expect(JSON.stringify(readBody)).toContain('Sent proof description');
      const workerRead = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        headers: { cookie: worker.cookie },
      });
      expect(workerRead.status).toBe(200);
      expect(JSON.stringify(await workerRead.json())).toContain('PROOF_APPROVED');
    } finally {
      hirerSocket?.destroy();
      workerSocket?.destroy();
      await server.stop();
    }
  });
  it('delivers a Candidate Group Team Leader send to only its current team', async () => {
    const [hirer, leader, teammate] = sessions;
    if (!hirer || !leader || !teammate) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      {
        ...baseInput,
        title: `Candidate proof ${randomUUID()}`,
        mode: 'CANDIDATE',
        participation: 'GROUP',
        headcount: 2,
      },
      `proof-live-candidate-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);

    const teamId = randomUUID();
    await db.insert(questCandidateTeamV2).values({
      id: teamId,
      questId,
      leaderId: leader.id,
      name: `Leader team ${teamId}`,
      headcount: 2,
      state: 'TEAM_SELECTED',
    });
    await db.insert(questCandidateTeamV2Member).values([
      { teamId, memberId: leader.id },
      { teamId, memberId: teammate.id },
    ]);
    await activateQuest(questId, [leader.id, teammate.id]);
    const fileId = randomUUID();
    fileIds.push(fileId);
    await db.insert(file).values({
      id: fileId,
      bucket: 'proof-realtime-test',
      objectKey: `${fileId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedByUserId: leader.id,
    });

    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      for (const member of [hirer, leader, teammate]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'SUBSCRIBED',
          version: 1,
          questId,
        });
      }
      const origin = `http://127.0.0.1:${port}`;
      const draftResponse = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        method: 'POST',
        headers: {
          cookie: leader.cookie,
          'content-type': 'application/json',
          'idempotency-key': `proof-live-candidate-draft-${randomUUID()}`,
        },
        body: JSON.stringify({ description: 'Team proof', fileIds: [fileId] }),
      });
      expect(draftResponse.status).toBe(201);
      for (const socket of sockets) expect(await socket.nextText(250)).toBeUndefined();
      const draft = (await draftResponse.json()) as { data: { id: string } };
      const rejectedSend = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/submit`,
        {
          method: 'POST',
          headers: {
            cookie: teammate.cookie,
            'idempotency-key': `proof-live-nonleader-${randomUUID()}`,
          },
        }
      );
      expect(rejectedSend.ok).toBe(false);
      for (const socket of sockets) expect(await socket.nextText(250)).toBeUndefined();

      const sent = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/submit`,
        {
          method: 'POST',
          headers: {
            cookie: leader.cookie,
            'idempotency-key': `proof-live-candidate-send-${randomUUID()}`,
          },
        }
      );
      expect(sent.status).toBe(200);
      for (const socket of sockets) {
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'QUEST_UPDATED',
          version: 1,
          questId,
          changeType: 'PROOF_SUBMITTED',
        });
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });
  it('auto-approves only at the Review Window boundary through the lifecycle worker', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      { ...baseInput, title: `Automatic approval ${randomUUID()}` },
      `proof-live-auto-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id]);
    const fileId = randomUUID();
    fileIds.push(fileId);
    await db.insert(file).values({
      id: fileId,
      bucket: 'proof-realtime-test',
      objectKey: `${fileId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedByUserId: worker.id,
    });
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    let hirerSocket: QuestWebSocketClient | undefined;
    let workerSocket: QuestWebSocketClient | undefined;
    try {
      hirerSocket = await QuestWebSocketClient.connect(port, questId, hirer.cookie);
      workerSocket = await QuestWebSocketClient.connect(port, questId, worker.cookie);
      await hirerSocket.nextText();
      await workerSocket.nextText();
      const origin = `http://127.0.0.1:${port}`;
      const draftResponse = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        method: 'POST',
        headers: {
          cookie: worker.cookie,
          'content-type': 'application/json',
          'idempotency-key': `proof-live-auto-draft-${randomUUID()}`,
        },
        body: JSON.stringify({ description: 'Automatically approved proof', fileIds: [fileId] }),
      });
      expect(draftResponse.status).toBe(201);
      const draft = (await draftResponse.json()) as { data: { id: string } };
      const sent = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/submit`,
        {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `proof-live-auto-send-${randomUUID()}`,
          },
        }
      );
      expect(sent.status).toBe(200);
      await hirerSocket.nextText();
      await workerSocket.nextText();
      const sentAt = new Date('1900-01-01T00:00:00.000Z');
      await db
        .update(questV2ProofSubmission)
        .set({ sentAt, updatedAt: sentAt })
        .where(eq(questV2ProofSubmission.id, draft.data.id));
      const beforeBoundary = new Date(sentAt.getTime() + 24 * 60 * 60 * 1000 - 1);
      const early = await runQuestLifecycleWorker({
        clock: { now: () => beforeBoundary },
        batchSize: 1,
      });
      expect(early.autoApprovedProofIds).not.toContain(draft.data.id);
      const atBoundary = new Date(sentAt.getTime() + 24 * 60 * 60 * 1000);
      const eligible = await runQuestLifecycleWorker({
        clock: { now: () => atBoundary },
        batchSize: 1,
      });
      expect(eligible.autoApprovedProofIds).toContain(draft.data.id);
      for (const socket of [hirerSocket, workerSocket]) {
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'QUEST_UPDATED',
          version: 1,
          questId,
          changeType: 'PROOF_AUTO_APPROVED',
        });
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'QUEST_UPDATED',
          version: 1,
          questId,
          changeType: 'QUEST_COMPLETED',
        });
      }
      expect((await workerSocket.nextFrame())?.opcode).toBe(8);
      expect(await hirerSocket.nextText(250)).toBeUndefined();
      const repeated = await runQuestLifecycleWorker({
        clock: { now: () => atBoundary },
        batchSize: 1,
      });
      expect(repeated.autoApprovedProofIds).not.toContain(draft.data.id);
      const read = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        headers: { cookie: worker.cookie },
      });
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).toContain('PROOF_APPROVED');
    } finally {
      hirerSocket?.destroy();
      workerSocket?.destroy();
      await server.stop();
    }
  });
  it('confirms proof-free FCFS Single completion through the completion endpoint', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      {
        ...baseInput,
        title: `Proof-free single completion ${randomUUID()}`,
        proofRequired: false,
      },
      `proof-live-single-completion-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id]);
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      for (const member of [hirer, worker]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        await socket.nextText();
      }
      const confirmation = await fetch(
        `http://127.0.0.1:${port}/api/v2/quests/${questId}/completion-confirmation`,
        {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `proof-live-single-complete-${randomUUID()}`,
          },
        }
      );
      expect(confirmation.status).toBe(200);
      for (const socket of sockets) {
        expect(JSON.parse((await socket.nextText())!).changeType).toBe('COMPLETION_CONFIRMED');
        expect(JSON.parse((await socket.nextText())!).changeType).toBe('QUEST_COMPLETED');
      }
      expect((await sockets[1]?.nextFrame())?.opcode).toBe(8);
      expect(await sockets[0]?.nextText(250)).toBeUndefined();
      const read = await fetch(`http://127.0.0.1:${port}/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      });
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).toContain('QUEST_COMPLETED');
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });
  it('confirms proof-free Candidate Group completion as its selected Team Leader', async () => {
    const [hirer, leader, teammate] = sessions;
    if (!hirer || !leader || !teammate) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      {
        ...baseInput,
        title: `Proof-free team completion ${randomUUID()}`,
        mode: 'CANDIDATE',
        participation: 'GROUP',
        headcount: 2,
        proofRequired: false,
      },
      `proof-live-confirm-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);

    const teamId = randomUUID();
    await db.insert(questCandidateTeamV2).values({
      id: teamId,
      questId,
      leaderId: leader.id,
      name: `Completion team ${teamId}`,
      headcount: 2,
      state: 'TEAM_SELECTED',
    });
    await db.insert(questCandidateTeamV2Member).values([
      { teamId, memberId: leader.id },
      { teamId, memberId: teammate.id },
    ]);
    await activateQuest(questId, [leader.id, teammate.id]);
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      for (const member of [hirer, leader, teammate]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        await socket.nextText();
      }
      const origin = `http://127.0.0.1:${port}`;
      const confirmation = await fetch(
        `${origin}/api/v2/quests/${questId}/completion-confirmation`,
        {
          method: 'POST',
          headers: {
            cookie: leader.cookie,
            'idempotency-key': `proof-live-confirm-${randomUUID()}`,
          },
        }
      );
      expect(confirmation.status).toBe(200);
      const confirmationBody = await confirmation.json();
      expect(JSON.stringify(confirmationBody)).toContain('QUEST_COMPLETED');
      for (const socket of sockets) {
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'QUEST_UPDATED',
          version: 1,
          questId,
          changeType: 'COMPLETION_CONFIRMED',
        });
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'QUEST_UPDATED',
          version: 1,
          questId,
          changeType: 'QUEST_COMPLETED',
        });
      }
      for (const socket of sockets.slice(1)) {
        expect((await socket.nextFrame())?.opcode).toBe(8);
      }
      expect(await sockets[0]?.nextText(250)).toBeUndefined();
      const read = await fetch(`${origin}/api/v2/quests/${questId}/participation`, {
        headers: { cookie: leader.cookie },
      });
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).toContain('QUEST_COMPLETED');
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });
  it('preserves on-time Proof access across deadline failure, then applies a final non-approval without reopening', async () => {
    const [hirer, worker, missingWorker] = sessions;
    if (!hirer || !worker || !missingWorker) throw new Error('Test sessions are missing');
    const restDueAt = new Date(Date.now() + 120_000);
    const created = await createQuestV2(
      hirer.id,
      {
        ...baseInput,
        title: `Deadline review ${randomUUID()}`,
        participation: 'GROUP',
        headcount: 2,
        questFundingTotal: 40,
        startTime: formatQuestV2ScheduleTime(new Date(Date.now() + 60_000)),
        dueAt: formatQuestV2ScheduleTime(restDueAt),
      },
      `proof-live-deadline-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id, missingWorker.id]);
    const fileId = randomUUID();
    fileIds.push(fileId);
    await db.insert(file).values({
      id: fileId,
      bucket: 'proof-realtime-test',
      objectKey: `${fileId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedByUserId: worker.id,
    });
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    let hirerSocket: QuestWebSocketClient | undefined;
    let workerSocket: QuestWebSocketClient | undefined;
    try {
      hirerSocket = await QuestWebSocketClient.connect(port, questId, hirer.cookie);
      workerSocket = await QuestWebSocketClient.connect(port, questId, worker.cookie);
      await hirerSocket.nextText();
      await workerSocket.nextText();
      const origin = `http://127.0.0.1:${port}`;
      const draftResponse = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        method: 'POST',
        headers: {
          cookie: worker.cookie,
          'content-type': 'application/json',
          'idempotency-key': `proof-live-deadline-draft-${randomUUID()}`,
        },
        body: JSON.stringify({ description: 'On-time pending Proof', fileIds: [fileId] }),
      });
      expect(draftResponse.status).toBe(201);
      const draft = (await draftResponse.json()) as { data: { id: string } };
      const sent = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/submit`,
        {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `proof-live-deadline-send-${randomUUID()}`,
          },
        }
      );
      expect(sent.status).toBe(200);
      await hirerSocket.nextText();
      await workerSocket.nextText();
      const proofSentAt = new Date('2000-01-01T00:00:00.000Z');
      const workerDueAt = new Date(proofSentAt.getTime() + 12 * 60 * 60 * 1000);
      await db
        .update(quest)
        .set({
          startTime: new Date(proofSentAt.getTime() - 60 * 60 * 1000),
          dueAt: workerDueAt,
        })
        .where(eq(quest.id, questId));
      await db
        .update(questV2ProofSubmission)
        .set({ sentAt: proofSentAt, updatedAt: proofSentAt })
        .where(eq(questV2ProofSubmission.id, draft.data.id));
      const earlyWorkerRun = await runQuestLifecycleWorker({
        clock: { now: () => new Date(workerDueAt.getTime() - 1) },
        batchSize: 1,
      });
      expect(earlyWorkerRun.failedQuestIds).not.toContain(questId);
      expect(await hirerSocket.nextText(250)).toBeUndefined();
      expect(await workerSocket.nextText(250)).toBeUndefined();
      const dueWorkerRun = await runQuestLifecycleWorker({
        clock: { now: () => new Date(workerDueAt.getTime() + 1) },
        batchSize: 1,
      });
      expect(dueWorkerRun.failedQuestIds).toContain(questId);
      for (const socket of [hirerSocket, workerSocket]) {
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'QUEST_UPDATED',
          version: 1,
          questId,
          changeType: 'QUEST_FAILED',
        });
      }
      const review = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/review`,
        {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'content-type': 'application/json',
            'idempotency-key': `proof-live-deadline-review-${randomUUID()}`,
          },
          body: JSON.stringify({ decision: 'PROOF_NOT_APPROVED', reason: 'Work incomplete' }),
        }
      );
      expect(review.status).toBe(200);
      expect(JSON.parse((await workerSocket.nextText())!)).toEqual({
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'PROOF_REVIEWED',
      });
      expect(JSON.parse((await hirerSocket.nextText())!)).toEqual({
        type: 'QUEST_UPDATED',
        version: 1,
        questId,
        changeType: 'PROOF_REVIEWED',
      });
      expect((await workerSocket.nextFrame())?.opcode).toBe(8);
      expect(await hirerSocket.nextText(250)).toBeUndefined();
      const proofRead = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        headers: { cookie: worker.cookie },
      });
      expect(proofRead.status).toBe(200);
      expect(JSON.stringify(await proofRead.json())).toContain('PROOF_NOT_APPROVED');
      const questRead = await fetch(`${origin}/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      });
      expect(questRead.status).toBe(200);
      expect(JSON.stringify(await questRead.json())).toContain('QUEST_FAILED');
    } finally {
      hirerSocket?.destroy();
      workerSocket?.destroy();
      await server.stop();
    }
  });
  it('does not announce whole-Quest completion after one FCFS Group Assignment is approved', async () => {
    const [hirer, worker, otherWorker] = sessions;
    if (!hirer || !worker || !otherWorker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      {
        ...baseInput,
        title: `Partial Group approval ${randomUUID()}`,
        participation: 'GROUP',
        headcount: 2,
        questFundingTotal: 40,
      },
      `proof-live-partial-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id, otherWorker.id]);
    const fileId = randomUUID();
    fileIds.push(fileId);
    await db.insert(file).values({
      id: fileId,
      bucket: 'proof-realtime-test',
      objectKey: `${fileId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedByUserId: worker.id,
    });
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      for (const member of [hirer, worker, otherWorker]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        await socket.nextText();
      }
      const origin = `http://127.0.0.1:${port}`;
      const draftResponse = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        method: 'POST',
        headers: {
          cookie: worker.cookie,
          'content-type': 'application/json',
          'idempotency-key': `proof-live-partial-draft-${randomUUID()}`,
        },
        body: JSON.stringify({ description: 'First Group Assignment', fileIds: [fileId] }),
      });
      expect(draftResponse.status).toBe(201);
      const draft = (await draftResponse.json()) as { data: { id: string } };
      const sent = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/submit`,
        {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `proof-live-partial-send-${randomUUID()}`,
          },
        }
      );
      expect(sent.status).toBe(200);
      await sockets[0]!.nextText();
      await sockets[1]!.nextText();
      expect(await sockets[2]!.nextText(250)).toBeUndefined();
      const review = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/review`,
        {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'content-type': 'application/json',
            'idempotency-key': `proof-live-partial-review-${randomUUID()}`,
          },
          body: JSON.stringify({ decision: 'PROOF_APPROVED', reason: null }),
        }
      );
      expect(review.status).toBe(200);
      for (const socket of sockets.slice(0, 2)) {
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'QUEST_UPDATED',
          version: 1,
          questId,
          changeType: 'PROOF_REVIEWED',
        });
      }
      expect(await sockets[0]!.nextText(250)).toBeUndefined();
      expect(await sockets[1]!.nextText()).toBeUndefined();
      expect(await sockets[2]!.nextText(250)).toBeUndefined();
      const questRead = await fetch(`${origin}/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      });
      expect(questRead.status).toBe(200);
      expect(JSON.stringify(await questRead.json())).toContain('QUEST_IN_PROGRESS');
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });
  it('serializes proof-free completion against Hirer cancellation with one terminal result', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      { ...baseInput, title: `Completion cancellation race ${randomUUID()}`, proofRequired: false },
      `proof-live-race-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id]);
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      for (const member of [hirer, worker]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        await socket.nextText();
      }
      const origin = `http://127.0.0.1:${port}`;
      const [completion, cancellation] = await Promise.all([
        fetch(`${origin}/api/v2/quests/${questId}/completion-confirmation`, {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `proof-live-race-complete-${randomUUID()}`,
          },
        }),
        fetch(`${origin}/api/v2/quests/${questId}/cancel`, {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'idempotency-key': `proof-live-race-cancel-${randomUUID()}`,
          },
        }),
      ]);
      expect(Number(completion.ok) + Number(cancellation.ok)).toBe(1);
      for (const socket of sockets) {
        const first = JSON.parse((await socket.nextText())!);
        if (completion.ok) {
          expect(first.changeType).toBe('COMPLETION_CONFIRMED');
          expect(JSON.parse((await socket.nextText())!).changeType).toBe('QUEST_COMPLETED');
        } else {
          expect(first.changeType).toBe('QUEST_CANCELLED');
        }
      }
      const read = await fetch(`${origin}/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      });
      expect(read.status).toBe(200);
      const current = JSON.stringify(await read.json());
      expect(current).toContain(completion.ok ? 'QUEST_COMPLETED' : 'QUEST_CANCELLED');
      expect(current).not.toContain(completion.ok ? 'QUEST_CANCELLED' : 'QUEST_COMPLETED');
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });
  it('reports missing proof-free completion only when the lifecycle worker fails the due Quest', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const dueAt = new Date('2000-01-02T00:00:00.000Z');
    const created = await createQuestV2(
      hirer.id,
      {
        ...baseInput,
        title: `Missed proof-free work ${randomUUID()}`,
        proofRequired: false,
      },
      `proof-live-proof-free-failure-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await db
      .update(quest)
      .set({ startTime: new Date(dueAt.getTime() - 60 * 60 * 1000), dueAt })
      .where(eq(quest.id, questId));
    await activateQuest(questId, [worker.id]);
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      for (const member of [hirer, worker]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        await socket.nextText();
      }
      const early = await runQuestLifecycleWorker({
        clock: { now: () => new Date(dueAt.getTime() - 1) },
        batchSize: 1,
      });
      expect(early.failedQuestIds).not.toContain(questId);
      for (const socket of sockets) expect(await socket.nextText(250)).toBeUndefined();
      const result = await runQuestLifecycleWorker({
        clock: { now: () => new Date(dueAt.getTime() + 1) },
        batchSize: 1,
      });
      for (const socket of sockets) {
        expect(JSON.parse((await socket.nextText())!)).toEqual({
          type: 'QUEST_UPDATED',
          version: 1,
          questId,
          changeType: 'QUEST_FAILED',
        });
      }
      expect((await sockets[1]?.nextFrame())?.opcode).toBe(8);
      expect(result.failedQuestIds).toContain(questId);
      const read = await fetch(`http://127.0.0.1:${port}/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      });
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).toContain('QUEST_FAILED');
      const participationRead = await fetch(
        `http://127.0.0.1:${port}/api/v2/quests/${questId}/participation`,
        { headers: { cookie: worker.cookie } }
      );
      expect(participationRead.status).toBe(200);
      expect(JSON.stringify(await participationRead.json())).toContain('ASSIGNMENT_INCOMPLETE');
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });
  it('does not emit PROOF_REVIEWED when the REST review transaction rolls back', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      { ...baseInput, title: `Proof review rollback ${randomUUID()}` },
      `proof-live-review-rollback-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id]);
    const fileId = randomUUID();
    fileIds.push(fileId);
    await db.insert(file).values({
      id: fileId,
      bucket: 'proof-realtime-test',
      objectKey: `${fileId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedByUserId: worker.id,
    });
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      const origin = `http://127.0.0.1:${port}`;
      const draftResponse = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        method: 'POST',
        headers: {
          cookie: worker.cookie,
          'content-type': 'application/json',
          'idempotency-key': `proof-live-review-rollback-draft-${randomUUID()}`,
        },
        body: JSON.stringify({ description: 'Pending Proof', fileIds: [fileId] }),
      });
      expect(draftResponse.status).toBe(201);
      const draft = (await draftResponse.json()) as { data: { id: string } };
      const sent = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/submit`,
        {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `proof-live-review-rollback-send-${randomUUID()}`,
          },
        }
      );
      expect(sent.status).toBe(200);
      for (const member of [hirer, worker]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        await socket.nextText();
      }
      failWorkChatTransition = true;
      const review = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/review`,
        {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'content-type': 'application/json',
            'idempotency-key': `proof-live-review-rollback-review-${randomUUID()}`,
          },
          body: JSON.stringify({ decision: 'PROOF_NOT_APPROVED', reason: 'Work is incomplete' }),
        }
      );
      failWorkChatTransition = false;
      expect(review.status).toBe(503);
      expect((await review.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');
      expect(
        (
          await db
            .select({ status: questV2ProofSubmission.submissionStatus })
            .from(questV2ProofSubmission)
            .where(eq(questV2ProofSubmission.id, draft.data.id))
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
      for (const socket of sockets) expect(await socket.nextText(250)).toBeUndefined();
    } finally {
      failWorkChatTransition = false;
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });

  it('does not emit completion updates when the REST transaction rolls back', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      {
        ...baseInput,
        title: `Completion rollback ${randomUUID()}`,
        proofRequired: false,
      },
      `proof-live-completion-rollback-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id]);
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      for (const member of [hirer, worker]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        await socket.nextText();
      }
      failWorkChatTransition = true;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v2/quests/${questId}/completion-confirmation`,
        {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `proof-live-completion-rollback-confirm-${randomUUID()}`,
          },
        }
      );
      failWorkChatTransition = false;
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('QUEST_COMPLETION_UNAVAILABLE');
      expect(
        await db
          .select({ id: questV2CompletionConfirmation.id })
          .from(questV2CompletionConfirmation)
          .where(eq(questV2CompletionConfirmation.questId, questId))
      ).toEqual([]);
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
      for (const socket of sockets) expect(await socket.nextText(250)).toBeUndefined();
    } finally {
      failWorkChatTransition = false;
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });
  it('serializes Hirer review against automatic approval with one committed update', async () => {
    const [hirer, worker] = sessions;
    if (!hirer || !worker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      { ...baseInput, title: `Review auto-approval race ${randomUUID()}` },
      `proof-live-review-auto-race-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    await activateQuest(questId, [worker.id]);
    const fileId = randomUUID();
    fileIds.push(fileId);
    await db.insert(file).values({
      id: fileId,
      bucket: 'proof-realtime-test',
      objectKey: `${fileId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedByUserId: worker.id,
    });
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    let hirerSocket: QuestWebSocketClient | undefined;
    let workerSocket: QuestWebSocketClient | undefined;
    try {
      const origin = `http://127.0.0.1:${port}`;
      const draftResponse = await fetch(`${origin}/api/v2/quests/${questId}/proof-submissions`, {
        method: 'POST',
        headers: {
          cookie: worker.cookie,
          'content-type': 'application/json',
          'idempotency-key': `proof-live-review-auto-race-draft-${randomUUID()}`,
        },
        body: JSON.stringify({ description: 'Proof under review', fileIds: [fileId] }),
      });
      expect(draftResponse.status).toBe(201);
      const draft = (await draftResponse.json()) as { data: { id: string } };
      const sent = await fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/submit`,
        {
          method: 'POST',
          headers: {
            cookie: worker.cookie,
            'idempotency-key': `proof-live-review-auto-race-send-${randomUUID()}`,
          },
        }
      );
      expect(sent.status).toBe(200);
      const workerNow = new Date('1900-01-02T00:00:00.000Z');
      const sentAt = new Date(workerNow.getTime() - 24 * 60 * 60 * 1000);
      await db
        .update(questV2ProofSubmission)
        .set({ sentAt, updatedAt: sentAt })
        .where(eq(questV2ProofSubmission.id, draft.data.id));
      hirerSocket = await QuestWebSocketClient.connect(port, questId, hirer.cookie);
      workerSocket = await QuestWebSocketClient.connect(port, questId, worker.cookie);
      await hirerSocket.nextText();
      await workerSocket.nextText();
      const reviewPromise = fetch(
        `${origin}/api/v2/quests/${questId}/proof-submissions/${draft.data.id}/review`,
        {
          method: 'POST',
          headers: {
            cookie: hirer.cookie,
            'content-type': 'application/json',
            'idempotency-key': `proof-live-review-auto-race-review-${randomUUID()}`,
          },
          body: JSON.stringify({ decision: 'PROOF_APPROVED', reason: null }),
        }
      );
      const workerPromise = runQuestLifecycleWorker({
        clock: { now: () => workerNow },
        batchSize: 1,
      });
      const [review, workerRun] = await Promise.all([reviewPromise, workerPromise]);
      expect([200, 409]).toContain(review.status);
      const manualReviewWon = review.status === 200;
      expect(workerRun.autoApprovedProofIds.includes(draft.data.id)).toBe(!manualReviewWon);
      for (const socket of [hirerSocket, workerSocket]) {
        const proofUpdate = JSON.parse((await socket.nextText())!);
        expect(proofUpdate.questId).toBe(questId);
        expect(['PROOF_REVIEWED', 'PROOF_AUTO_APPROVED']).toContain(proofUpdate.changeType);
        expect(JSON.parse((await socket.nextText())!).changeType).toBe('QUEST_COMPLETED');
      }
      expect((await workerSocket.nextFrame())?.opcode).toBe(8);
      expect(await hirerSocket.nextText(250)).toBeUndefined();
      expect(
        (await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]
          ?.status
      ).toBe('QUEST_COMPLETED');
      expect(
        (
          await db
            .select({ status: questV2ProofSubmission.submissionStatus })
            .from(questV2ProofSubmission)
            .where(eq(questV2ProofSubmission.id, draft.data.id))
        )[0]?.status
      ).toBe('PROOF_APPROVED');
    } finally {
      workerSocket?.destroy();
      hirerSocket?.destroy();
      await server.stop();
    }
  });
  it('serializes proof-free completion against a dueAt failure with one terminal result', async () => {
    const [hirer, firstWorker, finalWorker] = sessions;
    if (!hirer || !firstWorker || !finalWorker) throw new Error('Test sessions are missing');
    const created = await createQuestV2(
      hirer.id,
      {
        ...baseInput,
        title: `Completion deadline race ${randomUUID()}`,
        participation: 'GROUP',
        headcount: 2,
        questFundingTotal: 40,
        proofRequired: false,
      },
      `proof-live-deadline-race-create-${randomUUID()}`
    );
    if (!('quest' in created)) throw new Error(`Quest creation failed: ${created.outcome}`);
    const questId = created.quest.id;
    questIds.push(questId);
    const dueAt = new Date(Date.now() + 10 * 60 * 1000);
    await db
      .update(quest)
      .set({ startTime: new Date(Date.now() - 60_000), dueAt })
      .where(eq(quest.id, questId));
    await activateQuest(questId, [firstWorker.id, finalWorker.id]);
    const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
    const port = server.server?.port;
    if (port === undefined) {
      await server.stop();
      throw new Error('Quest Proof realtime server did not start');
    }
    const sockets: QuestWebSocketClient[] = [];
    try {
      for (const member of [hirer, firstWorker, finalWorker]) {
        const socket = await QuestWebSocketClient.connect(port, questId, member.cookie);
        sockets.push(socket);
        await socket.nextText();
      }
      const origin = `http://127.0.0.1:${port}`;
      const firstConfirmation = await fetch(
        `${origin}/api/v2/quests/${questId}/completion-confirmation`,
        {
          method: 'POST',
          headers: {
            cookie: firstWorker.cookie,
            'idempotency-key': `proof-live-deadline-race-first-${randomUUID()}`,
          },
        }
      );
      expect(firstConfirmation.status).toBe(200);
      for (const socket of sockets.slice(0, 2)) {
        expect(JSON.parse((await socket.nextText())!).changeType).toBe('COMPLETION_CONFIRMED');
      }
      expect(await sockets[2]?.nextText(250)).toBeUndefined();
      expect((await sockets[1]?.nextFrame())?.opcode).toBe(8);

      const completionPromise = fetch(
        `${origin}/api/v2/quests/${questId}/completion-confirmation`,
        {
          method: 'POST',
          headers: {
            cookie: finalWorker.cookie,
            'idempotency-key': `proof-live-deadline-race-final-${randomUUID()}`,
          },
        }
      );
      const deadlinePromise = runQuestLifecycleWorker({
        clock: { now: () => new Date(dueAt.getTime() + 1) },
        batchSize: 100,
      });
      const [completion, deadlineRun] = await Promise.all([completionPromise, deadlinePromise]);
      const [storedQuest] = await db
        .select({ status: quest.questStatus })
        .from(quest)
        .where(eq(quest.id, questId));
      if (!storedQuest) throw new Error(`Quest ${questId} disappeared during the race`);
      expect(['QUEST_COMPLETED', 'QUEST_FAILED']).toContain(storedQuest.status);
      const completed = storedQuest.status === 'QUEST_COMPLETED';
      expect(completion.status === 200).toBe(completed);
      expect(deadlineRun.failedQuestIds.includes(questId)).toBe(!completed);
      for (const socket of [sockets[0]!, sockets[2]!]) {
        if (completed) {
          expect(JSON.parse((await socket.nextText())!).changeType).toBe('COMPLETION_CONFIRMED');
        }
        expect(JSON.parse((await socket.nextText())!).changeType).toBe(
          completed ? 'QUEST_COMPLETED' : 'QUEST_FAILED'
        );
      }
      expect((await sockets[2]?.nextFrame())?.opcode).toBe(8);
      expect(await sockets[0]?.nextText(250)).toBeUndefined();
      const read = await fetch(`${origin}/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      });
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).toContain(storedQuest.status);
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop();
    }
  });
});
