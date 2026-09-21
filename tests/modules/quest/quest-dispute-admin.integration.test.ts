import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminAction, adminDisputeCase } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment, proofSubmission } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { runQuestLifecycleWorker } from '@/modules/quest/lifecycle';
import { autoApproveDueProofs, reviewProof } from '@/modules/quest/v1/quest-proof.service';
import { createAdminDisputeCaseInTransaction } from '@/modules/quest/admin';
import {
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  releaseFundingReservation,
  reserveSpending,
} from '@/modules/wallet';
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

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, count, eq, inArray } from 'drizzle-orm';
import { Elysia } from 'elysia';

let postgresAvailable = false;
let adminCookie = '';
let memberCookie = '';
/** Fixture Quests whose seeded queue rows must leave the shared queue. */
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
  status: 'QUEST_FAILED' | 'QUEST_CANCELLED' = 'QUEST_FAILED'
) => {
  const hirerId = await createMember('Hirer');
  const workerId = await createMember('Worker');
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
  const failedAt = status === 'QUEST_FAILED' ? new Date() : null;
  const now = new Date();
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
    status === 'QUEST_FAILED'
      ? await db.transaction((transaction) =>
          createAdminDisputeCaseInTransaction(transaction, {
            questId,
            filerUserId: workerId,
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
    const member = await app.handle(
      new Request('http://localhost/api/v1/admin/disputes', {
        headers: { cookie: memberCookie },
      })
    );
    expect(anonymous.status).toBe(401);
    expect(member.status).toBe(403);
  });

  it('opens an Admin-filed Dispute Case through the production queue route', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    await db.delete(adminDisputeCase).where(eq(adminDisputeCase.id, fixture.disputeCaseId));

    const response = await adminRequest(`/api/v1/admin/disputes/open/${fixture.questId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: fixture.workerId }),
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

  it('does not let an Admin file a Worker Dispute Case for the Hirer', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    await db.delete(adminDisputeCase).where(eq(adminDisputeCase.id, fixture.disputeCaseId));

    const response = await adminRequest(`/api/v1/admin/disputes/open/${fixture.questId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: fixture.hirerId }),
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
      quest: { id: fixture.questId, questStatus: 'QUEST_FAILED' },
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

  it('dismisses a Case without money movement and replays the command', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const requestKey = `dispute-dismiss-${fixture.disputeCaseId}`;
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
          reasonCode: 'DISPUTE_POLICY_REVIEW',
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
    expect(replay.status).toBe(200);
    expect(replayBody).toEqual(firstBody);
    expect(await listTestQuestEscrowSettlements(fixture.reservationId)).toHaveLength(0);
    const escrow = await readTestQuestEscrow({
      ownerUserId: fixture.hirerId,
      questId: fixture.questId,
    });
    expect(escrow).toMatchObject({ status: 'ACTIVE', remainingSatang: 1_000 });
  });

  it('resolves a Case through Wallet with balanced postings and keeps the Quest failed', async () => {
    if (!postgresAvailable) return;
    const fixture = await createDisputeFixture();
    const response = await adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `dispute-resolve-${fixture.disputeCaseId}`,
        'if-match': '1',
      },
      body: JSON.stringify({
        outcome: 'DISPUTE_CASE_RESOLVED',
        reasonCode: 'DISPUTE_EVIDENCE_REVIEW',
        workerId: fixture.workerId,
        amountSatang: 300,
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
          reasonCode: 'DISPUTE_EVIDENCE_REVIEW',
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
        reasonCode: 'DISPUTE_POLICY_REVIEW',
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
      .set({ failedAt, updatedAt: failedAt })
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
          reasonCode: 'DISPUTE_POLICY_REVIEW',
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
          reasonCode: 'DISPUTE_POLICY_REVIEW',
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
          reasonCode: 'DISPUTE_EVIDENCE_REVIEW',
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
          reasonCode: 'DISPUTE_POLICY_REVIEW',
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
});
