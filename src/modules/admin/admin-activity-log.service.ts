import { db } from '@/database/client';
import {
  adminAction,
  adminConductReport,
  adminDisputeCase,
  adminReportCase,
} from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { paymentPayouts, paymentTopUp } from '@/database/schema/payment.schema';
import { quest } from '@/database/schema/quest.schema';
import { walletWallet } from '@/database/schema/wallet.schema';
import { CursorInputError } from '@/shared/cursor';
import type { CursorPayload } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, eq, sql } from 'drizzle-orm';

import { formatActivityDisplayId, formatDisplayIdSql } from './admin-display-id';

export type AdminActivityEntry = {
  id: string;
  activityDisplayId: string;
  admin: { id: string; firstName: string; lastName: string };
  action: string;
  resourceType: string;
  resourceId: string;
  resourceDisplayId: string | null;
  beforeState: string | null;
  afterState: string | null;
  reasonCode: string | null;
  decisionReasonText: string | null;
  reasonCatalogVersion: number;
  resultVersion: number | null;
  resultTimestamp: Date | null;
  createdAt: Date;
};

const resourceDisplayId = sql<string | null>`CASE
  WHEN lower(${adminAction.resourceType}) = 'quest' THEN (
    SELECT ${formatDisplayIdSql('quest', quest.publicSequence)}
    FROM ${quest}
    WHERE cast(${quest.id} AS text) = ${adminAction.resourceId}
    LIMIT 1
  )
  WHEN lower(${adminAction.resourceType}) = 'dispute_case' THEN (
    SELECT ${formatDisplayIdSql('dispute', adminDisputeCase.publicSequence)}
    FROM ${adminDisputeCase}
    WHERE cast(${adminDisputeCase.id} AS text) = ${adminAction.resourceId}
    LIMIT 1
  )
  WHEN lower(${adminAction.resourceType}) = 'report_case' THEN (
    SELECT ${formatDisplayIdSql('reportCase', adminReportCase.publicSequence)}
    FROM ${adminReportCase}
    WHERE cast(${adminReportCase.id} AS text) = ${adminAction.resourceId}
    LIMIT 1
  )
  WHEN lower(${adminAction.resourceType}) = 'conduct_report' THEN (
    SELECT ${formatDisplayIdSql('conductReport', adminConductReport.publicSequence)}
    FROM ${adminConductReport}
    WHERE cast(${adminConductReport.id} AS text) = ${adminAction.resourceId}
    LIMIT 1
  )
  WHEN lower(${adminAction.resourceType}) = 'payout' THEN (
    SELECT ${formatDisplayIdSql('payout', paymentPayouts.publicSequence)}
    FROM ${paymentPayouts}
    WHERE cast(${paymentPayouts.id} AS text) = ${adminAction.resourceId}
    LIMIT 1
  )
  WHEN lower(${adminAction.resourceType}) = 'top_up' THEN (
    SELECT ${formatDisplayIdSql('topUp', paymentTopUp.publicSequence)}
    FROM ${paymentTopUp}
    WHERE cast(${paymentTopUp.id} AS text) = ${adminAction.resourceId}
    LIMIT 1
  )
  WHEN lower(${adminAction.resourceType}) = 'wallet' THEN (
    SELECT ${formatDisplayIdSql('wallet', walletWallet.publicSequence)}
    FROM ${walletWallet}
    WHERE cast(${walletWallet.id} AS text) = ${adminAction.resourceId}
    LIMIT 1
  )
  WHEN lower(${adminAction.resourceType}) = 'member' THEN (
    SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
    FROM ${authUser}
    WHERE cast(${authUser.id} AS text) = ${adminAction.resourceId}
    LIMIT 1
  )
  ELSE NULL
END`;

const stateSummaryFrom = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.hiddenAt === 'string') return 'HIDDEN';
  for (const key of [
    'state',
    'status',
    'questStatus',
    'payoutStatus',
    'topUpStatus',
    'walletStatus',
  ]) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return null;
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

export type AdminActivityPage = {
  items: AdminActivityEntry[];
  nextCursor: Omit<CursorPayload, 'v'> | null;
};

/**
 * Lists the safe columns of immutable Admin Actions. Evidence and request
 * data are intentionally not selected from the database.
 */
export const listAdminActivity = async ({
  action,
  resourceType,
  resourceId,
  adminId,
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminActivityInput = {}): Promise<AdminActivityPage> => {
  const page = await readKeysetPage({
    anchor: { time: adminAction.createdAt, id: adminAction.id },
    cursor,
    limit,
    sort,
    where: and(
      action ? eq(adminAction.action, action) : undefined,
      resourceType ? eq(adminAction.resourceType, resourceType) : undefined,
      resourceId ? eq(adminAction.resourceId, resourceId) : undefined,
      adminId ? eq(adminAction.adminId, adminId) : undefined
    ),
    read: ({ where, orderBy, limit: probe }) =>
      db
        .select({
          id: adminAction.id,
          publicSequence: adminAction.publicSequence,
          admin: {
            id: authAdmin.id,
            firstName: authAdmin.firstName,
            lastName: authAdmin.lastName,
          },
          action: adminAction.action,
          resourceType: adminAction.resourceType,
          resourceId: adminAction.resourceId,
          resourceDisplayId,
          metadata: adminAction.metadata,
          resultData: adminAction.resultData,
          reasonCode: adminAction.reasonCode,
          decisionReasonText: adminAction.decisionReasonText,
          reasonCatalogVersion: adminAction.reasonCatalogVersion,
          resultVersion: adminAction.resultVersion,
          resultTimestamp: adminAction.resultTimestamp,
          createdAt: adminAction.createdAt,
        })
        .from(adminAction)
        .innerJoin(authAdmin, eq(authAdmin.id, adminAction.adminId))
        .where(where)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () =>
      new CursorInputError('INVALID_CURSOR', 'cursor does not match an Admin Action'),
  });

  return {
    items: page.rows.map((row) => ({
      id: row.id,
      activityDisplayId: formatActivityDisplayId(row.publicSequence),
      admin: row.admin,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      resourceDisplayId: row.resourceDisplayId,
      beforeState: stateSummaryFrom(row.metadata),
      afterState: stateSummaryFrom(row.resultData),
      reasonCode: row.reasonCode,
      decisionReasonText: row.decisionReasonText,
      reasonCatalogVersion: row.reasonCatalogVersion,
      resultVersion: row.resultVersion,
      resultTimestamp: row.resultTimestamp,
      createdAt: row.createdAt,
    })),
    nextCursor: page.nextCursor,
  };
};

export const serializeAdminActivityEntry = (entry: AdminActivityEntry) => ({
  activityDisplayId: entry.activityDisplayId,
  admin: {
    firstName: entry.admin.firstName,
    lastName: entry.admin.lastName,
  },
  action: entry.action,
  resourceType: entry.resourceType,
  resourceDisplayId: entry.resourceDisplayId,
  beforeState: entry.beforeState,
  afterState: entry.afterState,
  reasonCode: entry.reasonCode,
  decisionReasonText: entry.decisionReasonText,
  reasonCatalogVersion: entry.reasonCatalogVersion,
  resultVersion: entry.resultVersion,
  resultTimestamp: entry.resultTimestamp ? entry.resultTimestamp.toISOString() : null,
  createdAt: entry.createdAt.toISOString(),
});
