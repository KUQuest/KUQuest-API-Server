import { app } from '@/app';
import { db, sql } from '@/database/client';
import {
  adminDisputeCase,
  adminReviewItem,
} from '@/database/schema/admin.schema';
import { authAccount, authAdmin, authSession, authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questAssignment,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import {
  paymentPayoutAccounts,
  paymentPayouts,
} from '@/database/schema/payment.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import {
  adminOverviewQuestStates,
  type AdminOverviewQuestState,
} from '@/modules/admin/admin-overview.contract';
import type { AdminOverviewData } from '@/modules/admin/admin-overview.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import {
  createPayoutDestinationEncryption,
  savePayoutDestination,
} from '@/modules/payout-destination';
import { quotePayout } from '@/modules/payout';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  signedSatang,
} from '@/modules/wallet';
import { Elysia } from 'elysia';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

const adminEmail = `admin-overview-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
const memberEmail = `admin-overview-member-${crypto.randomUUID()}@ku.th`;
const memberPassword = 'MemberPass1!';

const memberAuthApp = new Elysia({ name: 'admin-overview-member-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: memberEmail,
    password: memberPassword,
    firstName: 'Overview',
    lastName: 'Member',
  }),
);

let adminId = '';
let adminCookie = '';
let memberCookie = '';
const hirerId = crypto.randomUUID();
const tagId = crypto.randomUUID();
const questIds: string[] = [];
const payoutEncryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'o'.repeat(32) },
});

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const overviewRequest = (cookie?: string) => app.handle(new Request(
  'http://localhost/api/v1/admin/overview',
  cookie ? { headers: { cookie } } : undefined,
));

const readOverview = async (): Promise<AdminOverviewData> => {
  const response = await overviewRequest(adminCookie);
  expect(response.status).toBe(200);
  return (await response.json() as { data: AdminOverviewData }).data;
};

const waitForOverviewQueryToBlock = async (attempt = 0): Promise<void> => {
  const [activity] = await sql`
    select exists (
      select 1
      from pg_stat_activity
      where pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query ilike '%from "quest"%'
    ) as waiting
  `;
  if (activity?.waiting) return;
  if (attempt >= 200) throw new Error('Overview query did not wait for the writer lock.');
  await new Promise((resolve) => setTimeout(resolve, 5));
  return waitForOverviewQueryToBlock(attempt + 1);
};

const seedQuest = async (questStatus: AdminOverviewQuestState, hidden = false): Promise<string> => {
  const id = crypto.randomUUID();
  questIds.push(id);
  const now = new Date();
  await db.insert(quest).values({
    id,
    hirerId,
    title: `Admin Overview Quest ${id}`,
    condition: 'Complete the test work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus,
    rewardSatang: 1_000,
    tagId,
    startTime: new Date(now.getTime() - 60_000),
    dueAt: now,
    failedAt: questStatus === 'QUEST_FAILED' ? now : null,
    cancelledAt: questStatus === 'QUEST_CANCELLED' ? now : null,
    hiddenAt: hidden ? now : null,
    hiddenByAdminId: hidden ? adminId : null,
  });
  return id;
};

const creditEarnings = async (userId: string, amountSatang: number): Promise<string> => {
  const accounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, userId));
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  const earnings = accounts.find((account) => account.type === 'EARNINGS');
  if (!earnings || !suspense) throw new Error('Payout test Wallet accounts were not provisioned.');
  const ledgerTransaction = await createSealedLedgerTransaction({
    businessReference: `admin-overview-credit:${crypto.randomUUID()}`,
    eventType: 'ADJUSTMENT',
    postings: [
      { accountId: earnings.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
  return ledgerTransaction.id;
};

const seedPayout = async (
  payoutStatus: 'PENDING_ADMIN_APPROVAL' | 'SUBMITTED_TO_PROVIDER' | 'PROVIDER_PENDING' | 'SUCCEEDED',
): Promise<void> => {
  const userId = crypto.randomUUID();
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'Payout',
    lastName: 'Member',
  });
  await ensureWallet(userId);
  await savePayoutDestination({
    principalUserId: userId,
    givenName: 'Payout',
    surname: 'Member',
    relationship: 'SELF',
    bankCode: 'SCB',
    accountNumber: '1234567890',
    accountHolderName: 'Payout Member',
    routingType: 'BANK_ACCOUNT',
    routingValue: '1234567890',
  }, payoutEncryption);
  const reserveLedgerTransactionId = await creditEarnings(userId, 10_000);
  const quote = await quotePayout({
    principalUserId: userId,
    receiptSatang: positiveSatang(1_234),
  });
  const [destination] = await db
    .select()
    .from(paymentPayoutAccounts)
    .where(eq(paymentPayoutAccounts.id, quote.payoutDestinationId));
  if (!destination) throw new Error('Payout test Destination was not created.');
  const payoutId = crypto.randomUUID();
  await sql`
    insert into payment_payouts (
      id,
      internal_reference,
      user_id,
      quote_id,
      payout_account_id,
      destination_recipient_type,
      destination_given_name,
      destination_surname,
      destination_relationship,
      destination_account_country,
      destination_account_currency,
      destination_bank_code,
      destination_account_number_key_version,
      destination_account_number_nonce,
      destination_account_number_ciphertext,
      destination_account_number_auth_tag,
      destination_masked_last_four,
      destination_account_holder_name,
      destination_routing_type,
      destination_routing_value_key_version,
      destination_routing_value_nonce,
      destination_routing_value_ciphertext,
      destination_routing_value_auth_tag,
      destination_masked_routing_value,
      provider,
      principal_satang,
      maximum_fee_satang,
      maximum_tax_satang,
      maximum_debit_satang,
      payout_status,
      reserve_ledger_transaction_id
    ) values (
      ${payoutId},
      ${`payout:${payoutId}`},
      ${userId},
      ${quote.id},
      ${destination.id},
      ${destination.recipientType},
      ${destination.givenName},
      ${destination.surname},
      ${destination.relationship},
      ${destination.accountCountry},
      ${destination.accountCurrency},
      ${destination.bankCode},
      ${destination.accountNumberKeyVersion},
      ${destination.accountNumberNonce},
      ${destination.accountNumberCiphertext},
      ${destination.accountNumberAuthTag},
      ${destination.maskedLastFour},
      ${destination.accountHolderName},
      ${destination.routingType},
      ${destination.routingValueKeyVersion},
      ${destination.routingValueNonce},
      ${destination.routingValueCiphertext},
      ${destination.routingValueAuthTag},
      ${destination.maskedRoutingValue},
      'XENDIT',
      ${quote.receiptSatang},
      ${quote.maximumFeeSatang},
      ${quote.maximumTaxSatang},
      ${quote.maximumDebitSatang},
      ${payoutStatus},
      ${reserveLedgerTransactionId}
    )
  `;
  if (payoutStatus !== 'PENDING_ADMIN_APPROVAL') {
    await db
      .update(paymentPayouts)
      .set({ payoutStatus })
      .where(eq(paymentPayouts.id, payoutId));
  }
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();

  await db.insert(authUser).values({
    id: hirerId,
    email: `${hirerId}@ku.th`,
    firstName: 'Overview',
    lastName: 'Hirer',
  });
  await db.insert(tag).values({ id: tagId, name: `Admin Overview Tag ${tagId}` });

  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Overview Admin',
      firstName: 'Overview',
      lastName: 'Admin',
    },
  });
  adminId = signUp.user.id;

  const adminLogin = await app.handle(new Request('http://localhost/api/admin/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  }));
  if (adminLogin.status !== 200) throw new Error('Overview Admin session was not created.');
  adminCookie = getCookieHeader(adminLogin);

  const memberLogin = await memberAuthApp.handle(new Request(
    'http://localhost/api/staging/test-auth/sign-in/email',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: memberPassword }),
    },
  ));
  if (memberLogin.status !== 200) throw new Error('Overview Member session was not created.');
  memberCookie = getCookieHeader(memberLogin);

});

afterAll(async () => {
  if (questIds.length > 0) {
    await db.delete(adminDisputeCase).where(inArray(adminDisputeCase.questId, questIds));
    await db.delete(quest).where(inArray(quest.id, questIds));
  }
  await db.delete(authUser).where(eq(authUser.id, hirerId));
  if (adminId) {
    await db.delete(authSession).where(eq(authSession.adminId, adminId));
    await db.delete(authAccount).where(eq(authAccount.adminId, adminId));
    await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  }
});

describe('Admin Overview API', () => {
  it('distinguishes anonymous, Member, enabled Admin, and disabled Admin Sessions', async () => {
    const anonymous = await overviewRequest();
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });

    const member = await overviewRequest(memberCookie);
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden' },
    });

    const admin = await overviewRequest(adminCookie);
    expect(admin.status).toBe(200);
    expect((await admin.json()).success).toBe(true);

    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, adminId));
    const disabled = await overviewRequest(adminCookie);
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toEqual({
      success: false,
      error: { code: 'ADMIN_DISABLED', message: 'Admin account is disabled' },
    });
    await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, adminId));
  });

  it('publishes the Overview path under the versioned Admin boundary', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }> >;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/admin/overview']?.get).toMatchObject({
      operationId: 'getAdminOverview',
      responses: expect.objectContaining({ '200': expect.anything(), '401': expect.anything(), '403': expect.anything() }),
    });
  });

  it('counts canonical Quest States, the Hidden overlay, Dispute Cases, and Wallet holds', async () => {
    const before = await readOverview();

    await Promise.all(adminOverviewQuestStates.map((status) => seedQuest(status)));
    await seedQuest('QUEST_OPEN', true);

    const pendingQuestId = await seedQuest('QUEST_FAILED');
    const dismissedQuestId = await seedQuest('QUEST_FAILED');
    const resolvedQuestId = await seedQuest('QUEST_FAILED');
    await db.insert(adminDisputeCase).values([
      { questId: pendingQuestId, filerUserId: hirerId },
      {
        questId: dismissedQuestId,
        filerUserId: hirerId,
        status: 'DISPUTE_CASE_DISMISSED',
        resolvedByAdminId: adminId,
        resolvedAt: new Date(),
      },
      {
        questId: resolvedQuestId,
        filerUserId: hirerId,
        status: 'DISPUTE_CASE_RESOLVED',
        resolvedWorkerId: hirerId,
        resolvedAmountSatang: 100,
        resolvedByAdminId: adminId,
        resolvedAt: new Date(),
      },
    ]);

    const reviewQuestId = await seedQuest('QUEST_FAILED');
    const assignmentId = crypto.randomUUID();
    const proofSubmissionId = crypto.randomUUID();
    await db.insert(questAssignment).values({
      id: assignmentId,
      questId: reviewQuestId,
      workerId: hirerId,
      assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
    });
    await db.insert(questV2ProofSubmission).values({
      id: proofSubmissionId,
      questId: reviewQuestId,
      workerId: hirerId,
      submittedByUserId: hirerId,
      description: 'Review evidence',
      submissionStatus: 'PROOF_NOT_APPROVED',
      sentAt: new Date(),
    });
    await db.insert(adminReviewItem).values({
      questId: reviewQuestId,
      assignmentId,
      proofSubmissionId,
      hirerId,
      workerId: hirerId,
      reason: 'Proof was not approved',
      evidenceReferences: ['proof-submission'],
    });

    const frozenUserId = crypto.randomUUID();
    const suspendedUserId = crypto.randomUUID();
    await db.insert(authUser).values([
      {
        id: frozenUserId,
        email: `${frozenUserId}@ku.th`,
        firstName: 'Frozen',
        lastName: 'Member',
      },
      {
        id: suspendedUserId,
        email: `${suspendedUserId}@ku.th`,
        firstName: 'Suspended',
        lastName: 'Member',
      },
    ]);
    await db.insert(walletWallet).values([
      { userId: frozenUserId, walletStatus: 'FROZEN' },
      { userId: suspendedUserId, walletStatus: 'SUSPENDED' },
    ]);

    const after = await readOverview();
    expect(after.quests.total - before.quests.total).toBe(adminOverviewQuestStates.length + 5);
    expect(after.quests.hidden - before.quests.hidden).toBe(1);
    for (const status of adminOverviewQuestStates) {
      const expectedDelta = status === 'QUEST_OPEN' ? 2 : status === 'QUEST_FAILED' ? 5 : 1;
      expect(after.quests.byState[status]! - before.quests.byState[status]!).toBe(expectedDelta);
    }
    expect(after.disputes.total - before.disputes.total).toBe(3);
    expect(after.disputes.awaitingResolution - before.disputes.awaitingResolution).toBe(1);
    expect(after.members.frozenWallets - before.members.frozenWallets).toBe(1);
    expect(after.members.suspendedWallets - before.members.suspendedWallets).toBe(1);
    expect(after).not.toHaveProperty('reports');
  });

  it('does not use Legacy Quest State or Admin Review Items for Dispute counters', async () => {
    const before = await readOverview();
    const legacyQuestId = await seedQuest('QUEST_OPEN');
    await sql`
      update quest
      set quest_status = 'QUEST_DISPUTED',
          updated_at = now()
      where id = ${legacyQuestId}
    `;

    const after = await readOverview();
    expect(after.disputes.total).toBe(before.disputes.total);
    expect(after.disputes.awaitingResolution).toBe(before.disputes.awaitingResolution);
    expect(after.quests.total).toBe(before.quests.total);
    expect(after.quests.byState.QUEST_OPEN).toBe(before.quests.byState.QUEST_OPEN);
    expect(after.quests.byState).not.toHaveProperty('QUEST_DISPUTED');
  });

  it('counts only the accepted Payout approval and Provider in-flight statuses', async () => {
    const before = await readOverview();
    await seedPayout('PENDING_ADMIN_APPROVAL');
    await seedPayout('SUBMITTED_TO_PROVIDER');
    await seedPayout('PROVIDER_PENDING');
    await seedPayout('SUCCEEDED');

    const after = await readOverview();
    expect(after.payouts.pendingAdminApproval - before.payouts.pendingAdminApproval).toBe(1);
    expect(after.payouts.inFlight - before.payouts.inFlight).toBe(2);
  });

  it('reads all counters from one database snapshot', async () => {
    const snapshotQuestId = await seedQuest('QUEST_OPEN');
    const snapshotWalletUserId = crypto.randomUUID();
    await db.insert(authUser).values({
      id: snapshotWalletUserId,
      email: `${snapshotWalletUserId}@ku.th`,
      firstName: 'Snapshot',
      lastName: 'Member',
    });
    await db.insert(walletWallet).values({
      userId: snapshotWalletUserId,
      walletStatus: 'FROZEN',
    });

    const before = await readOverview();
    let writerReady!: () => void;
    const writerStarted = new Promise<void>((resolve) => {
      writerReady = resolve;
    });
    let releaseWriter!: () => void;
    const writerReleased = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = sql.begin(async (transaction) => {
      await transaction`lock table quest in access exclusive mode`;
      await transaction`
        update quest
        set quest_status = 'QUEST_CANCELLED',
            cancelled_at = now(),
            updated_at = now()
        where id = ${snapshotQuestId}
      `;
      await transaction`
        update wallet_wallets
        set wallet_status = 'SUSPENDED',
            updated_at = now()
        where user_id = ${snapshotWalletUserId}
      `;
      writerReady();
      await writerReleased;
    });
    await writerStarted;

    const duringCommit = overviewRequest(adminCookie);
    try {
      await waitForOverviewQueryToBlock();
    } finally {
      releaseWriter();
    }
    const duringCommitResponse = await duringCommit;
    expect(duringCommitResponse.status).toBe(200);
    const duringCommitData = await duringCommitResponse.json() as { data: AdminOverviewData };
    await writer;

    expect(duringCommitData.data.quests.byState.QUEST_OPEN).toBe(before.quests.byState.QUEST_OPEN);
    expect(duringCommitData.data.quests.byState.QUEST_CANCELLED).toBe(before.quests.byState.QUEST_CANCELLED);
    expect(duringCommitData.data.members.frozenWallets).toBe(before.members.frozenWallets);
    expect(duringCommitData.data.members.suspendedWallets).toBe(before.members.suspendedWallets);

    const after = await readOverview();
    expect(after.quests.byState.QUEST_OPEN).toBe(before.quests.byState.QUEST_OPEN - 1);
    expect(after.quests.byState.QUEST_CANCELLED).toBe(before.quests.byState.QUEST_CANCELLED + 1);
    expect(after.members.frozenWallets).toBe(before.members.frozenWallets - 1);
    expect(after.members.suspendedWallets).toBe(before.members.suspendedWallets + 1);
  });
});
