import { db } from '@/database/client';
import { adminAction, adminReviewItem } from '@/database/schema/admin.schema';
import { authAdmin } from '@/database/schema/auth.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { quest } from '@/database/schema/quest.schema';
import { walletWallet } from '@/database/schema/wallet.schema';
import { questStatus, questStatuses, type QuestStatus } from '@/modules/quest/quest.contract';
import type { CursorPayload } from '@/shared/cursor';

import { and, asc, count, desc, eq, gt, inArray, isNotNull, lt, or } from 'drizzle-orm';

export type AdminOverviewCounters = {
  quests: {
    total: number;
    hidden: number;
    byStatus: Record<QuestStatus, number>;
  };
  disputes: {
    total: number;
    awaitingResolution: number;
  };
  payouts: {
    pendingAdminApproval: number;
    inFlight: number;
  };
  members: {
    frozenWallets: number;
    suspendedWallets: number;
  };
};

const payoutInFlightStatuses = ['CREATING', 'PENDING', 'AWAITING_RECONCILIATION'] as const;

const emptyStatusCounts = (): Record<QuestStatus, number> =>
  Object.fromEntries(questStatuses.map((status) => [status, 0])) as Record<QuestStatus, number>;

/**
 * Counters read committed rows at one point in time. The Report queue has no
 * persistence yet, so it is absent instead of reported as zero.
 */
export const getAdminOverview = async (): Promise<AdminOverviewCounters> => {
  const [questStatusRows, hiddenQuests, disputes, payouts, wallets] = await Promise.all([
    db
      .select({ questStatus: quest.questStatus, total: count() })
      .from(quest)
      .groupBy(quest.questStatus),
    db.select({ total: count() }).from(quest).where(isNotNull(quest.hiddenAt)),
    db
      .select({ disputed: quest.questStatus, total: count() })
      .from(adminReviewItem)
      .innerJoin(quest, eq(quest.id, adminReviewItem.questId))
      .groupBy(quest.questStatus),
    db
      .select({ payoutStatus: paymentPayouts.payoutStatus, total: count() })
      .from(paymentPayouts)
      .where(inArray(paymentPayouts.payoutStatus, ['PENDING_ADMIN_APPROVAL', ...payoutInFlightStatuses]))
      .groupBy(paymentPayouts.payoutStatus),
    db
      .select({ walletStatus: walletWallet.walletStatus, total: count() })
      .from(walletWallet)
      .where(inArray(walletWallet.walletStatus, ['FROZEN', 'SUSPENDED']))
      .groupBy(walletWallet.walletStatus),
  ]);

  const byStatus = emptyStatusCounts();
  for (const row of questStatusRows) {
    byStatus[row.questStatus as QuestStatus] = row.total;
  }

  const payoutTotal = (status: string) =>
    payouts.find((row) => row.payoutStatus === status)?.total ?? 0;
  const walletTotal = (status: string) =>
    wallets.find((row) => row.walletStatus === status)?.total ?? 0;

  return {
    quests: {
      total: questStatusRows.reduce((total, row) => total + row.total, 0),
      hidden: hiddenQuests[0]?.total ?? 0,
      byStatus,
    },
    disputes: {
      total: disputes.reduce((total, row) => total + row.total, 0),
      awaitingResolution: disputes
        .filter((row) => row.disputed === questStatus.disputed)
        .reduce((total, row) => total + row.total, 0),
    },
    payouts: {
      pendingAdminApproval: payoutTotal('PENDING_ADMIN_APPROVAL'),
      inFlight: payoutInFlightStatuses.reduce((total, status) => total + payoutTotal(status), 0),
    },
    members: {
      frozenWallets: walletTotal('FROZEN'),
      suspendedWallets: walletTotal('SUSPENDED'),
    },
  };
};

export type AdminActivityEntry = {
  id: string;
  admin: { id: string; firstName: string; lastName: string };
  action: string;
  resourceType: string;
  resourceId: string;
  reasonCode: string | null;
  reasonCatalogVersion: number;
  resultVersion: number | null;
  resultTimestamp: Date | null;
  createdAt: Date;
};

export type ListAdminActivityInput = {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  adminId?: string;
  limit?: number;
  cursor?: CursorPayload;
  sort?: 'newest' | 'oldest';
};

/**
 * The Activity Log exposes the Admin Action columns that carry no evidence:
 * `metadata`, `resultData`, `requestKey`, and `requestHash` stay out of the
 * projection.
 */
export const listAdminActivity = async ({
  action,
  resourceType,
  resourceId,
  adminId,
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminActivityInput = {}) => {
  const cursorDate = cursor ? new Date(cursor.startTime) : undefined;
  const cursorCondition = cursor && cursorDate
    ? sort === 'oldest'
      ? or(
          gt(adminAction.createdAt, cursorDate),
          and(eq(adminAction.createdAt, cursorDate), gt(adminAction.id, cursor.id)),
        )
      : or(
          lt(adminAction.createdAt, cursorDate),
          and(eq(adminAction.createdAt, cursorDate), lt(adminAction.id, cursor.id)),
        )
    : undefined;

  const rows = await db
    .select({
      id: adminAction.id,
      admin: {
        id: authAdmin.id,
        firstName: authAdmin.firstName,
        lastName: authAdmin.lastName,
      },
      action: adminAction.action,
      resourceType: adminAction.resourceType,
      resourceId: adminAction.resourceId,
      reasonCode: adminAction.reasonCode,
      reasonCatalogVersion: adminAction.reasonCatalogVersion,
      resultVersion: adminAction.resultVersion,
      resultTimestamp: adminAction.resultTimestamp,
      createdAt: adminAction.createdAt,
    })
    .from(adminAction)
    .innerJoin(authAdmin, eq(authAdmin.id, adminAction.adminId))
    .where(and(
      action ? eq(adminAction.action, action) : undefined,
      resourceType ? eq(adminAction.resourceType, resourceType) : undefined,
      resourceId ? eq(adminAction.resourceId, resourceId) : undefined,
      adminId ? eq(adminAction.adminId, adminId) : undefined,
      cursorCondition,
    ))
    .orderBy(
      sort === 'oldest' ? asc(adminAction.createdAt) : desc(adminAction.createdAt),
      sort === 'oldest' ? asc(adminAction.id) : desc(adminAction.id),
    )
    .limit(limit + 1);

  const hasNext = rows.length > limit;
  const items: AdminActivityEntry[] = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasNext && last
      ? { startTime: last.createdAt.toISOString(), id: last.id }
      : null,
  };
};

export const serializeAdminActivityEntry = (entry: AdminActivityEntry) => ({
  ...entry,
  resultTimestamp: entry.resultTimestamp ? entry.resultTimestamp.toISOString() : null,
  createdAt: entry.createdAt.toISOString(),
});
