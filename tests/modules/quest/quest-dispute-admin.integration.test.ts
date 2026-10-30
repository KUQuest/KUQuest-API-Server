import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminAction, adminDisputeCase } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { quest, questAssignment, proofSubmission } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { runQuestLifecycleWorker } from '@/modules/quest/lifecycle';
import { autoApproveDueProofs, reviewProof } from '@/modules/quest/v1';
import {
  createQuestV2ProofSubmission,
  reviewQuestV2ProofSubmission,
  submitQuestV2ProofSubmission,
} from '@/modules/quest';
import { createAdminDisputeCaseInTransaction } from '@/modules/quest/admin';
import {
  readQuestDisputeSummary,
  readQuestMoneyHold,
} from '@/modules/quest/admin/quest-dispute-admin.service';
import {
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  releaseFundingReservation,
  reserveSpending,
} from '@/modules/wallet';
import { workChatMembershipWriter } from '@/modules/work-chat';
import { encodeCursor } from '@/shared/cursor';

import {
  fundTestWallet,
  listTestDisputeSettlements,
  listTestLedgerPostings,
  listTestLedgerTransactions,
  listTestQuestEscrowOperations,
  listTestQuestEscrowSettlements,
  readTestQuestEscrow,
  readTestWallet,
} from '../wallet/wallet-test-fixtures';

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { and, count, eq, inArray } from 'drizzle-orm';
import { Elysia } from 'elysia';

let postgresAvailable = false;
let adminCookie = '';
let memberCookie = '';
/** Fixture Quests whose seeded queue rows must leave the shared queue. */

import { createStagingTestAuthRoute } from '../../fixtures/seeded-test-auth';

const queueWalkQuestIds: string[] = [];
const adminEmail = `dispute-admin-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
const memberEmail = `dispute-member-${crypto.randomUUID()}@ku.th`;
const memberPassword = 'MemberPass1!';
const memberAuthApp = new Elysia({ name: 'dispute-admin-member-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: memberEmail,
    password: memberPassword,
    firstName: 'Dispute',
    lastName: 'Member',
  })
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const createMember = async (label: string) => {
  const id = crypto.randomUUID();
  await db.insert(authUser).values({
    id,
    email: `${label}-${id}@ku.th`,
    firstName: 'Dispute',
    lastName: label,
  });
  await ensureWallet(id);
  return id;
};

type DisputeFixture = {
  disputeCaseId: string;
  questId: string;
  hirerId: string;
  workerId: string;
  reservationId: string;
};

const createDisputeFixture = async (
  status: 'QUEST_FAILED' | 'QUEST_COMPLETED' | 'QUEST_CANCELLED' = 'QUEST_FAILED',
  assignedWorkerId?: string
) => {
  const hirerId = await createMember('Hirer');
  const workerId = assignedWorkerId ?? (await createMember('Worker'));
  if (assignedWorkerId) await ensureWallet(assignedWorkerId);
  await fundTestWallet(hirerId, 5_000);

  const questId = crypto.randomUUID();
  const reservation = await db.transaction((transaction) =>
    reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(1_000),
    })
  );
  const tagId = crypto.randomUUID();
  await db.insert(tag).values({ id: tagId, name: `Dispute tag ${tagId}` });
  const now = new Date();
  const failedAt = status === 'QUEST_FAILED' ? now : null;
  const moneyHoldStartedAt = status === 'QUEST_CANCELLED' ? null : now;
  await db.insert(quest).values({
    id: questId,
    hirerId,
    apiVersion: 'v1',
    title: 'Dispute Quest',
    description: 'Case-scoped test Quest',
    condition: 'Complete the test task',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: status,
    version: 1,
    rewardSatang: 1_000,
    questFundingTotalSatang: 1_000,
    fundingReservationId: reservation.id,
    policyRevisionId: reservation.policyRevisionId,
    platformFeeBps: 0,
    platformFeePerWorkerSatang: 0,
    questEscrowSatang: 1_000,
    tagId,
    headcount: 1,
    startTime: new Date(now.getTime() - 60 * 60 * 1000),
    dueAt: now,
    proofRequired: true,
    failedAt,
    moneyHoldStartedAt,
    cancelledAt: status === 'QUEST_CANCELLED' ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(questAssignment).values({
    id: crypto.randomUUID(),
    questId,
    workerId,
    assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
  });
  const createdCase =
    status !== 'QUEST_CANCELLED'
      ? await db.transaction((transaction) =>
          createAdminDisputeCaseInTransaction(transaction, {
            questId,
            filerUserId: workerId,
            category: 'PROOF_REVIEW',
            submittedDetail: 'The submitted Proof meets the Quest Condition.',
          })
        )
      : (
          await db.insert(adminDisputeCase).values({ questId, filerUserId: workerId }).returning()
        )[0];
  if (!createdCase) throw new Error('Dispute Case was not created.');
  return {
    disputeCaseId: createdCase.id,
    questId,
    hirerId,
    workerId,
    reservationId: reservation.id,
  } satisfies DisputeFixture;
};

/** Seed a queue row directly so created_at keeps its microsecond precision. */
const seedDisputeCase = async (input: {
  questId: string;
  filerUserId: string;
  createdAt: string;
}): Promise<string> => {
  const id = crypto.randomUUID();
  await sql`
    insert into admin_dispute_cases
      (id, quest_id, filer_user_id, status, version, created_at, updated_at)
    values
      (${id}, ${input.questId}, ${input.filerUserId}, 'DISPUTE_CASE_PENDING', 1,
       ${input.createdAt}::timestamptz, ${input.createdAt}::timestamptz)
  `;
  return id;
};

const adminRequest = (path: string, init: RequestInit = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        cookie: adminCookie,
        ...(init.headers ?? {}),
      },
    })
  );

const readAdminSseEvent = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 5_000
) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let next: Awaited<ReturnType<typeof reader.read>>;
  try {
    next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out waiting for an Admin SSE event.')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (next.done) throw new Error('Admin SSE stream closed before the expected event.');
  const frame = new TextDecoder().decode(next.value);
  const data = frame.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error(`Admin SSE frame did not contain event data: ${frame}`);
  return JSON.parse(data.slice('data: '.length)) as Record<string, unknown>;
};

const expectAdminSseEventMetadataOnly = (event: Record<string, unknown>) => {
  expect(Object.keys(event).sort()).toEqual(['subjectId', 'subjectType', 'type']);
};

const readAdminSseEventsForResources = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedResources: Array<{ subjectType: string; subjectId: string }>
): Promise<Record<string, unknown>[]> => {
  const expectedKeys = new Set(
    expectedResources.map(({ subjectType, subjectId }) => `${subjectType}:${subjectId}`)
  );
  const observedResources = new Set<string>();
  const events: Record<string, unknown>[] = [];
  const deadline = Date.now() + 5_000;
  while (observedResources.size < expectedKeys.size) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out waiting for all expected Admin SSE resources.');
    }
    const event = await readAdminSseEvent(reader, remainingMs);
    expectAdminSseEventMetadataOnly(event);
    const resourceKey = `${event.subjectType}:${event.subjectId}`;
    if (!expectedKeys.has(resourceKey)) continue;

    observedResources.add(resourceKey);
    events.push(event);
  }
  return events;
};

const expectNoAdminSseResources = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  forbiddenResources: Array<{ subjectType: string; subjectId: string }>
) => {
  const forbiddenKeys = new Set(
    forbiddenResources.map(({ subjectType, subjectId }) => `${subjectType}:${subjectId}`)
  );
  const quietUntil = Date.now() + 250;
  while (Date.now() < quietUntil) {
    try {
      const event = await readAdminSseEvent(reader, quietUntil - Date.now());
      expectAdminSseEventMetadataOnly(event);
      const resourceKey = `${event.subjectType}:${event.subjectId}`;
      expect(forbiddenKeys.has(resourceKey)).toBe(false);
    } catch (error) {
      if (error instanceof Error && error.message === 'Timed out waiting for an Admin SSE event.') {
        return;
      }
      throw error;
    }
  }
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }
  await ensureInitialMoneyPolicy();
  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const adminSignUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Dispute Admin',
      firstName: 'Dispute',
      lastName: 'Admin',
    },
  });
  const createdAdminId = adminSignUp.user?.id;
  if (!createdAdminId) throw new Error('Dispute Admin was not created.');
  const adminLogin = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (adminLogin.status !== 200) throw new Error('Dispute Admin session was not created.');
  adminCookie = getCookieHeader(adminLogin);

  const memberLogin = await memberAuthApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: memberPassword }),
    })
  );
  if (memberLogin.status !== 200) throw new Error('Dispute Member session was not created.');
  memberCookie = getCookieHeader(memberLogin);

  await db.select({ id: authAdmin.id }).from(authAdmin).where(eq(authAdmin.id, createdAdminId));
});
afterAll(async () => {
  if (!postgresAvailable || queueWalkQuestIds.length === 0) return;
  // Dispute Cases cascade from their Quest, so deleting the Quest clears the
  // microsecond rows this file seeded into the shared queue.
  await db.delete(quest).where(inArray(quest.id, queueWalkQuestIds));
});

describe('Admin Dispute API', () => {
  it('requires an Admin Session and rejects a Member Session', async () => {
    if (!postgresAvailable) return;
    const anonymous = await app.handle(new Request('http://localhost/api/v1/admin/disputes'));
    const anonymousDetail = await app.handle(
      new Request(`http://localhost/api/v1/admin/disputes/${crypto.randomUUID()}`)
    );
    const member = await app.handle(
      new Request('http://localhost/api/v1/admin/disputes', {
        headers: { cookie: memberCookie },
      })
    );
    const memberDetail = await app.handle(
      new Request(`http://localhost/api/v1/admin/disputes/${crypto.randomUUID()}`, {
        headers: { cookie: memberCookie },
      })
    );
    expect(anonymous.status).toBe(401);
    expect(anonymousDetail.status).toBe(401);
    expect(member.status).toBe(403);
    expect(memberDetail.status).toBe(403);
  });

  it('publishes the optional Admin decision note in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            description?: string;
            requestBody?: { content?: Record<string, { schema?: unknown }> };
            responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
          }
        >
      >;
    };
    const operation = document.paths['/api/v1/admin/disputes/{disputeCaseId}/resolve']?.post;
    const requestSchemaText = JSON.stringify(
      operation?.requestBody?.content?.['application/json']?.schema
    );

    expect(response.status).toBe(200);
    expect(operation?.description).toContain('decisionReasonText');
    expect(requestSchemaText).toContain('decisionReasonText');
    expect(requestSchemaText).toContain('"maxLength":200');
    const detailSchemaText = JSON.stringify(
      document.paths['/api/v1/admin/disputes/{disputeCaseId}']?.get?.responses?.['200']?.content?.[
        'application/json'
      ]?.schema
    );
    expect(detailSchemaText).toContain('memberStatus');
    expect(detailSchemaText).toContain('previousReportCount');
    expect(detailSchemaText).toContain('confirmedViolationCount');
    expect(detailSchemaText).toContain('previousModerationActions');
  });

  it('opens an Admin-filed Dispute Case through the production queue route', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    await db.delete(adminDisputeCase).where(eq(adminDisputeCase.id, fixture.disputeCaseId));

    const response = await adminRequest(`/api/v1/admin/disputes/open/${fixture.questId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: fixture.workerId,
        category: 'PROOF_REVIEW',
        submittedDetail: 'The Worker provided this dispute detail.',
      }),
    });
    const body = (await response.json()) as {
      data: { id: string; questId: string; filerUserId: string; openedByAdminId: string | null };
    };
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      questId: fixture.questId,
      filerUserId: fixture.workerId,
      openedByAdminId: expect.any(String),
    });
  });

  it('publishes Member and Admin Dispute Case changes through SSE, with related IDs and rollback safety', async () => {
    if (!postgresAvailable) return;
    const [authenticatedMember] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, memberEmail));
    if (!authenticatedMember) throw new Error('Dispute Member test account is missing.');

    const fixture = await createDisputeFixture('QUEST_FAILED', authenticatedMember.id);
    await db.delete(adminDisputeCase).where(eq(adminDisputeCase.id, fixture.disputeCaseId));

    const memberStreamResponse = await adminRequest('/api/v1/admin/events');
    expect(memberStreamResponse.status).toBe(200);
    expect(memberStreamResponse.headers.get('content-type')).toContain('text/event-stream');
    const memberReader = memberStreamResponse.body!.getReader();
    let filedCaseId = '';
    let rolledBackDisputeCaseId = '';
    let filingEvents: Record<string, unknown>[] = [];
    try {
      const connected = await memberReader.read();
      expect(new TextDecoder().decode(connected.value)).toContain(': connected');

      const filedResponse = await app.handle(
        new Request(`http://localhost/api/v1/quests/${fixture.questId}/disputes`, {
          method: 'POST',
          headers: { cookie: memberCookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            category: 'PROOF_REVIEW',
            submittedDetail: 'The Worker met the Quest Condition.',
            filerStatement: 'This statement is private to the Dispute Case.',
          }),
        })
      );
      const filedBody = (await filedResponse.json()) as {
        data: { id: string; status: string };
      };
      expect(filedResponse.status).toBe(200);
      expect(filedBody.data.status).toBe('DISPUTE_CASE_PENDING');
      filedCaseId = filedBody.data.id;

      const expectedFilingResources = [
        { subjectType: 'DISPUTE_CASE', subjectId: filedCaseId },
        { subjectType: 'QUEST', subjectId: fixture.questId },
      ];
      filingEvents = await readAdminSseEventsForResources(memberReader, expectedFilingResources);
      const publishedFilingResources = filingEvents
        .map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))
        .sort((left, right) =>
          `${left.subjectType}:${left.subjectId}`.localeCompare(
            `${right.subjectType}:${right.subjectId}`
          )
        );
      expect(publishedFilingResources).toEqual(
        [...expectedFilingResources].sort((left, right) =>
          `${left.subjectType}:${left.subjectId}`.localeCompare(
            `${right.subjectType}:${right.subjectId}`
          )
        )
      );

      await expect(
        db.transaction(async (transaction) => {
          const rolledBackCase = await createAdminDisputeCaseInTransaction(transaction, {
            questId: fixture.questId,
            filerUserId: fixture.hirerId,
            category: 'OTHER',
            submittedDetail: 'This Case must roll back.',
          });
          rolledBackDisputeCaseId = rolledBackCase.id;
          throw new Error('force Dispute Case transaction rollback');
        })
      ).rejects.toThrow('force Dispute Case transaction rollback');
      expect(rolledBackDisputeCaseId).not.toBe('');
      await expectNoAdminSseResources(memberReader, [
        { subjectType: 'DISPUTE_CASE', subjectId: rolledBackDisputeCaseId },
        { subjectType: 'QUEST', subjectId: fixture.questId },
      ]);
    } finally {
      await memberReader.cancel();
    }

    const decisionStreamResponse = await adminRequest('/api/v1/admin/events');
    expect(decisionStreamResponse.status).toBe(200);
    const decisionReader = decisionStreamResponse.body!.getReader();
    try {
      const connected = await decisionReader.read();
      expect(new TextDecoder().decode(connected.value)).toContain(': connected');

      const affectedWallets = await Promise.all(
        [fixture.hirerId, fixture.workerId].map((userId) => readTestWallet(userId))
      );
      const decisionResponse = await adminRequest(`/api/v1/admin/disputes/${filedCaseId}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `dispute-sse-resolve-${filedCaseId}`,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_RESOLVED',
          reasonCode: 'DISPUTE_WORKER_MET_QUEST_CONDITION',
          workerId: fixture.workerId,
          amountSatang: 300,
        }),
      });
      expect(decisionResponse.status).toBe(200);

      const expectedResources = [
        { subjectType: 'DISPUTE_CASE', subjectId: filedCaseId },
        { subjectType: 'QUEST', subjectId: fixture.questId },
        ...affectedWallets.map(({ id }) => ({ subjectType: 'WALLET', subjectId: id })),
      ];
      const decisionEvents = await readAdminSseEventsForResources(
        decisionReader,
        expectedResources
      );

      const publishedResources = decisionEvents
        .map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))
        .sort((left, right) =>
          `${left.subjectType}:${left.subjectId}`.localeCompare(
            `${right.subjectType}:${right.subjectId}`
          )
        );
      expect(publishedResources).toEqual(
        [...expectedResources].sort((left, right) =>
          `${left.subjectType}:${left.subjectId}`.localeCompare(
            `${right.subjectType}:${right.subjectId}`
          )
        )
      );
      for (const event of [...filingEvents, ...decisionEvents]) {
        expect(Object.keys(event).sort()).toEqual(['subjectId', 'subjectType', 'type']);
        expect(JSON.stringify(event)).not.toContain('The Worker met the Quest Condition.');
        expect(JSON.stringify(event)).not.toContain('This statement is private');
      }
    } finally {
      await decisionReader.cancel();
    }
  });

  it('does not let an Admin file a Worker Dispute Case for the Hirer', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    await db.delete(adminDisputeCase).where(eq(adminDisputeCase.id, fixture.disputeCaseId));

    const response = await adminRequest(`/api/v1/admin/disputes/open/${fixture.questId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: fixture.hirerId,
        category: 'PROOF_REVIEW',
        submittedDetail: 'The Worker provided this dispute detail.',
      }),
    });
    const body = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(409);
    expect(body.error.code).toBe('DISPUTE_CASE_WORKER_NOT_ASSIGNED');
  });

  it('serves bounded queue, detail, and audited case-scoped evidence', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const queue = await adminRequest('/api/v1/admin/disputes?limit=1&sort=newest');
    const queueBody = (await queue.json()) as {
      data: { items: Array<{ id: string; displayId: string }>; nextCursor: string | null };
    };
    expect(queue.status).toBe(200);
    expect(queueBody.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.disputeCaseId })])
    );
    expect(queueBody.data.items[0]?.displayId).toEqual(expect.stringMatching(/^DSP-\d{6,}$/));

    const detail = await adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}`);
    const detailBody = (await detail.json()) as { data: Record<string, unknown> };
    expect(detail.status).toBe(200);
    expect(detailBody.data).toMatchObject({
      id: fixture.disputeCaseId,
      displayId: expect.stringMatching(/^DSP-\d{6,}$/),
      questId: fixture.questId,
      status: 'DISPUTE_CASE_PENDING',
      decision: { reasonCode: null, decisionReasonText: null },
      quest: { id: fixture.questId, questStatus: 'QUEST_FAILED' },
      memberStatus: expect.any(String),
      previousReportCount: 0,
      confirmedViolationCount: 0,
      previousModerationActions: [],
      member: { status: expect.any(String) },
    });
    expect(JSON.stringify(detailBody)).not.toContain(`${fixture.hirerId}@ku.th`);

    const evidence = await adminRequest(
      `/api/v1/admin/disputes/${fixture.disputeCaseId}/evidence`,
      {
        headers: { 'idempotency-key': `dispute-evidence-${fixture.disputeCaseId}` },
      }
    );
    const evidenceBody = (await evidence.json()) as { data: Record<string, unknown> };
    expect(evidence.status).toBe(200);
    expect(evidenceBody.data).toMatchObject({
      caseId: fixture.disputeCaseId,
      questId: fixture.questId,
      truncated: false,
      assignments: [expect.objectContaining({ workerId: fixture.workerId })],
    });
    expect(evidenceBody.data).not.toHaveProperty('messages');
    const [evidenceAction] = await db
      .select({ action: adminAction.action, resourceId: adminAction.resourceId })
      .from(adminAction)
      .where(
        and(
          eq(adminAction.resourceId, fixture.disputeCaseId),
          eq(adminAction.action, 'DISPUTE_CASE_EVIDENCE_ACCESS')
        )
      );
    expect(evidenceAction).toEqual({
      action: 'DISPUTE_CASE_EVIDENCE_ACCESS',
      resourceId: fixture.disputeCaseId,
    });
  });

  it('walks every seeded queue row once per sort across a microsecond tie and rejects stale and malformed cursors', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    await db.delete(adminDisputeCase).where(eq(adminDisputeCase.id, fixture.disputeCaseId));
    queueWalkQuestIds.push(fixture.questId);
    const filerIds = await Promise.all(
      (['First', 'TieFirst', 'TieSecond', 'Last'] as const).map((label) =>
        createMember(`Queue${label}`)
      )
    );
    const first = await seedDisputeCase({
      questId: fixture.questId,
      filerUserId: filerIds[0],
      createdAt: '2030-08-05T00:00:00.090100Z',
    });
    const tieFirst = await seedDisputeCase({
      questId: fixture.questId,
      filerUserId: filerIds[1],
      createdAt: '2030-08-05T00:00:00.100200Z',
    });
    const tieSecond = await seedDisputeCase({
      questId: fixture.questId,
      filerUserId: filerIds[2],
      createdAt: '2030-08-05T00:00:00.100800Z',
    });
    const last = await seedDisputeCase({
      questId: fixture.questId,
      filerUserId: filerIds[3],
      createdAt: '2030-08-05T00:00:00.110500Z',
    });
    const seeded = [first, tieFirst, tieSecond, last];

    type QueueResponse = {
      success: boolean;
      data?: { items: Array<{ id: string }>; nextCursor: string | null };
      error?: { code: string; message: string };
    };
    // The queue is shared with the other tests in this file, so the walk
    // asserts only that the seeded rows are visited once, in order, and that
    // the walk still terminates.
    const assertSeededWalk = (visited: string[], expectedOrder: string[]) => {
      for (const id of seeded) {
        expect(visited.filter((row) => row === id)).toHaveLength(1);
      }
      expect(visited.filter((row) => seeded.includes(row))).toEqual(expectedOrder);
    };
    const readEveryPage = async (sort: 'newest' | 'oldest'): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      // The queue holds every PENDING row this file left behind, so the page
      // cap must come from the live count, not a constant.
      const [pending] = await db
        .select({ total: count() })
        .from(adminDisputeCase)
        .where(eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING'));
      const pageCap = (pending?.total ?? 0) + 10;
      for (let page = 0; page < pageCap; page += 1) {
        const params = new URLSearchParams({ sort, limit: '1' });
        if (cursor) params.set('cursor', cursor);
        // Each page cursor comes from the previous response, so these requests
        // must remain sequential.
        // eslint-disable-next-line no-await-in-loop
        const response = await adminRequest(`/api/v1/admin/disputes?${params.toString()}`);
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = (await response.json()) as QueueResponse;
        expect(body.success).toBe(true);
        ids.push(...body.data!.items.map((item) => item.id));
        cursor = body.data!.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      return ids;
    };

    assertSeededWalk(await readEveryPage('oldest'), [first, tieFirst, tieSecond, last]);
    assertSeededWalk(await readEveryPage('newest'), [last, tieSecond, tieFirst, first]);

    const goneId = await seedDisputeCase({
      questId: fixture.questId,
      filerUserId: await createMember('QueueGone'),
      createdAt: '2030-08-05T00:00:00.120600Z',
    });
    const staleCursor = encodeCursor({ id: goneId, startTime: '2030-08-05T00:00:00.120Z' });
    await db.delete(adminDisputeCase).where(eq(adminDisputeCase.id, goneId));
    const stale = await adminRequest(
      `/api/v1/admin/disputes?${new URLSearchParams({
        sort: 'newest',
        limit: '1',
        cursor: staleCursor,
      }).toString()}`
    );
    expect(stale.status).toBe(400);
    const staleBody = (await stale.json()) as QueueResponse;
    expect(staleBody.success).toBe(false);
    expect(staleBody.error?.code).toBe('INVALID_CURSOR');

    const malformed = await adminRequest(
      '/api/v1/admin/disputes?sort=newest&limit=1&cursor=not-a-cursor'
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as QueueResponse;
    expect(malformedBody.success).toBe(false);
    expect(malformedBody.error?.code).toBe('INVALID_CURSOR');
  });

  it('returns status counts across cursor pages and applies search to queue fields', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    queueWalkQuestIds.push(fixture.questId);
    const pendingFilerIds = await Promise.all([
      createMember('CountPendingFirst'),
      createMember('CountPendingSecond'),
    ]);
    await Promise.all(
      pendingFilerIds.map((filerUserId, index) =>
        seedDisputeCase({
          questId: fixture.questId,
          filerUserId,
          createdAt: `2030-08-06T00:00:00.00${index + 1}00Z`,
        })
      )
    );

    const dismissed = await adminRequest(
      `/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `dispute-count-dismiss-${fixture.disputeCaseId}`,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_DISMISSED',
          reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
        }),
      }
    );
    expect(dismissed.status).toBe(200);

    type QueueResponse = {
      success: boolean;
      data: {
        items: Array<{ id: string }>;
        nextCursor: string | null;
        totalCount: number;
        countsByStatus: Record<string, number>;
      };
    };
    const list = (cursor?: string | null, status?: string) => {
      const params = new URLSearchParams({ q: fixture.questId, limit: '1' });
      if (cursor) params.set('cursor', cursor);
      if (status) params.set('status', status);
      return adminRequest(`/api/v1/admin/disputes?${params.toString()}`);
    };

    const first = await list();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as QueueResponse;
    expect(firstBody.data).toMatchObject({
      totalCount: 2,
      countsByStatus: {
        DISPUTE_CASE_PENDING: 2,
        DISPUTE_CASE_DISMISSED: 1,
        DISPUTE_CASE_RESOLVED: 0,
      },
    });
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.nextCursor).toBeString();

    const second = await list(firstBody.data.nextCursor);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as QueueResponse;
    expect(secondBody.data).toMatchObject({
      totalCount: 2,
      countsByStatus: firstBody.data.countsByStatus,
    });
    expect(secondBody.data.items).toHaveLength(1);
    expect(secondBody.data.nextCursor).toBeNull();

    const dismissedOnly = await list(undefined, 'DISPUTE_CASE_DISMISSED');
    expect(dismissedOnly.status).toBe(200);
    expect((await dismissedOnly.json()).data).toMatchObject({
      totalCount: 1,
      countsByStatus: firstBody.data.countsByStatus,
    });
  });

  it('dismisses a Case with an Admin note and replays the command', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const requestKey = `dispute-dismiss-${fixture.disputeCaseId}`;
    const decisionReasonText = 'Evidence does not support the claim.';
    const request = () =>
      adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': requestKey,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_DISMISSED',
          reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
          decisionReasonText,
        }),
      });
    const first = await request();
    const firstBody = await first.json();
    const replay = await request();
    const replayBody = await replay.json();
    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({
      data: {
        resourceSummary: {
          id: fixture.disputeCaseId,
          status: 'DISPUTE_CASE_DISMISSED',
          version: 2,
        },
        resourceVersion: 2,
        adminActionId: expect.any(String),
      },
    });
    expect(firstBody.data.resourceSummary).not.toHaveProperty('decisionReasonText');
    expect(replay.status).toBe(200);
    expect(replayBody).toEqual(firstBody);
    const detail = await adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.decision).toEqual({
      reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
      decisionReasonText,
    });
    const activityLog = await adminRequest(
      `/api/v1/admin/activity-log?resourceType=dispute_case&resourceId=${fixture.disputeCaseId}`
    );
    expect(activityLog.status).toBe(200);
    expect((await activityLog.json()).data.items).toContainEqual(
      expect.objectContaining({
        action: 'DISPUTE_CASE_DISMISS',
        reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
        decisionReasonText,
      })
    );
    expect(await listTestQuestEscrowSettlements(fixture.reservationId)).toHaveLength(0);
    const escrow = await readTestQuestEscrow({
      ownerUserId: fixture.hirerId,
      questId: fixture.questId,
    });
    expect(escrow).toMatchObject({ status: 'ACTIVE', remainingSatang: 1_000 });
  });

  it('resolves a Case through Wallet with an Admin note and balanced postings', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const decisionReasonText = 'x'.repeat(200);
    const response = await adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `dispute-resolve-${fixture.disputeCaseId}`,
        'if-match': '1',
      },
      body: JSON.stringify({
        outcome: 'DISPUTE_CASE_RESOLVED',
        reasonCode: 'DISPUTE_WORKER_MET_QUEST_CONDITION',
        workerId: fixture.workerId,
        amountSatang: 300,
        decisionReasonText,
      }),
    });
    const body = (await response.json()) as { data: { resourceSummary: Record<string, unknown> } };
    expect(response.status).toBe(200);
    expect(body.data.resourceSummary).toMatchObject({
      id: fixture.disputeCaseId,
      status: 'DISPUTE_CASE_RESOLVED',
      version: 2,
      resolvedWorkerId: fixture.workerId,
      resolvedAmountSatang: 300,
    });
    expect(body.data.resourceSummary).not.toHaveProperty('decisionReasonText');

    const [storedQuest] = await db
      .select({ status: quest.questStatus, version: quest.version })
      .from(quest)
      .where(eq(quest.id, fixture.questId));
    expect(storedQuest).toEqual({ status: 'QUEST_FAILED', version: 1 });
    const escrow = await readTestQuestEscrow({
      ownerUserId: fixture.hirerId,
      questId: fixture.questId,
    });
    expect(escrow).toMatchObject({ status: 'ACTIVE', remainingSatang: 700 });
    if (!escrow) throw new Error('Quest Escrow was not created');
    const [settlement] = await listTestDisputeSettlements(fixture.reservationId);
    expect(
      settlement && {
        amountSatang: settlement.amountSatang,
        ledgerTransactionId: settlement.ledgerTransactionId,
      }
    ).toEqual({ amountSatang: 300, ledgerTransactionId: expect.any(String) });
    const [ledger] = await listTestLedgerTransactions([settlement!.ledgerTransactionId]);
    expect({
      eventType: ledger?.eventType,
      correctionOfTransactionId: ledger?.correctionOfTransactionId,
    }).toEqual({
      eventType: 'ADJUSTMENT',
      correctionOfTransactionId: escrow.createdLedgerTransactionId,
    });
    const postings = await listTestLedgerPostings([settlement!.ledgerTransactionId]);
    expect(postings.reduce((total, posting) => total + posting.amountSatang, 0)).toBe(0);
    const workerWallet = await readTestWallet(fixture.workerId);
    expect(workerWallet.earningsBalanceSatang).toBe(300);

    const activityLog = await adminRequest(
      `/api/v1/admin/activity-log?resourceType=dispute_case&resourceId=${fixture.disputeCaseId}`
    );
    expect(activityLog.status).toBe(200);
    expect((await activityLog.json()).data.items).toContainEqual(
      expect.objectContaining({
        action: 'DISPUTE_CASE_RESOLVE',
        reasonCode: 'DISPUTE_WORKER_MET_QUEST_CONDITION',
        decisionReasonText,
      })
    );
  });

  it('rejects blank and over-200-character Dispute decision notes', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();

    const rejectNote = async (decisionReasonText: string) => {
      const requestKey = `dispute-invalid-note-${crypto.randomUUID()}`;
      const response = await adminRequest(
        `/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': requestKey,
            'if-match': '1',
          },
          body: JSON.stringify({
            outcome: 'DISPUTE_CASE_DISMISSED',
            reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
            decisionReasonText,
          }),
        }
      );
      const body = await response.json();
      const [storedCase] = await db
        .select({ status: adminDisputeCase.status, version: adminDisputeCase.version })
        .from(adminDisputeCase)
        .where(eq(adminDisputeCase.id, fixture.disputeCaseId));
      const actions = await db
        .select({ id: adminAction.id })
        .from(adminAction)
        .where(eq(adminAction.requestKey, requestKey));

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION');
      expect(storedCase).toEqual({ status: 'DISPUTE_CASE_PENDING', version: 1 });
      expect(actions).toHaveLength(0);
    };

    await rejectNote('   ');
    await rejectNote('x'.repeat(201));
  });

  it('stores an optional Admin note on a Dispute Case decision', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const decisionReasonText = 'The Quest record confirms the Worker met the condition.';
    const requestKey = `dispute-note-${fixture.disputeCaseId}`;
    const response = await adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': requestKey,
        'if-match': '1',
      },
      body: JSON.stringify({
        outcome: 'DISPUTE_CASE_DISMISSED',
        reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
        decisionReasonText,
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.resourceSummary).not.toHaveProperty('decisionReasonText');
    expect(
      await db
        .select({ decisionReasonText: adminAction.decisionReasonText })
        .from(adminAction)
        .where(eq(adminAction.requestKey, requestKey))
    ).toEqual([{ decisionReasonText }]);
    const detail = await adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.decision).toEqual({
      reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
      decisionReasonText,
    });
  });

  it('rejects blank and over-200-character Dispute decision notes', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();

    for (const decisionReasonText of ['   ', 'x'.repeat(201)]) {
      const requestKey = `dispute-invalid-note-${crypto.randomUUID()}`;
      const response = await adminRequest(
        `/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': requestKey,
            'if-match': '1',
          },
          body: JSON.stringify({
            outcome: 'DISPUTE_CASE_DISMISSED',
            reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
            decisionReasonText,
          }),
        }
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION');
      expect(
        await db
          .select({ status: adminDisputeCase.status, version: adminDisputeCase.version })
          .from(adminDisputeCase)
          .where(eq(adminDisputeCase.id, fixture.disputeCaseId))
      ).toEqual([{ status: 'DISPUTE_CASE_PENDING', version: 1 }]);
      expect(
        await db
          .select({ id: adminAction.id })
          .from(adminAction)
          .where(eq(adminAction.requestKey, requestKey))
      ).toHaveLength(0);
    }
  });

  it('settles a pending legacy Proof approved after failure from the held Quest Escrow', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const proofId = crypto.randomUUID();
    await db.insert(proofSubmission).values({
      id: proofId,
      questId: fixture.questId,
      workerId: fixture.workerId,
      submittedByUserId: fixture.workerId,
      content: 'Completed before the Quest failed',
      submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const reviewed = await reviewProof(
      fixture.hirerId,
      fixture.questId,
      proofId,
      'PROOF_APPROVED',
      null,
      new Date()
    );
    expect(reviewed).toMatchObject({
      questStatus: 'QUEST_FAILED',
      proof: { id: proofId, submissionStatus: 'PROOF_APPROVED' },
    });
    expect(
      await db
        .select({ status: quest.questStatus })
        .from(quest)
        .where(eq(quest.id, fixture.questId))
    ).toEqual([{ status: 'QUEST_FAILED' }]);
    expect(
      await db
        .select({ status: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(eq(questAssignment.questId, fixture.questId))
    ).toEqual([{ status: 'ASSIGNMENT_COMPLETED' }]);
    expect(
      await readTestQuestEscrow({
        ownerUserId: fixture.hirerId,
        questId: fixture.questId,
      })
    ).toMatchObject({ status: 'SETTLED', remainingSatang: 0 });
    const workerWallet = await readTestWallet(fixture.workerId);
    expect(workerWallet.earningsBalanceSatang).toBe(1_000);
  });

  it('auto-approves a pending legacy Proof after failure and settles its Reward', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const proofId = crypto.randomUUID();
    await db.insert(proofSubmission).values({
      id: proofId,
      questId: fixture.questId,
      workerId: fixture.workerId,
      submittedByUserId: fixture.workerId,
      content: 'Auto-approved completed work',
      submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    expect(await autoApproveDueProofs(new Date())).toContain(proofId);
    expect(
      await db
        .select({ status: proofSubmission.submissionStatus })
        .from(proofSubmission)
        .where(eq(proofSubmission.id, proofId))
    ).toEqual([{ status: 'PROOF_APPROVED' }]);
    expect(
      await readTestQuestEscrow({
        ownerUserId: fixture.hirerId,
        questId: fixture.questId,
      })
    ).toMatchObject({ status: 'SETTLED', remainingSatang: 0 });
  });

  it('serializes concurrent resolutions so one current Case version wins', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const resolve = (requestKey: string) =>
      adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': requestKey,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_RESOLVED',
          reasonCode: 'DISPUTE_WORKER_MET_QUEST_CONDITION',
          workerId: fixture.workerId,
          amountSatang: 300,
        }),
      });
    const [first, second] = await Promise.all([
      resolve(`dispute-concurrent-a-${fixture.disputeCaseId}`),
      resolve(`dispute-concurrent-b-${fixture.disputeCaseId}`),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await listTestDisputeSettlements(fixture.reservationId)).toHaveLength(1);
    const [caseRow] = await db
      .select({ status: adminDisputeCase.status, version: adminDisputeCase.version })
      .from(adminDisputeCase)
      .where(eq(adminDisputeCase.id, fixture.disputeCaseId));
    expect(caseRow).toEqual({ status: 'DISPUTE_CASE_RESOLVED', version: 2 });
  });

  it('uses Hirer Spending Balance after the seven-day Funding hold releases', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    await db.transaction((transaction) =>
      releaseFundingReservation(transaction, {
        ownerUserId: fixture.hirerId,
        reservationId: fixture.reservationId,
        operationReference: `dispute-hold-release-${fixture.disputeCaseId}`,
      })
    );
    const releaseOperation = (await listTestQuestEscrowOperations(fixture.reservationId)).find(
      (operation) => operation.operationType === 'RELEASE'
    );
    expect(releaseOperation).toBeDefined();
    const response = await adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `dispute-post-hold-${fixture.disputeCaseId}`,
        'if-match': '1',
      },
      body: JSON.stringify({
        outcome: 'DISPUTE_CASE_RESOLVED',
        reasonCode: 'DISPUTE_VALID_PROOF_NOT_APPROVED',
        workerId: fixture.workerId,
        amountSatang: 250,
      }),
    });
    expect(response.status).toBe(200);
    expect(
      await readTestQuestEscrow({
        ownerUserId: fixture.hirerId,
        questId: fixture.questId,
      })
    ).toMatchObject({ status: 'RELEASED', remainingSatang: 0 });
    const [hirerWallet, workerWallet] = await Promise.all([
      readTestWallet(fixture.hirerId),
      readTestWallet(fixture.workerId),
    ]);
    expect(hirerWallet.spendingBalanceSatang).toBe(4_750);
    expect(hirerWallet.earningsBalanceSatang).toBe(0);
    expect(workerWallet.spendingBalanceSatang).toBe(0);
    expect(workerWallet.earningsBalanceSatang).toBe(250);
    const [settlementLedger] = await listTestLedgerTransactions(
      (await listTestDisputeSettlements(fixture.reservationId)).map(
        ({ ledgerTransactionId }) => ledgerTransactionId
      )
    );
    expect({
      eventType: settlementLedger?.eventType,
      correctionOfTransactionId: settlementLedger?.correctionOfTransactionId,
    }).toEqual({
      eventType: 'ADJUSTMENT',
      correctionOfTransactionId: releaseOperation!.ledgerTransactionId,
    });
  });

  it('releases an eligible failed Quest hold once at the seven-day boundary and only once concurrently', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const failedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db
      .update(quest)
      .set({ failedAt, moneyHoldStartedAt: failedAt, updatedAt: failedAt })
      .where(eq(quest.id, fixture.questId));
    const clock = { now: () => new Date(failedAt.getTime() + 7 * 24 * 60 * 60 * 1000) };
    const options = { clock, autoApprove: async () => [] };
    const [first, second] = await Promise.all([
      runQuestLifecycleWorker(options),
      runQuestLifecycleWorker(options),
    ]);
    expect(
      first.releasedFailedQuestIds
        .concat(second.releasedFailedQuestIds)
        .filter((id) => id === fixture.questId)
    ).toHaveLength(1);
    expect(
      await readTestQuestEscrow({
        ownerUserId: fixture.hirerId,
        questId: fixture.questId,
      })
    ).toMatchObject({ status: 'RELEASED', remainingSatang: 0 });
  });

  it('rejects stale commands, unsupported outcomes, and non-failed Quest states without side effects', async () => {
    if (!postgresAvailable) return;
    const staleFixture = await createDisputeFixture();
    const stale = await adminRequest(
      `/api/v1/admin/disputes/${staleFixture.disputeCaseId}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `dispute-stale-${staleFixture.disputeCaseId}`,
          'if-match': '2',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_DISMISSED',
          reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
        }),
      }
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('ADMIN_ACTION_CONFLICT');
    expect(
      await db
        .select()
        .from(adminAction)
        .where(eq(adminAction.requestKey, `dispute-stale-${staleFixture.disputeCaseId}`))
    ).toHaveLength(0);

    const invalid = await adminRequest(
      `/api/v1/admin/disputes/${staleFixture.disputeCaseId}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `dispute-invalid-${staleFixture.disputeCaseId}`,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_DISMISSED',
          reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
          amountSatang: 2,
        }),
      }
    );
    expect(invalid.status).toBe(400);

    const overCap = await adminRequest(
      `/api/v1/admin/disputes/${staleFixture.disputeCaseId}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `dispute-over-cap-${staleFixture.disputeCaseId}`,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_RESOLVED',
          reasonCode: 'DISPUTE_WORKER_MET_QUEST_CONDITION',
          workerId: staleFixture.workerId,
          amountSatang: 2_000,
        }),
      }
    );
    expect(overCap.status).toBe(409);
    expect(await listTestQuestEscrowSettlements(staleFixture.reservationId)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(adminAction)
        .where(eq(adminAction.requestKey, `dispute-over-cap-${staleFixture.disputeCaseId}`))
    ).toHaveLength(0);

    const cancelled = await createDisputeFixture('QUEST_CANCELLED');
    const terminal = await adminRequest(
      `/api/v1/admin/disputes/${cancelled.disputeCaseId}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `dispute-terminal-${cancelled.disputeCaseId}`,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_DISMISSED',
          reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE',
        }),
      }
    );
    expect(terminal.status).toBe(409);
    expect((await terminal.json()).error.code).toBe('DISPUTE_CASE_QUEST_NOT_FAILED');
    const [caseRow] = await db
      .select({ status: adminDisputeCase.status, version: adminDisputeCase.version })
      .from(adminDisputeCase)
      .where(eq(adminDisputeCase.id, cancelled.disputeCaseId));
    expect(caseRow).toEqual({ status: 'DISPUTE_CASE_PENDING', version: 1 });
  });

  it('allows a Member to read their own filed Dispute Case on a Quest', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();

    const [createdCase] = await db
      .insert(adminDisputeCase)
      .values({
        questId: fixture.questId,
        filerUserId: (
          await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, memberEmail))
        )[0].id,
      })
      .returning();

    // 1. Initial lookup returns the pending case for the authenticated filer
    const response = await app.handle(
      new Request(`http://localhost/api/v1/quests/${fixture.questId}/disputes/mine`, {
        headers: { cookie: memberCookie },
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { case: { id: string; questId: string; status: string } | null };
    };
    expect(body.success).toBe(true);
    expect(body.data.case).toMatchObject({
      id: createdCase.id,
      questId: fixture.questId,
      status: 'DISPUTE_CASE_PENDING',
    });

    // 2. An un-disputed quest returns null case without error
    const otherQuestId = crypto.randomUUID();
    const notFoundResponse = await app.handle(
      new Request(`http://localhost/api/v1/quests/${otherQuestId}/disputes/mine`, {
        headers: { cookie: memberCookie },
      })
    );
    expect(notFoundResponse.status).toBe(200);
    const emptyBody = (await notFoundResponse.json()) as { success: boolean; data: { case: null } };
    expect(emptyBody.data.case).toBeNull();
  });

  it('accepts a Dispute Case on a completed Quest with a money hold, as on a failed Quest', async () => {
    if (!postgresAvailable) return;
    const failed = await createDisputeFixture('QUEST_FAILED');
    const completed = await createDisputeFixture('QUEST_COMPLETED');
    const [completedQuest] = await db
      .select({ moneyHoldStartedAt: quest.moneyHoldStartedAt })
      .from(quest)
      .where(eq(quest.id, completed.questId));
    const holdStartedAt = completedQuest!.moneyHoldStartedAt!;

    for (const fixture of [failed, completed]) {
      const [created] = await db
        .select({ status: adminDisputeCase.status, filerUserId: adminDisputeCase.filerUserId })
        .from(adminDisputeCase)
        .where(eq(adminDisputeCase.id, fixture.disputeCaseId));
      expect(created).toEqual({ status: 'DISPUTE_CASE_PENDING', filerUserId: fixture.workerId });
    }
    expect(await readQuestDisputeSummary(completed.hirerId, completed.questId)).toMatchObject({
      canFile: true,
      windowEndsAt: new Date(holdStartedAt.getTime() + 24 * 60 * 60 * 1000),
    });
    expect(await readQuestMoneyHold(completed.hirerId, completed.questId)).toEqual({
      status: 'HELD',
      releasesAt: new Date(holdStartedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      heldSatang: 1_000,
    });

    await db.update(quest).set({ moneyHoldStartedAt: null }).where(eq(quest.id, completed.questId));
    await expect(
      db.transaction((transaction) =>
        createAdminDisputeCaseInTransaction(transaction, {
          questId: completed.questId,
          filerUserId: completed.hirerId,
          category: 'OTHER',
          submittedDetail: 'The Quest completed with every slot paid.',
        })
      )
    ).rejects.toMatchObject({ code: 'DISPUTE_CASE_QUEST_NOT_FAILED' });
    expect(await readQuestDisputeSummary(completed.hirerId, completed.questId)).toBeNull();
    expect(await readQuestMoneyHold(completed.hirerId, completed.questId)).toBeNull();
  });

  it('lets a not-approved GROUP + FCFS Worker file and win a Dispute Case on the completed Quest', async () => {
    if (!postgresAvailable) return;
    const writer = spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
      async () => ({ conversationId: 'dispute-group-fcfs', outcome: 'APPLIED' as const })
    );
    try {
      const hirerId = await createMember('Hirer');
      const workerA = await createMember('WorkerA');
      const workerB = await createMember('WorkerB');
      await fundTestWallet(hirerId, 5_000);
      const questId = crypto.randomUUID();
      const reservation = await db.transaction((transaction) =>
        reserveSpending(transaction, {
          ownerUserId: hirerId,
          callerScope: 'quest',
          callerReference: questId,
          amountSatang: positiveSatang(2_000),
        })
      );
      const tagId = crypto.randomUUID();
      await db.insert(tag).values({ id: tagId, name: `Dispute tag ${tagId}` });
      const now = new Date();
      await db.insert(quest).values({
        id: questId,
        hirerId,
        apiVersion: 'v2',
        title: 'GROUP FCFS Dispute Quest',
        condition: 'Complete the test task',
        mode: 'NO_CANDIDATE',
        participation: 'GROUP',
        v2Mode: 'FIRST_COME_FIRST_SERVED',
        v2Participation: 'GROUP',
        questStatus: 'QUEST_IN_PROGRESS',
        rewardSatang: 1_000,
        questFundingTotalSatang: 1_000,
        fundingReservationId: reservation.id,
        policyRevisionId: reservation.policyRevisionId,
        platformFeeBps: 0,
        platformFeePerWorkerSatang: 0,
        questEscrowSatang: 2_000,
        tagId,
        headcount: 2,
        startTime: new Date(now.getTime() - 60 * 60 * 1000),
        dueAt: new Date(now.getTime() + 60 * 60 * 1000),
        proofRequired: true,
      });
      await db.insert(questAssignment).values(
        [workerA, workerB].map((workerId, index) => ({
          questId,
          workerId,
          assignmentStatus: 'ASSIGNMENT_ACTIVE',
          createdAt: new Date(now.getTime() + index),
        }))
      );
      const proofIds = await Promise.all(
        [workerA, workerB].map(async (workerId) => {
          const [proofFile] = await db
            .insert(file)
            .values({
              bucket: 'dispute-group-fcfs-test',
              objectKey: `${crypto.randomUUID()}.pdf`,
              contentType: 'application/pdf',
              sizeBytes: 100,
              uploadedByUserId: workerId,
            })
            .returning({ id: file.id });
          const draft = await createQuestV2ProofSubmission(
            workerId,
            questId,
            { description: 'Submitted proof', fileIds: [proofFile!.id] },
            `dispute-group-fcfs-draft-${workerId}`,
            now
          );
          if ('outcome' in draft) throw new Error(`Proof Draft failed: ${draft.outcome}`);
          const sent = await submitQuestV2ProofSubmission(
            workerId,
            questId,
            draft.id,
            `dispute-group-fcfs-send-${workerId}`,
            now
          );
          if ('outcome' in sent) throw new Error(`Proof send failed: ${sent.outcome}`);
          return sent.id;
        })
      );
      const notApproved = await reviewQuestV2ProofSubmission(
        hirerId,
        questId,
        proofIds[0]!,
        'PROOF_NOT_APPROVED',
        'The submitted work is incomplete',
        `dispute-group-fcfs-a-${questId}`,
        now
      );
      expect(notApproved).toMatchObject({ questStatus: 'QUEST_IN_PROGRESS' });
      expect(await readQuestDisputeSummary(workerA, questId)).toBeNull();
      const approved = await reviewQuestV2ProofSubmission(
        hirerId,
        questId,
        proofIds[1]!,
        'PROOF_APPROVED',
        null,
        `dispute-group-fcfs-b-${questId}`,
        now
      );
      expect(approved).toMatchObject({ questStatus: 'QUEST_COMPLETED' });
      const [completed] = await db
        .select({ moneyHoldStartedAt: quest.moneyHoldStartedAt })
        .from(quest)
        .where(eq(quest.id, questId));
      expect(completed?.moneyHoldStartedAt).toEqual(now);
      expect(await readQuestDisputeSummary(workerA, questId)).toMatchObject({
        canFile: true,
        windowEndsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      });

      const disputeCase = await db.transaction((transaction) =>
        createAdminDisputeCaseInTransaction(transaction, {
          questId,
          filerUserId: workerA,
          category: 'PROOF_REVIEW',
          submittedDetail: 'The submitted Proof meets the Quest Condition.',
        })
      );
      const response = await adminRequest(`/api/v1/admin/disputes/${disputeCase.id}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `dispute-group-fcfs-resolve-${disputeCase.id}`,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'DISPUTE_CASE_RESOLVED',
          reasonCode: 'DISPUTE_VALID_PROOF_NOT_APPROVED',
          workerId: workerA,
          amountSatang: 1_000,
        }),
      });
      expect(response.status).toBe(200);
      expect((await readTestWallet(workerA)).earningsBalanceSatang).toBe(1_000);
      expect((await readTestWallet(workerB)).earningsBalanceSatang).toBe(1_000);
      expect(await readTestQuestEscrow({ ownerUserId: hirerId, questId })).toMatchObject({
        status: 'SETTLED',
        remainingSatang: 0,
      });
    } finally {
      writer.mockRestore();
    }
  });

  it('tells each viewer the self-file window and their own Case on a failed Quest', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const outsiderId = await createMember('Outsider');
    const [failed] = await db
      .select({ failedAt: quest.failedAt })
      .from(quest)
      .where(eq(quest.id, fixture.questId));
    const endsAt = new Date(failed!.failedAt!.getTime() + 24 * 60 * 60 * 1000);

    const worker = await readQuestDisputeSummary(fixture.workerId, fixture.questId);
    expect(worker).toMatchObject({
      canFile: false,
      windowEndsAt: endsAt,
      myCase: { id: fixture.disputeCaseId, status: 'DISPUTE_CASE_PENDING' },
    });
    expect(await readQuestDisputeSummary(fixture.hirerId, fixture.questId)).toMatchObject({
      canFile: true,
      windowEndsAt: endsAt,
      myCase: null,
    });
    expect(await readQuestDisputeSummary(outsiderId, fixture.questId)).toMatchObject({
      canFile: false,
      myCase: null,
    });
    expect(
      await readQuestDisputeSummary(
        fixture.hirerId,
        fixture.questId,
        new Date(endsAt.getTime() + 1)
      )
    ).toMatchObject({ canFile: false, windowEndsAt: null });

    const cancelled = await createDisputeFixture('QUEST_CANCELLED');
    expect(await readQuestDisputeSummary(cancelled.hirerId, cancelled.questId)).toBeNull();
  });

  it('shows the 7-day money hold to the Hirer and the Worker and keeps releasesAt after release', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const [failed] = await db
      .select({ failedAt: quest.failedAt })
      .from(quest)
      .where(eq(quest.id, fixture.questId));
    const releasesAt = new Date(failed!.failedAt!.getTime() + 7 * 24 * 60 * 60 * 1000);

    expect(await readQuestMoneyHold(fixture.hirerId, fixture.questId)).toEqual({
      status: 'HELD',
      releasesAt,
      heldSatang: 1_000,
    });
    expect(await readQuestMoneyHold(fixture.workerId, fixture.questId)).toEqual({
      status: 'HELD',
      releasesAt,
      heldSatang: null,
    });

    await runQuestLifecycleWorker({
      clock: { now: () => releasesAt },
      autoApprove: async () => [],
    });
    expect(await readQuestMoneyHold(fixture.hirerId, fixture.questId)).toEqual({
      status: 'RELEASED',
      releasesAt,
      heldSatang: 0,
    });

    const cancelled = await createDisputeFixture('QUEST_CANCELLED');
    expect(await readQuestMoneyHold(cancelled.hirerId, cancelled.questId)).toBeNull();
  });

  it('announces DISPUTE_CASE_UPDATED to the filer and DISPUTE_WINDOW_CLOSED once', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    await db
      .update(quest)
      .set({ apiVersion: 'v2', v2Mode: 'FIRST_COME_FIRST_SERVED', v2Participation: 'SINGLE' })
      .where(eq(quest.id, fixture.questId));
    type QuestUpdate = { questId: string; changeType: string; recipientMemberIds: string[] };
    const events: QuestUpdate[] = [];
    let wake!: () => void;
    let waiting = new Promise<void>((resolve) => (wake = resolve));
    const listener = await sql.listen('kuquest_quest_updates', (payload) => {
      const event = JSON.parse(payload) as QuestUpdate;
      if (event.questId !== fixture.questId) return;
      events.push(event);
      wake();
      waiting = new Promise<void>((resolve) => (wake = resolve));
    });
    const until = async (changeType: string) => {
      while (!events.some((event) => event.changeType === changeType)) await waiting;
    };
    try {
      await db.transaction((transaction) =>
        createAdminDisputeCaseInTransaction(transaction, {
          questId: fixture.questId,
          filerUserId: fixture.hirerId,
          category: 'OTHER',
          submittedDetail: 'The Worker did not meet the Quest Condition.',
        })
      );
      await until('DISPUTE_CASE_UPDATED');
      expect(events.find(({ changeType }) => changeType === 'DISPUTE_CASE_UPDATED')).toMatchObject({
        recipientMemberIds: [fixture.hirerId],
      });

      const [failed] = await db
        .select({ failedAt: quest.failedAt })
        .from(quest)
        .where(eq(quest.id, fixture.questId));
      const afterWindow = new Date(failed!.failedAt!.getTime() + 24 * 60 * 60 * 1000 + 1);
      const beforeWindow = new Date(afterWindow.getTime() - 2);
      const run = (now: Date) =>
        runQuestLifecycleWorker({ clock: { now: () => now }, autoApprove: async () => [] });

      expect((await run(beforeWindow)).closedDisputeWindowQuestIds).not.toContain(fixture.questId);
      expect((await run(afterWindow)).closedDisputeWindowQuestIds).toContain(fixture.questId);
      await until('DISPUTE_WINDOW_CLOSED');
      expect((await run(afterWindow)).closedDisputeWindowQuestIds).not.toContain(fixture.questId);
      const closed = events.filter(({ changeType }) => changeType === 'DISPUTE_WINDOW_CLOSED');
      expect(closed).toHaveLength(1);
      expect(closed[0]?.recipientMemberIds.sort()).toEqual(
        [fixture.hirerId, fixture.workerId].sort()
      );
    } finally {
      await listener.unlisten();
    }
  });
  const disputeDecisionReasonCodeCases = [
    { outcome: 'DISPUTE_CASE_DISMISSED', reasonCode: 'DISPUTE_INSUFFICIENT_EVIDENCE' },
    {
      outcome: 'DISPUTE_CASE_DISMISSED',
      reasonCode: 'DISPUTE_QUEST_RECORD_DOES_NOT_SUPPORT_CLAIM',
    },
    { outcome: 'DISPUTE_CASE_DISMISSED', reasonCode: 'DISPUTE_NO_UNFAIR_SETTLEMENT_FOUND' },
    { outcome: 'DISPUTE_CASE_DISMISSED', reasonCode: 'DISPUTE_WORKER_ALREADY_COMPENSATED' },
    { outcome: 'DISPUTE_CASE_RESOLVED', reasonCode: 'DISPUTE_VALID_PROOF_NOT_APPROVED' },
    { outcome: 'DISPUTE_CASE_RESOLVED', reasonCode: 'DISPUTE_WORKER_MET_QUEST_CONDITION' },
    { outcome: 'DISPUTE_CASE_RESOLVED', reasonCode: 'DISPUTE_PARTIAL_WORK_EARNED_REWARD' },
  ] as const;

  for (const { outcome, reasonCode } of disputeDecisionReasonCodeCases) {
    it(`${outcome} records ${reasonCode} with catalog version 2`, async () => {
      if (!postgresAvailable) return;
      const fixture = await createDisputeFixture();
      const requestKey = `dispute-catalog-${reasonCode}-${fixture.disputeCaseId}`;
      const action =
        outcome === 'DISPUTE_CASE_DISMISSED' ? 'DISPUTE_CASE_DISMISS' : 'DISPUTE_CASE_RESOLVE';
      const body =
        outcome === 'DISPUTE_CASE_DISMISSED'
          ? { outcome, reasonCode }
          : { outcome, reasonCode, workerId: fixture.workerId, amountSatang: 300 };
      const response = await adminRequest(
        `/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': requestKey,
            'if-match': '1',
          },
          body: JSON.stringify(body),
        }
      );
      expect(response.status).toBe(200);

      const [actionRow] = await db
        .select({
          action: adminAction.action,
          reasonCatalogVersion: adminAction.reasonCatalogVersion,
          reasonCode: adminAction.reasonCode,
        })
        .from(adminAction)
        .where(eq(adminAction.requestKey, requestKey));
      expect(actionRow).toEqual({ action, reasonCatalogVersion: 2, reasonCode });

      const activityLog = await adminRequest(
        `/api/v1/admin/activity-log?resourceType=dispute_case&resourceId=${fixture.disputeCaseId}`
      );
      expect(activityLog.status).toBe(200);
      expect((await activityLog.json()).data.items).toContainEqual(
        expect.objectContaining({ action, reasonCatalogVersion: 2, reasonCode })
      );
    });
  }

  it('rejects old and outcome-mismatched Dispute codes without writing an Admin Action', async () => {
    if (!postgresAvailable) return;
    const invalidCases = [
      { outcome: 'DISPUTE_CASE_DISMISSED', reasonCode: 'DISPUTE_POLICY_REVIEW' },
      { outcome: 'DISPUTE_CASE_DISMISSED', reasonCode: 'DISPUTE_VALID_PROOF_NOT_APPROVED' },
      { outcome: 'DISPUTE_CASE_RESOLVED', reasonCode: 'DISPUTE_EVIDENCE_REVIEW' },
      { outcome: 'DISPUTE_CASE_RESOLVED', reasonCode: 'DISPUTE_NO_UNFAIR_SETTLEMENT_FOUND' },
    ] as const;

    for (const { outcome, reasonCode } of invalidCases) {
      const fixture = await createDisputeFixture();
      const requestKey = `dispute-invalid-${reasonCode}-${fixture.disputeCaseId}`;
      const body =
        outcome === 'DISPUTE_CASE_DISMISSED'
          ? { outcome, reasonCode }
          : { outcome, reasonCode, workerId: fixture.workerId, amountSatang: 300 };
      const response = await adminRequest(
        `/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': requestKey,
            'if-match': '1',
          },
          body: JSON.stringify(body),
        }
      );
      expect(response.status).toBe(400);
      expect(
        await db
          .select({ id: adminAction.id })
          .from(adminAction)
          .where(eq(adminAction.requestKey, requestKey))
      ).toHaveLength(0);
      expect(
        await db
          .select({ status: adminDisputeCase.status, version: adminDisputeCase.version })
          .from(adminDisputeCase)
          .where(eq(adminDisputeCase.id, fixture.disputeCaseId))
      ).toEqual([{ status: 'DISPUTE_CASE_PENDING', version: 1 }]);
      expect(await listTestDisputeSettlements(fixture.reservationId)).toHaveLength(0);
    }
  });

  it('publishes the outcome-specific Dispute reason-code catalog in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            description?: string;
            requestBody?: { content?: Record<string, { schema?: unknown }> };
          }
        >
      >;
    };
    const operation = document.paths['/api/v1/admin/disputes/{disputeCaseId}/resolve']?.post;
    const schemaText = JSON.stringify(
      operation?.requestBody?.content?.['application/json']?.schema
    );

    expect(response.status).toBe(200);
    expect(schemaText).toContain('DISPUTE_INSUFFICIENT_EVIDENCE');
    expect(schemaText).toContain('DISPUTE_QUEST_RECORD_DOES_NOT_SUPPORT_CLAIM');
    expect(schemaText).toContain('DISPUTE_NO_UNFAIR_SETTLEMENT_FOUND');
    expect(schemaText).toContain('DISPUTE_WORKER_ALREADY_COMPENSATED');
    expect(schemaText).toContain('DISPUTE_VALID_PROOF_NOT_APPROVED');
    expect(schemaText).toContain('DISPUTE_WORKER_MET_QUEST_CONDITION');
    expect(schemaText).toContain('DISPUTE_PARTIAL_WORK_EARNED_REWARD');
    expect(schemaText).not.toContain('DISPUTE_POLICY_REVIEW');
    expect(schemaText).not.toContain('DISPUTE_EVIDENCE_REVIEW');
    expect(schemaText).toContain('decisionReasonText');
    expect(schemaText).toContain('maxLength');
    expect(operation?.description).toContain('DISPUTE_CASE_DISMISSED reasonCode is');
    expect(operation?.description).toContain('decisionReasonText');
  });
});
