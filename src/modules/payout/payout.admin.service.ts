import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentPayoutStatusHistory,
  paymentPayouts,
  type PayoutStatus,
} from '@/database/schema/payment.schema';
import {
  walletIdempotencyKey,
  walletLedgerAccount,
} from '@/database/schema/wallet.schema';
import {
  createSealedLedgerTransactionInTransaction,
  ensureWalletInTransaction,
  MoneyDomainError,
  signedSatang,
  type WalletTransaction,
} from '@/modules/wallet';
import type { CursorPayload } from '@/shared/cursor';

import { and, asc, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';

import { getPayout, type Payout } from './payout.service';

export const payoutApprovalOperationScope = 'wallet.payout.admin.approve';
export const payoutRejectionOperationScope = 'wallet.payout.admin.reject';

export type ApprovePayoutInput = {
  idempotencyKey: string;
  note?: string;
};

export type RejectPayoutInput = {
  idempotencyKey: string;
  reason: string;
};

export type AdminPayoutSort = 'newest' | 'oldest';

export type AdminPayout = {
  id: string;
  student: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  quoteId: string;
  principalSatang: number;
  receiptSatang: number;
  maximumFeeSatang: number;
  maximumTaxSatang: number;
  maximumDebitSatang: number;
  actualFeeSatang: number | null;
  actualTaxSatang: number | null;
  actualDebitSatang: number | null;
  bankCode: string;
  bankName: string;
  destinationType: string;
  maskedDestinationValue: string;
  maskedRoutingValue: string;
  providerReference: string | null;
  providerStatus: string | null;
  payoutStatus: PayoutStatus;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AdminPayoutStatusHistory = {
  id: string;
  fromStatus: PayoutStatus | null;
  toStatus: PayoutStatus;
  providerStatus: string | null;
  actorUserId: string | null;
  actorAdminId: string | null;
  source: string;
  reason: string | null;
  occurredAt: Date;
};

const bankNames: Record<string, string> = {
  BAAC: 'Bank for Agriculture and Agricultural Cooperatives',
  BAY: 'Bank of Ayudhya',
  BBL: 'Bangkok Bank',
  CIMBT: 'CIMB Thai Bank',
  EXIM: 'Export-Import Bank of Thailand',
  GHB: 'Government Housing Bank',
  GSB: 'Government Savings Bank',
  ICBC: 'Industrial and Commercial Bank of China (Thai)',
  KBANK: 'Kasikornbank',
  KKP: 'Kiatnakin Phatra Bank',
  KTB: 'Krung Thai Bank',
  LHBANK: 'Land and Houses Bank',
  PROMPTPAY: 'PromptPay',
  SCB: 'Siam Commercial Bank',
  TISCO: 'Tisco Bank',
  TTB: 'TMBThanachart Bank',
  UOBT: 'United Overseas Bank (Thai)',
};

const safePayoutColumns = {
  id: paymentPayouts.id,
  userId: paymentPayouts.userId,
  quoteId: paymentPayouts.quoteId,
  principalSatang: paymentPayouts.principalSatang,
  maximumFeeSatang: paymentPayouts.maximumFeeSatang,
  maximumTaxSatang: paymentPayouts.maximumTaxSatang,
  maximumDebitSatang: paymentPayouts.maximumDebitSatang,
  actualFeeSatang: paymentPayouts.actualFeeSatang,
  actualTaxSatang: paymentPayouts.actualTaxSatang,
  actualDebitSatang: paymentPayouts.actualDebitSatang,
  destinationBankCode: paymentPayouts.destinationBankCode,
  destinationRoutingType: paymentPayouts.destinationRoutingType,
  destinationMaskedLastFour: paymentPayouts.destinationMaskedLastFour,
  destinationMaskedRoutingValue: paymentPayouts.destinationMaskedRoutingValue,
  providerReference: paymentPayouts.providerReference,
  providerStatus: paymentPayouts.providerStatus,
  payoutStatus: paymentPayouts.payoutStatus,
  createdAt: paymentPayouts.createdAt,
  updatedAt: paymentPayouts.updatedAt,
};

type SafePayoutRecord = {
  id: string;
  userId: string;
  quoteId: string;
  principalSatang: number;
  maximumFeeSatang: number;
  maximumTaxSatang: number;
  maximumDebitSatang: number;
  actualFeeSatang: number | null;
  actualTaxSatang: number | null;
  actualDebitSatang: number | null;
  destinationBankCode: string;
  destinationRoutingType: string;
  destinationMaskedLastFour: string;
  destinationMaskedRoutingValue: string;
  providerReference: string | null;
  providerStatus: string | null;
  payoutStatus: PayoutStatus;
  createdAt: Date;
  updatedAt: Date;
};

const adminPayoutFromRecord = (
  record: SafePayoutRecord,
  student: AdminPayout['student'],
  rejectionReason: string | null,
): AdminPayout => ({
  id: record.id,
  student,
  quoteId: record.quoteId,
  principalSatang: record.principalSatang,
  receiptSatang: record.principalSatang,
  maximumFeeSatang: record.maximumFeeSatang,
  maximumTaxSatang: record.maximumTaxSatang,
  maximumDebitSatang: record.maximumDebitSatang,
  actualFeeSatang: record.actualFeeSatang,
  actualTaxSatang: record.actualTaxSatang,
  actualDebitSatang: record.actualDebitSatang,
  bankCode: record.destinationBankCode,
  bankName: bankNames[record.destinationBankCode] ?? record.destinationBankCode,
  destinationType: record.destinationRoutingType,
  maskedDestinationValue: record.destinationRoutingType === 'PROMPTPAY'
    ? record.destinationMaskedRoutingValue
    : `****${record.destinationMaskedLastFour.slice(-4)}`,
  maskedRoutingValue: record.destinationMaskedRoutingValue,
  providerReference: record.providerReference,
  providerStatus: record.providerStatus,
  payoutStatus: record.payoutStatus,
  rejectionReason,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const rejectionReasonFor = async (payoutId: string, transaction = db) => {
  const [entry] = await transaction
    .select({ reason: paymentPayoutStatusHistory.reason })
    .from(paymentPayoutStatusHistory)
    .where(and(
      eq(paymentPayoutStatusHistory.payoutId, payoutId),
      eq(paymentPayoutStatusHistory.source, 'ADMIN_REJECTION'),
    ))
    .orderBy(desc(paymentPayoutStatusHistory.occurredAt), desc(paymentPayoutStatusHistory.id))
    .limit(1);
  return entry?.reason ?? null;
};

const idempotencyExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const requestHash = async (value: object) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const approvePayout = async (
  adminId: string,
  payoutId: string,
  input: ApprovePayoutInput,
): Promise<Payout> => {
  if (!input.idempotencyKey.trim()) {
    throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key must not be empty.');
  }
  const note = input.note?.trim() || undefined;
  const hash = await requestHash({ payoutId, action: 'APPROVE', note: note ?? null });
  const result = await db.transaction(async (transaction) => {
    const [payout] = await transaction
      .select()
      .from(paymentPayouts)
      .where(eq(paymentPayouts.id, payoutId))
      .for('update');
    if (!payout) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');

    const [created] = await transaction
      .insert(walletIdempotencyKey)
      .values({
        principalUserId: payout.userId,
        operationScope: payoutApprovalOperationScope,
        key: input.idempotencyKey,
        requestHash: hash,
        expiresAt: idempotencyExpiry(),
      })
      .onConflictDoNothing()
      .returning();
    const [idempotency] = created
      ? [created]
      : await transaction
        .select()
        .from(walletIdempotencyKey)
        .where(and(
          eq(walletIdempotencyKey.principalUserId, payout.userId),
          eq(walletIdempotencyKey.operationScope, payoutApprovalOperationScope),
          eq(walletIdempotencyKey.key, input.idempotencyKey),
        ))
        .for('update');
    if (!idempotency) throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key could not be acquired.');
    if (idempotency.requestHash !== hash) {
      throw new MoneyDomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request.');
    }
    if (idempotency.resourceId) return { payoutId: idempotency.resourceId, userId: payout.userId };
    if (!created) throw new MoneyDomainError('IDEMPOTENCY_IN_PROGRESS', 'The Admin decision is still processing.');
    if (payout.payoutStatus !== 'PENDING_ADMIN_APPROVAL') {
      throw new MoneyDomainError('PAYOUT_DECISION_NOT_ALLOWED', 'The Payout no longer waits for Admin approval.');
    }

    const [updated] = await transaction
      .update(paymentPayouts)
      .set({ payoutStatus: 'CREATING', updatedAt: new Date() })
      .where(eq(paymentPayouts.id, payout.id))
      .returning({ id: paymentPayouts.id });
    if (!updated) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Payout approval could not be saved.');
    await transaction.insert(paymentPayoutStatusHistory).values({
      payoutId: payout.id,
      fromStatus: 'PENDING_ADMIN_APPROVAL',
      toStatus: 'CREATING',
      actorAdminId: adminId,
      source: 'ADMIN_APPROVAL',
      reason: note,
    });
    await transaction
      .update(walletIdempotencyKey)
      .set({
        resourceType: 'payment_payout',
        resourceId: payout.id,
        processingStatus: 'COMPLETED',
        completedAt: new Date(),
      })
      .where(eq(walletIdempotencyKey.id, idempotency.id));
    return { payoutId: payout.id, userId: payout.userId };
  });

  return getPayout(result.userId, result.payoutId);
};

const payoutAccountIds = async (transaction: WalletTransaction, userId: string, walletId: string) => {
  const accounts = await transaction
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .where(and(
      eq(walletLedgerAccount.walletId, walletId),
      inArray(walletLedgerAccount.type, ['EARNINGS', 'RESERVED_FOR_PAYOUTS']),
    ))
    .for('update');
  const earnings = accounts.find(({ type }) => type === 'EARNINGS');
  const payoutReserve = accounts.find(({ type }) => type === 'RESERVED_FOR_PAYOUTS');
  if (!earnings || !payoutReserve) {
    throw new MoneyDomainError('WALLET_ACCOUNT_NOT_FOUND', `Payout Wallet accounts for ${userId} do not exist.`);
  }
  return { earningsId: earnings.id, payoutReserveId: payoutReserve.id };
};

export const rejectPayout = async (
  adminId: string,
  payoutId: string,
  input: RejectPayoutInput,
): Promise<Payout> => {
  if (!input.idempotencyKey.trim()) {
    throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key must not be empty.');
  }
  const reason = input.reason.trim();
  if (!reason) throw new MoneyDomainError('PAYOUT_REJECTION_REASON_REQUIRED', 'Payout rejection reason is required.');
  const hash = await requestHash({ payoutId, action: 'REJECT', reason });
  const result = await db.transaction(async (transaction) => {
    const [payout] = await transaction
      .select()
      .from(paymentPayouts)
      .where(eq(paymentPayouts.id, payoutId))
      .for('update');
    if (!payout) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');

    const [created] = await transaction
      .insert(walletIdempotencyKey)
      .values({
        principalUserId: payout.userId,
        operationScope: payoutRejectionOperationScope,
        key: input.idempotencyKey,
        requestHash: hash,
        expiresAt: idempotencyExpiry(),
      })
      .onConflictDoNothing()
      .returning();
    const [idempotency] = created
      ? [created]
      : await transaction
        .select()
        .from(walletIdempotencyKey)
        .where(and(
          eq(walletIdempotencyKey.principalUserId, payout.userId),
          eq(walletIdempotencyKey.operationScope, payoutRejectionOperationScope),
          eq(walletIdempotencyKey.key, input.idempotencyKey),
        ))
        .for('update');
    if (!idempotency) throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key could not be acquired.');
    if (idempotency.requestHash !== hash) {
      throw new MoneyDomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request.');
    }
    if (idempotency.resourceId) return { payoutId: idempotency.resourceId, userId: payout.userId };
    if (!created) throw new MoneyDomainError('IDEMPOTENCY_IN_PROGRESS', 'The Admin decision is still processing.');
    if (payout.payoutStatus !== 'PENDING_ADMIN_APPROVAL') {
      throw new MoneyDomainError('PAYOUT_DECISION_NOT_ALLOWED', 'The Payout no longer waits for Admin approval.');
    }

    const wallet = await ensureWalletInTransaction(transaction, payout.userId);
    const { earningsId, payoutReserveId } = await payoutAccountIds(transaction, payout.userId, wallet.id);
    const releaseLedger = await createSealedLedgerTransactionInTransaction(transaction, {
      businessReference: `payout-admin-rejection-release:${payout.id}`,
      eventType: 'PAYOUT',
      createdByUserId: payout.userId,
      description: 'Release rejected Payout reserve',
      postings: [
        { accountId: earningsId, amountSatang: signedSatang(payout.maximumDebitSatang) },
        { accountId: payoutReserveId, amountSatang: signedSatang(-payout.maximumDebitSatang) },
      ],
    });
    const [updated] = await transaction
      .update(paymentPayouts)
      .set({
        payoutStatus: 'CANCELLED',
        finalLedgerTransactionId: releaseLedger.id,
        providerSubmissionClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(paymentPayouts.id, payout.id))
      .returning({ id: paymentPayouts.id });
    if (!updated) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Payout rejection could not be saved.');
    await transaction.insert(paymentPayoutStatusHistory).values({
      payoutId: payout.id,
      fromStatus: 'PENDING_ADMIN_APPROVAL',
      toStatus: 'CANCELLED',
      actorAdminId: adminId,
      source: 'ADMIN_REJECTION',
      reason,
    });
    await transaction
      .update(walletIdempotencyKey)
      .set({
        resourceType: 'payment_payout',
        resourceId: payout.id,
        processingStatus: 'COMPLETED',
        completedAt: new Date(),
      })
      .where(eq(walletIdempotencyKey.id, idempotency.id));
    return { payoutId: payout.id, userId: payout.userId };
  });

  return getPayout(result.userId, result.payoutId);
};

const adminPayoutRows = (executor: typeof db) => executor
  .select({
    payout: safePayoutColumns,
    student: {
      id: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
    },
  })
  .from(paymentPayouts)
  .innerJoin(authUser, eq(authUser.id, paymentPayouts.userId));

const adminPayoutHistory = async (payoutId: string): Promise<AdminPayoutStatusHistory[]> => {
  const [payout] = await db
    .select({ id: paymentPayouts.id })
    .from(paymentPayouts)
    .where(eq(paymentPayouts.id, payoutId))
    .limit(1);
  if (!payout) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');

  const rows = await db
    .select({
      id: paymentPayoutStatusHistory.id,
      fromStatus: paymentPayoutStatusHistory.fromStatus,
      toStatus: paymentPayoutStatusHistory.toStatus,
      providerStatus: paymentPayoutStatusHistory.providerStatus,
      actorUserId: paymentPayoutStatusHistory.actorUserId,
      actorAdminId: paymentPayoutStatusHistory.actorAdminId,
      source: paymentPayoutStatusHistory.source,
      reason: paymentPayoutStatusHistory.reason,
      occurredAt: paymentPayoutStatusHistory.occurredAt,
    })
    .from(paymentPayoutStatusHistory)
    .where(eq(paymentPayoutStatusHistory.payoutId, payoutId))
    .orderBy(asc(paymentPayoutStatusHistory.occurredAt), asc(paymentPayoutStatusHistory.id));
  return rows as AdminPayoutStatusHistory[];
};

export const getAdminPayout = async (payoutId: string): Promise<AdminPayout> => {
  const [row] = await adminPayoutRows(db)
    .where(eq(paymentPayouts.id, payoutId));
  if (!row) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
  return adminPayoutFromRecord(
    row.payout as SafePayoutRecord,
    row.student,
    await rejectionReasonFor(payoutId),
  );
};

export const listAdminPayoutStatusHistory = adminPayoutHistory;

export type ListAdminPayoutsInput = {
  status?: PayoutStatus;
  limit?: number;
  cursor?: CursorPayload;
  sort?: AdminPayoutSort;
};

export const listAdminPayouts = async ({
  status = 'PENDING_ADMIN_APPROVAL',
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminPayoutsInput = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Admin Payout limit must be between 1 and 50.');
  }
  const cursorDate = cursor ? new Date(cursor.startTime) : undefined;
  if (cursorDate && Number.isNaN(cursorDate.getTime())) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Admin Payout cursor is invalid.');
  }
  const cursorCondition = cursor && cursorDate
    ? sort === 'oldest'
      ? or(
        gt(paymentPayouts.createdAt, cursorDate),
        and(eq(paymentPayouts.createdAt, cursorDate), gt(paymentPayouts.id, cursor.id)),
      )
      : or(
        lt(paymentPayouts.createdAt, cursorDate),
        and(eq(paymentPayouts.createdAt, cursorDate), lt(paymentPayouts.id, cursor.id)),
      )
    : undefined;
  const rows = await adminPayoutRows(db)
    .where(and(
      eq(paymentPayouts.payoutStatus, status),
      cursorCondition,
    ))
    .orderBy(
      sort === 'oldest' ? asc(paymentPayouts.createdAt) : desc(paymentPayouts.createdAt),
      sort === 'oldest' ? asc(paymentPayouts.id) : desc(paymentPayouts.id),
    )
    .limit(limit + 1);
  const hasNext = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map(async (row) => adminPayoutFromRecord(
    row.payout as SafePayoutRecord,
    row.student,
    await rejectionReasonFor(row.payout.id),
  )));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasNext && last
      ? { startTime: last.payout.createdAt.toISOString(), id: last.payout.id }
      : null,
  };
};
