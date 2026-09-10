import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminAction, adminDisputeCase } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment, proofSubmission } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  walletFundingReservation,
  walletFundingReservationOperation,
  walletFundingReservationSettlement,
  walletDisputeSettlement,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { runQuestLifecycleWorker } from '@/modules/quest/quest-lifecycle.worker';
import { autoApproveDueProofs, reviewProof } from '@/modules/quest/quest-proof.service';
import { createAdminDisputeCaseInTransaction } from '@/modules/quest/quest-dispute-admin.service';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  releaseFundingReservation,
  reserveSpending,
  signedSatang,
} from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { Elysia } from 'elysia';

let postgresAvailable = false;
let adminCookie = '';
let memberCookie = '';
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

const creditSpending = async (userId: string, amountSatang: number) => {
  const [wallet] = await db
    .select({ id: walletWallet.id })
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));
  const accounts = wallet
    ? await db
        .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
        .from(walletLedgerAccount)
        .where(eq(walletLedgerAccount.walletId, wallet.id))
    : [];
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  const spending = accounts.find((account) => account.type === 'SPENDING');
  if (!spending || !suspense) throw new Error('Wallet accounts were not provisioned.');
  await createSealedLedgerTransaction({
    businessReference: `test-dispute-credit:${crypto.randomUUID()}`,
    eventType: 'ADJUSTMENT',
    postings: [
      { accountId: spending.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
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
  await creditSpending(hirerId, 5_000);

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
      data: { items: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(queue.status).toBe(200);
    expect(queueBody.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.disputeCaseId })])
    );

    const detail = await adminRequest(`/api/v1/admin/disputes/${fixture.disputeCaseId}`);
    const detailBody = (await detail.json()) as { data: Record<string, unknown> };
    expect(detail.status).toBe(200);
    expect(detailBody.data).toMatchObject({
      id: fixture.disputeCaseId,
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
    expect(
      await db
        .select()
        .from(walletFundingReservationSettlement)
        .where(eq(walletFundingReservationSettlement.reservationId, fixture.reservationId))
    ).toHaveLength(0);
    const [reservation] = await db
      .select({
        status: walletFundingReservation.status,
        remainingSatang: walletFundingReservation.remainingSatang,
      })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.id, fixture.reservationId));
    expect(reservation).toEqual({ status: 'ACTIVE', remainingSatang: 1_000 });
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
    const [reservation] = await db
      .select({
        status: walletFundingReservation.status,
        remainingSatang: walletFundingReservation.remainingSatang,
      })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.id, fixture.reservationId));
    expect(reservation).toEqual({ status: 'ACTIVE', remainingSatang: 700 });
    const [settlement] = await db
      .select({
        ledgerTransactionId: walletDisputeSettlement.ledgerTransactionId,
        amountSatang: walletDisputeSettlement.amountSatang,
      })
      .from(walletDisputeSettlement)
      .where(eq(walletDisputeSettlement.reservationId, fixture.reservationId));
    expect(settlement).toEqual({ amountSatang: 300, ledgerTransactionId: expect.any(String) });
    const [reservationLedger] = await db
      .select({ createdLedgerTransactionId: walletFundingReservation.createdLedgerTransactionId })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.id, fixture.reservationId));
    const [ledger] = await db
      .select({
        eventType: walletLedgerTransaction.eventType,
        correctionOfTransactionId: walletLedgerTransaction.correctionOfTransactionId,
      })
      .from(walletLedgerTransaction)
      .where(eq(walletLedgerTransaction.id, settlement!.ledgerTransactionId));
    expect(ledger).toEqual({
      eventType: 'ADJUSTMENT',
      correctionOfTransactionId: reservationLedger?.createdLedgerTransactionId,
    });
    const postings = await db
      .select({ amountSatang: walletLedgerPosting.amountSatang })
      .from(walletLedgerPosting)
      .where(eq(walletLedgerPosting.transactionId, settlement!.ledgerTransactionId));
    expect(postings.reduce((total, posting) => total + posting.amountSatang, 0)).toBe(0);
    const [workerWallet] = await db
      .select({ earningsBalanceSatang: walletWallet.earningsBalanceSatang })
      .from(walletWallet)
      .where(eq(walletWallet.userId, fixture.workerId));
    expect(workerWallet?.earningsBalanceSatang).toBe(300);
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
      await db
        .select({
          status: walletFundingReservation.status,
          remainingSatang: walletFundingReservation.remainingSatang,
        })
        .from(walletFundingReservation)
        .where(eq(walletFundingReservation.id, fixture.reservationId))
    ).toEqual([{ status: 'SETTLED', remainingSatang: 0 }]);
    const [workerWallet] = await db
      .select({ earningsBalanceSatang: walletWallet.earningsBalanceSatang })
      .from(walletWallet)
      .where(eq(walletWallet.userId, fixture.workerId));
    expect(workerWallet?.earningsBalanceSatang).toBe(1_000);
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
      await db
        .select({
          status: walletFundingReservation.status,
          remainingSatang: walletFundingReservation.remainingSatang,
        })
        .from(walletFundingReservation)
        .where(eq(walletFundingReservation.id, fixture.reservationId))
    ).toEqual([{ status: 'SETTLED', remainingSatang: 0 }]);
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
    expect(
      await db
        .select()
        .from(walletDisputeSettlement)
        .where(eq(walletDisputeSettlement.reservationId, fixture.reservationId))
    ).toHaveLength(1);
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
    const [releaseOperation] = await db
      .select({ ledgerTransactionId: walletFundingReservationOperation.ledgerTransactionId })
      .from(walletFundingReservationOperation)
      .where(
        and(
          eq(walletFundingReservationOperation.reservationId, fixture.reservationId),
          eq(walletFundingReservationOperation.operationType, 'RELEASE')
        )
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
    const [reservation] = await db
      .select({
        status: walletFundingReservation.status,
        remainingSatang: walletFundingReservation.remainingSatang,
      })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.id, fixture.reservationId));
    expect(reservation).toEqual({ status: 'RELEASED', remainingSatang: 0 });
    const wallets = await db
      .select({
        userId: walletWallet.userId,
        spending: walletWallet.spendingBalanceSatang,
        earnings: walletWallet.earningsBalanceSatang,
      })
      .from(walletWallet)
      .where(inArray(walletWallet.userId, [fixture.hirerId, fixture.workerId]));
    expect(wallets).toEqual(
      expect.arrayContaining([
        { userId: fixture.hirerId, spending: 4_750, earnings: 0 },
        { userId: fixture.workerId, spending: 0, earnings: 250 },
      ])
    );
    const [ledger] = await db
      .select({
        eventType: walletLedgerTransaction.eventType,
        correctionOfTransactionId: walletLedgerTransaction.correctionOfTransactionId,
      })
      .from(walletLedgerTransaction)
      .innerJoin(
        walletDisputeSettlement,
        eq(walletDisputeSettlement.ledgerTransactionId, walletLedgerTransaction.id)
      )
      .where(eq(walletDisputeSettlement.reservationId, fixture.reservationId));
    expect(ledger).toEqual({
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
    const [reservation] = await db
      .select({
        status: walletFundingReservation.status,
        remainingSatang: walletFundingReservation.remainingSatang,
      })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.id, fixture.reservationId));
    expect(reservation).toEqual({ status: 'RELEASED', remainingSatang: 0 });
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
    expect(
      await db
        .select()
        .from(walletFundingReservationSettlement)
        .where(eq(walletFundingReservationSettlement.reservationId, staleFixture.reservationId))
    ).toHaveLength(0);
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
