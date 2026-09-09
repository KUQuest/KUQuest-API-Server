import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentPayoutStatusHistory,
  paymentPayoutQuotes,
  paymentPayouts,
  type PayoutStatus,
} from '@/database/schema/payment.schema';
import {
  createAdminActionService,
  type AdminActionReasonCatalog,
  type AdminActionResult,
  type AdminActionTransaction,
} from '@/modules/admin';
import { MoneyDomainError } from '@/modules/wallet';
import type { CursorPayload } from '@/shared/cursor';

import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';

import {
  approvePayoutInTransaction,
  cancelPayoutInTransaction,
} from './payout.service';

export const payoutAdminReasonCodes = [
  'PAYOUT_POLICY_REVIEW',
  'PAYOUT_RISK_REVIEW',
  'PAYOUT_INVALID_DESTINATION',
] as const;

const payoutApprovalReasonCodes = [
  'PAYOUT_POLICY_REVIEW',
  'PAYOUT_RISK_REVIEW',
] as const;

const payoutCancellationReasonCodes = payoutAdminReasonCodes;
const payoutAdminReasonCodeSet = new Set<string>(payoutAdminReasonCodes);

const safePayoutReasonCode = (reason: string | null) => (
  reason && payoutAdminReasonCodeSet.has(reason) ? reason : null
);

export const payoutAdminActionCatalog: AdminActionReasonCatalog = {
  version: 1,
  actions: {
    PAYOUT_APPROVE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: payoutApprovalReasonCodes,
    },
    PAYOUT_CANCEL: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: payoutCancellationReasonCodes,
    },
  },
};

const adminActionService = createAdminActionService(payoutAdminActionCatalog);

export type AdminPayoutDecisionInput = {
  adminId: string;
  payoutId: string;
  idempotencyKey: string;
  expectedVersion: number;
  reasonCode: string;
};

export type AdminPayoutCommandResult = AdminActionResult<AdminPayoutCommandSummary>;

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
  cancellationReasonCode: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AdminPayoutCommandSummary = Omit<AdminPayout, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
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
  receiptSatang: paymentPayoutQuotes.receiptSatang,
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
  version: paymentPayouts.version,
  createdAt: paymentPayouts.createdAt,
  updatedAt: paymentPayouts.updatedAt,
};

type SafePayoutRecord = {
  id: string;
  userId: string;
  quoteId: string;
  receiptSatang: number;
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
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

const adminPayoutFromRecord = (
  record: SafePayoutRecord,
  student: AdminPayout['student'],
  cancellationReasonCode: string | null,
): AdminPayout => ({
  id: record.id,
  student,
  quoteId: record.quoteId,
  principalSatang: record.principalSatang,
  receiptSatang: record.receiptSatang,
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
  cancellationReasonCode,
  version: record.version,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const cancellationReasonCodeFor = async (
  payoutId: string,
  transaction: typeof db | AdminActionTransaction = db,
) => {
  const [entry] = await transaction
    .select({ reason: paymentPayoutStatusHistory.reason })
    .from(paymentPayoutStatusHistory)
    .where(and(
      eq(paymentPayoutStatusHistory.payoutId, payoutId),
      eq(paymentPayoutStatusHistory.source, 'ADMIN_CANCELLATION'),
    ))
    .orderBy(desc(paymentPayoutStatusHistory.occurredAt), desc(paymentPayoutStatusHistory.id))
    .limit(1);
  return safePayoutReasonCode(entry?.reason ?? null);
};

const adminPayoutRows = (executor: typeof db | AdminActionTransaction) => executor
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
  .innerJoin(authUser, eq(authUser.id, paymentPayouts.userId))
  .innerJoin(paymentPayoutQuotes, eq(paymentPayoutQuotes.id, paymentPayouts.quoteId));

const getAdminPayoutInTransaction = async (
  transaction: typeof db | AdminActionTransaction,
  payoutId: string,
): Promise<AdminPayout> => {
  const [row] = await adminPayoutRows(transaction)
    .where(eq(paymentPayouts.id, payoutId));
  if (!row) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
  return adminPayoutFromRecord(
    row.payout as SafePayoutRecord,
    row.student,
    await cancellationReasonCodeFor(payoutId, transaction),
  );
};

const adminPayoutCommandSummary = (payout: AdminPayout): AdminPayoutCommandSummary => ({
  ...payout,
  createdAt: payout.createdAt.toISOString(),
  updatedAt: payout.updatedAt.toISOString(),
});

const executePayoutAdminCommand = async (
  action: 'PAYOUT_APPROVE' | 'PAYOUT_CANCEL',
  input: AdminPayoutDecisionInput,
): Promise<AdminPayoutCommandResult> => adminActionService.executeCommand({
  adminId: input.adminId,
  action,
  resourceType: 'payout',
  resourceId: input.payoutId,
  requestKey: input.idempotencyKey,
  reasonCode: input.reasonCode,
  request: {},
  metadata: {},
  expectedVersion: input.expectedVersion,
  prepare: async (transaction, _context) => {
    const decision = {
      payoutId: input.payoutId,
      adminId: input.adminId,
      reasonCode: input.reasonCode,
    };
    const [current] = await transaction
      .select({ version: paymentPayouts.version })
      .from(paymentPayouts)
      .where(eq(paymentPayouts.id, input.payoutId))
      .for('update');
    if (!current) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');

    return {
      currentVersion: current.version,
      apply: async () => {
        if (action === 'PAYOUT_APPROVE') {
          await approvePayoutInTransaction(transaction, decision);
        } else {
          await cancelPayoutInTransaction(transaction, decision);
        }
        const payout = await getAdminPayoutInTransaction(transaction, input.payoutId);
        return {
          resourceSummary: adminPayoutCommandSummary(payout),
          resourceVersion: payout.version,
          resourceTimestamp: null,
        };
      },
    };
  },
});

export const approvePayout = (input: AdminPayoutDecisionInput) =>
  executePayoutAdminCommand('PAYOUT_APPROVE', input);

export const cancelPayout = (input: AdminPayoutDecisionInput) =>
  executePayoutAdminCommand('PAYOUT_CANCEL', input);

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
  return rows.map((row) => {
    if (row.source !== 'ADMIN_CANCELLATION') return row;
    return { ...row, reason: safePayoutReasonCode(row.reason) };
  }) as AdminPayoutStatusHistory[];
};

export const getAdminPayout = async (payoutId: string): Promise<AdminPayout> => {
  const [row] = await adminPayoutRows(db)
    .where(eq(paymentPayouts.id, payoutId));
  if (!row) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
  return adminPayoutFromRecord(
    row.payout as SafePayoutRecord,
    row.student,
    await cancellationReasonCodeFor(payoutId),
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
  const items = await Promise.all(page.map(async (row: {
    payout: SafePayoutRecord;
    student: AdminPayout['student'];
  }) => adminPayoutFromRecord(
    row.payout as SafePayoutRecord,
    row.student,
    await cancellationReasonCodeFor(row.payout.id),
  )));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasNext && last
      ? { startTime: last.payout.createdAt.toISOString(), id: last.payout.id }
      : null,
  };
};
